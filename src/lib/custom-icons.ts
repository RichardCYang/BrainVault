import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { withUserAttachmentLock } from "./attachments.js";
import { db } from "./db.js";
import { createId } from "./id.js";
import { ApiError } from "./http.js";
import { imageIconPrefix, maxCustomIconBytes, normalizeIconValue } from "./icon-value.js";

export const customIconLibraryLimit = 36;
export const customIconUploadRoot = path.resolve(process.cwd(), "upload", "icons");
export const customIconPublicPrefix = "/upload/icons/";

const localCustomIconPathPattern = /^\/upload\/icons\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,96}\.(?:png|jpg|webp|ico))$/;

type StoredCustomIconRow = {
  id: string;
  file_path: string;
  last_used_at: Date | string;
};

type CustomIconLibraryRemovalRow = {
  value_hash: string;
};

function normalizeCustomIconLibraryValue(value: string) {
  const normalized = normalizeIconValue(value);
  if (!normalized?.startsWith(imageIconPrefix)) {
    throw new ApiError(400, "INVALID_CUSTOM_ICON", "Only custom image icons can be removed from the custom icon library");
  }
  return normalized;
}

function getCustomIconLibraryRemovalKey(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeStorageSegment(value: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new ApiError(400, "INVALID_CUSTOM_ICON_PATH", "Custom icon storage path is invalid");
  }
  return value;
}

function hasValidIcoStructure(bytes: Buffer) {
  if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return false;
  const imageCount = bytes.readUInt16LE(4);
  const directoryEnd = 6 + imageCount * 16;
  if (!imageCount || directoryEnd > bytes.length) return false;

  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + index * 16;
    const imageSize = bytes.readUInt32LE(entryOffset + 8);
    const imageOffset = bytes.readUInt32LE(entryOffset + 12);
    if (!imageSize || imageOffset < directoryEnd || imageOffset > bytes.length || imageSize > bytes.length - imageOffset) {
      return false;
    }
  }
  return true;
}

export function detectCustomIconFileType(bytes: Buffer) {
  if (!bytes.length || bytes.length > maxCustomIconBytes) return null;
  if (
    bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return { mimeType: "image/png", extension: "png" } as const;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" } as const;
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" } as const;
  }
  if (hasValidIcoStructure(bytes)) return { mimeType: "image/vnd.microsoft.icon", extension: "ico" } as const;
  return null;
}

export function isServerCustomIconPath(value: string) {
  return localCustomIconPathPattern.test(value);
}

export function getCustomIconFilePath(publicPath: string) {
  const match = localCustomIconPathPattern.exec(publicPath);
  if (!match) return null;
  const [, userId, filename] = match;
  return path.join(customIconUploadRoot, safeStorageSegment(userId), filename);
}

function toTimestamp(value: Date | string) {
  if (value instanceof Date) return value.getTime();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export async function listCustomIcons(userId: string) {
  const safeUserId = safeStorageSegment(userId);
  return withUserAttachmentLock(safeUserId, async (client) => {
    const rows = await client.query<StoredCustomIconRow>(
      `SELECT id, file_path, last_used_at
       FROM custom_icons
       WHERE user_id = ?
       ORDER BY last_used_at DESC, created_at DESC
       LIMIT ?`,
      [safeUserId, customIconLibraryLimit]
    );

    const available = [] as Array<{ value: string; lastUsedAt: number }>;
    const missingIds: string[] = [];
    for (const row of rows) {
      const filePath = getCustomIconFilePath(row.file_path);
      if (!filePath) {
        missingIds.push(row.id);
        continue;
      }
      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) throw new Error("not a file");
        available.push({ value: `image:${row.file_path}`, lastUsedAt: toTimestamp(row.last_used_at) });
      } catch {
        missingIds.push(row.id);
      }
    }

    if (missingIds.length) {
      const placeholders = missingIds.map(() => "?").join(", ");
      await client.execute(
        `DELETE FROM custom_icons WHERE user_id = ? AND id IN (${placeholders})`,
        [safeUserId, ...missingIds]
      );
    }

    return available;
  });
}

export async function listCustomIconLibraryRemovalKeys(userId: string) {
  const safeUserId = safeStorageSegment(userId);
  const rows = await db.query<CustomIconLibraryRemovalRow>(
    `SELECT value_hash
     FROM custom_icon_library_removals
     WHERE user_id = ?
     ORDER BY removed_at DESC`,
    [safeUserId]
  );
  return rows.map((row) => row.value_hash);
}

