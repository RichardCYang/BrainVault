import path from "node:path";
import { link, mkdir, open, rm, stat } from "node:fs/promises";
import { env } from "../config/env.js";
import { transaction, type DbClient } from "./db.js";

export {
  getAttachmentInfo,
  normalizeAttachmentMimeType,
  sanitizeAttachmentFilename,
  type AttachmentInfo,
  type AttachmentMetadata
} from "./attachment-metadata-integrity.js";

const projectRoot = path.resolve(process.cwd());
export const attachmentUploadRoot = path.resolve(projectRoot, env.ATTACHMENT_UPLOAD_DIR);
export const attachmentTempDir = path.join(attachmentUploadRoot, ".tmp");

if (attachmentUploadRoot === projectRoot) {
  throw new Error("ATTACHMENT_UPLOAD_DIR cannot be the project root");
}
for (const forbiddenRoot of [path.join(projectRoot, "public"), path.join(projectRoot, "docs"), path.join(projectRoot, ".git")]) {
  if (attachmentUploadRoot === forbiddenRoot || attachmentUploadRoot.startsWith(`${forbiddenRoot}${path.sep}`)) {
    throw new Error("ATTACHMENT_UPLOAD_DIR must stay outside the public, docs, and .git folders");
  }
}

function safeStorageSegment(value: string) {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!normalized) throw new Error("Attachment storage segment is empty");
  return normalized;
}

export function formatAttachmentSize(size: number) {
  const bytes = Number.isFinite(size) && size > 0 ? size : 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export async function ensureAttachmentDirectories() {
  await mkdir(attachmentTempDir, { recursive: true });
}

async function syncPath(value: string) {
  const handle = await open(value, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function getAttachmentFilePath(ownerId: string, blockId: string) {
  return path.join(
    attachmentUploadRoot,
    safeStorageSegment(ownerId),
    safeStorageSegment(blockId)
  );
}

export async function moveAttachmentFile(temporaryPath: string, ownerId: string, blockId: string) {
  const target = getAttachmentFilePath(ownerId, blockId);
  const targetDirectory = path.dirname(target);
  const temporaryDirectory = path.dirname(temporaryPath);
  await mkdir(targetDirectory, { recursive: true });
  let linked = false;
  let sourceRemoved = false;
  try {
    // rename() replaces an existing destination on POSIX. Claim the final path with
    // an exclusive hard link so an ID collision can never overwrite stored bytes.
    await link(temporaryPath, target);
    linked = true;
    await syncPath(target);
    await syncPath(targetDirectory);
    await rm(temporaryPath);
    sourceRemoved = true;
    if (temporaryDirectory !== targetDirectory) await syncPath(temporaryDirectory);
    await syncPath(attachmentUploadRoot);
    return target;
  } catch (error) {
    // Before the temporary name is removed, rolling back the new link restores
    // the original two-copy state. Afterwards the destination is the only live
    // name and must be preserved even when a later directory sync fails.
    if (linked && !sourceRemoved) {
      await rm(target, { force: true }).catch(() => undefined);
      await syncPath(targetDirectory).catch(() => undefined);
    }
    throw error;
  }
}

export async function removeAttachmentPath(filePath: string) {
  await rm(filePath, { force: true }).catch(() => undefined);
}

export async function removeAttachmentFile(ownerId: string, blockId: string) {
  await removeAttachmentPath(getAttachmentFilePath(ownerId, blockId));
}

export async function removeAttachmentFiles(ownerId: string, blockIds: string[]) {
  await Promise.all(blockIds.map((blockId) => removeAttachmentFile(ownerId, blockId)));
}

export async function withUserAttachmentLock<Result>(
  ownerId: string,
  fn: (client: DbClient) => Promise<Result>
) {
  return transaction(async (client) => {
    const user = await client.queryOne<{ id: string }>(
      "SELECT id FROM users WHERE id = ? FOR UPDATE",
      [ownerId]
    );
    if (!user) throw new Error(`Attachment owner does not exist: ${ownerId}`);
    return fn(client);
  });
}

export async function removeDeletedAttachmentFiles(ownerId: string, blockIds: string[]) {
  const uniqueIds = [...new Set(blockIds)];
  if (!uniqueIds.length) return;

  await withUserAttachmentLock(ownerId, async (client) => {
    const existingIds = new Set<string>();
    for (let index = 0; index < uniqueIds.length; index += 500) {
      const group = uniqueIds.slice(index, index + 500);
      const rows = await client.query<{ id: string }>(
        `SELECT b.id
         FROM blocks b INNER JOIN pages p ON p.id = b.page_id
         WHERE p.owner_id = ? AND b.id IN (${group.map(() => "?").join(",")})`,
        [ownerId, ...group]
      );
      for (const row of rows) existingIds.add(row.id);
    }
    await removeAttachmentFiles(ownerId, uniqueIds.filter((id) => !existingIds.has(id)));
  });
}

export async function attachmentFileExists(ownerId: string, blockId: string) {
  try {
    const result = await stat(getAttachmentFilePath(ownerId, blockId));
    return result.isFile();
  } catch {
    return false;
  }
}