export async function removeCustomIconFromLibrary(userId: string, value: string) {
  const safeUserId = safeStorageSegment(userId);
  const normalized = normalizeCustomIconLibraryValue(value);
  const removedKey = getCustomIconLibraryRemovalKey(normalized);
  const publicPath = normalized.slice(imageIconPrefix.length);

  await withUserAttachmentLock(safeUserId, async (client) => {
    await client.execute(
      `INSERT INTO custom_icon_library_removals (user_id, value_hash, removed_at)
       VALUES (?, ?, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE removed_at = VALUES(removed_at)`,
      [safeUserId, removedKey]
    );

    if (isServerCustomIconPath(publicPath) && publicPath.startsWith(`${customIconPublicPrefix}${safeUserId}/`)) {
      // Removing an icon from the library must not break pages or version history
      // that still reference its immutable upload URL. Keep the file on disk and
      // only remove the library record.
      await client.execute(
        "DELETE FROM custom_icons WHERE user_id = ? AND file_path = ?",
        [safeUserId, publicPath]
      );
    }
  });

  return { value: normalized, removedKey };
}

export async function restoreCustomIconToLibrary(userId: string, value: string) {
  const safeUserId = safeStorageSegment(userId);
  const normalized = normalizeCustomIconLibraryValue(value);
  const removedKey = getCustomIconLibraryRemovalKey(normalized);
  const publicPath = normalized.slice(imageIconPrefix.length);

  await withUserAttachmentLock(safeUserId, async (client) => {
    await client.execute(
      "DELETE FROM custom_icon_library_removals WHERE user_id = ? AND value_hash = ?",
      [safeUserId, removedKey]
    );

    if (!isServerCustomIconPath(publicPath) || !publicPath.startsWith(`${customIconPublicPrefix}${safeUserId}/`)) return;
    const filePath = getCustomIconFilePath(publicPath);
    if (!filePath) return;
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return;
    } catch {
      return;
    }

    const filename = path.basename(publicPath);
    const iconId = safeStorageSegment(filename.slice(0, filename.lastIndexOf(".")));
    await client.execute(
      `INSERT INTO custom_icons (id, user_id, file_path, last_used_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE last_used_at = VALUES(last_used_at)`,
      [iconId, safeUserId, publicPath]
    );
  });
}

export async function rememberCustomIconPaths(userId: string, iconValues: readonly string[]) {
  const safeUserId = safeStorageSegment(userId);
  const paths = [...new Set(iconValues.flatMap((value) => {
    if (typeof value !== "string" || !value.startsWith("image:")) return [];
    const publicPath = value.slice("image:".length).trim();
    return isServerCustomIconPath(publicPath) ? [publicPath] : [];
  }))].slice(0, customIconLibraryLimit);

  await withUserAttachmentLock(safeUserId, async (client) => {
    for (const publicPath of paths) {
      await client.execute(
        `UPDATE custom_icons SET last_used_at = CURRENT_TIMESTAMP(3)
         WHERE user_id = ? AND file_path = ?`,
        [safeUserId, publicPath]
      );
    }
  });
}

export async function storeCustomIcon(userId: string, bytes: Buffer) {
  const safeUserId = safeStorageSegment(userId);
  const fileType = detectCustomIconFileType(bytes);
  if (!fileType) {
    throw new ApiError(415, "INVALID_CUSTOM_ICON_FILE", "Custom icon must be a valid PNG, JPEG, WebP, or ICO image");
  }

  const iconId = createId("cicon");
  const filename = `${iconId}.${fileType.extension}`;
  const ownerDirectory = path.join(customIconUploadRoot, safeUserId);
  const filePath = path.join(ownerDirectory, filename);
  const publicPath = `${customIconPublicPrefix}${safeUserId}/${filename}`;

  return withUserAttachmentLock(safeUserId, async (client) => {
    await mkdir(ownerDirectory, { recursive: true });
    await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
    try {
      await client.execute(
        `INSERT INTO custom_icons (id, user_id, file_path, last_used_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP(3))`,
        [iconId, safeUserId, publicPath]
      );
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      value: `image:${publicPath}`,
      filePath: publicPath,
      mimeType: fileType.mimeType,
      lastUsedAt: Date.now()
    };
  });
}
