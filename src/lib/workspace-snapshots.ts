import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { env } from "../config/env.js";
import { attachmentUploadRoot } from "./attachments.js";
import {
  importUserDataBackup,
  prepareUserDataBackup,
  readUserDataBackupManifest,
  writeUserDataBackup,
  type DataRestoreAuthScope
} from "./data-transfer.js";
import { assertCurrentAuthSessionBoundary, type AuthSessionBoundaryScope } from "./auth-sessions.js";
import { db, transaction, type DbClient } from "./db.js";
import { ApiError } from "./http.js";
import { createId } from "./id.js";
import { diffWorkspaceManifests } from "./workspace-snapshot-diff.js";

const snapshotIdPattern = /^snapshot_[a-f0-9]{32}$/;
const snapshotStorageRoot = path.join(attachmentUploadRoot, ".workspace-snapshots");
const maxSnapshotStorageBytes = BigInt(env.SNAPSHOT_STORAGE_MAX_MB) * 1024n * 1024n;

type SnapshotRow = {
  id: string;
  user_id: string;
  archive_size: string | number | bigint;
  archive_sha256: string;
  page_count: number;
  block_count: number;
  attachment_count: number;
  page_version_count: number;
  created_at: string;
};


function safeSnapshotId(snapshotId: string) {
  if (!snapshotIdPattern.test(snapshotId)) {
    throw new ApiError(404, "SNAPSHOT_NOT_FOUND", "Snapshot not found");
  }
  return snapshotId;
}

function userStorageKey(userId: string) {
  return createHash("sha256").update(userId, "utf8").digest("hex");
}

function snapshotUserDirectory(userId: string) {
  return path.join(snapshotStorageRoot, userStorageKey(userId));
}

function snapshotArchivePath(userId: string, snapshotId: string) {
  return path.join(snapshotUserDirectory(userId), `${safeSnapshotId(snapshotId)}.zip`);
}

async function syncPath(targetPath: string) {
  const handle = await open(targetPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureSnapshotUserDirectory(userId: string) {
  await mkdir(snapshotStorageRoot, { recursive: true, mode: 0o700 });
  await syncPath(attachmentUploadRoot);
  const directory = snapshotUserDirectory(userId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await syncPath(snapshotStorageRoot);
  return directory;
}

async function inspectArchive(filePath: string) {
  const hash = createHash("sha256");
  let size = 0n;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    size += BigInt(buffer.length);
  }
  return { size, sha256: hash.digest("hex") };
}

function toSnapshotInfo(row: SnapshotRow, integrity: "ok" | "missing" | "size-mismatch" = "ok") {
  return {
    id: row.id,
    createdAt: row.created_at,
    archiveSize: String(row.archive_size),
    archiveSha256: row.archive_sha256,
    pages: Number(row.page_count),
    blocks: Number(row.block_count),
    attachments: Number(row.attachment_count),
    pageVersions: Number(row.page_version_count),
    integrity
  };
}

async function getOwnedSnapshotRow(userId: string, snapshotId: string, client: DbClient = db, lock = false) {
  const id = safeSnapshotId(snapshotId);
  const row = await client.queryOne<SnapshotRow>(
    `SELECT id, user_id, archive_size, archive_sha256, page_count, block_count,
            attachment_count, page_version_count,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
     FROM workspace_snapshots
     WHERE id = ? AND user_id = ?${lock ? " FOR UPDATE" : ""}`,
    [id, userId]
  );
  if (!row) throw new ApiError(404, "SNAPSHOT_NOT_FOUND", "Snapshot not found");
  return row;
}

async function ensureSnapshotArchiveIntegrity(userId: string, row: SnapshotRow) {
  const filePath = snapshotArchivePath(userId, row.id);
  let fileInfo;
  try {
    fileInfo = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ApiError(409, "SNAPSHOT_INTEGRITY_FAILED", "Snapshot archive is missing");
    }
    throw error;
  }
  if (!fileInfo.isFile() || BigInt(fileInfo.size) !== BigInt(row.archive_size)) {
    throw new ApiError(409, "SNAPSHOT_INTEGRITY_FAILED", "Snapshot archive size does not match its metadata");
  }
  const inspection = await inspectArchive(filePath);
  if (inspection.size !== BigInt(row.archive_size) || inspection.sha256 !== row.archive_sha256) {
    throw new ApiError(409, "SNAPSHOT_INTEGRITY_FAILED", "Snapshot archive integrity check failed");
  }
  return filePath;
}

async function writeSnapshotArchive(userId: string, snapshotId: string) {
  const directory = await ensureSnapshotUserDirectory(userId);
  const plan = await prepareUserDataBackup(userId);
  const finalPath = snapshotArchivePath(userId, snapshotId);
  const temporaryPath = path.join(directory, `.${snapshotId}.${createId("tmp")}.zip`);
  let output: ReturnType<typeof createWriteStream> | null = null;
  let backupWriterInvoked = false;

  try {
    const stream = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
    output = stream;
    backupWriterInvoked = true;
    await writeUserDataBackup(plan, stream);
    stream.end();
    await finished(stream);
    await syncPath(temporaryPath);
    const inspection = await inspectArchive(temporaryPath);
    if (inspection.size !== plan.archiveSize) {
      throw new ApiError(500, "SNAPSHOT_WRITE_FAILED", "Snapshot archive length verification failed");
    }
    await rename(temporaryPath, finalPath);
    await syncPath(directory);
    return {
      finalPath,
      inspection,
      counts: {
        pages: plan.manifest.data.pages.length,
        blocks: plan.manifest.data.blocks.length,
        attachments: plan.manifest.attachments.length + (plan.manifest.retainedAttachments?.length ?? 0),
        pageVersions: plan.manifest.data.pageVersions?.length ?? 0
      }
    };
  } catch (error) {
    output?.destroy();
    if (!backupWriterInvoked) {
      await rm(plan.operationRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function listWorkspaceSnapshots(userId: string) {
  const rows = await db.query<SnapshotRow>(
    `SELECT id, user_id, archive_size, archive_sha256, page_count, block_count,
            attachment_count, page_version_count,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
     FROM workspace_snapshots
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC`,
    [userId]
  );

  return Promise.all(rows.map(async (row) => {
    const filePath = snapshotArchivePath(userId, row.id);
    try {
      const fileInfo = await lstat(filePath);
      const integrity = fileInfo.isFile() && BigInt(fileInfo.size) === BigInt(row.archive_size)
        ? "ok"
        : "size-mismatch";
      return toSnapshotInfo(row, integrity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return toSnapshotInfo(row, "missing");
      throw error;
    }
  }));
}

export async function createWorkspaceSnapshot(
  userId: string,
  authScope: AuthSessionBoundaryScope
) {
  const snapshotId = createId("snapshot");
  const { finalPath, inspection, counts } = await writeSnapshotArchive(userId, snapshotId);

  try {
    await transaction(async (client) => {
      // Snapshot creation can spend substantial time streaming a workspace archive.
      // Revalidate the exact credential/device session at the durable insertion
      // boundary so a request admitted before revocation cannot persist recovery data.
      await assertCurrentAuthSessionBoundary(userId, authScope, client);
      const usage = await client.queryOne<{ snapshot_count: number; snapshot_bytes: string | number | bigint }>(
        `SELECT COUNT(*) AS snapshot_count, COALESCE(SUM(archive_size), 0) AS snapshot_bytes
         FROM workspace_snapshots WHERE user_id = ?`,
        [userId]
      );
      const snapshotCount = Number(usage?.snapshot_count ?? 0);
      const snapshotBytes = BigInt(usage?.snapshot_bytes ?? 0);
      if (snapshotCount >= env.SNAPSHOT_MAX_COUNT) {
        throw new ApiError(409, "SNAPSHOT_LIMIT_REACHED", "Delete an existing snapshot before creating another one");
      }
      if (snapshotBytes + inspection.size > maxSnapshotStorageBytes) {
        throw new ApiError(413, "SNAPSHOT_STORAGE_LIMIT_REACHED", "Snapshot storage quota would be exceeded");
      }
      await client.execute(
        `INSERT INTO workspace_snapshots
           (id, user_id, archive_size, archive_sha256, page_count, block_count, attachment_count, page_version_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshotId,
          userId,
          inspection.size.toString(),
          inspection.sha256,
          counts.pages,
          counts.blocks,
          counts.attachments,
          counts.pageVersions
        ]
      );
    });
  } catch (error) {
    let persisted: SnapshotRow | undefined;
    try {
      persisted = await db.queryOne<SnapshotRow>(
        `SELECT id, user_id, archive_size, archive_sha256, page_count, block_count,
                attachment_count, page_version_count,
                DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
         FROM workspace_snapshots WHERE id = ? AND user_id = ?`,
        [snapshotId, userId]
      );
    } catch (verificationError) {
      console.error("Snapshot creation outcome could not be verified; preserving archive", {
        userId,
        snapshotId,
        finalPath,
        verificationError
      });
      throw new ApiError(
        500,
        "SNAPSHOT_CREATE_OUTCOME_UNKNOWN",
        "Snapshot creation outcome could not be verified. The archive was preserved for recovery."
      );
    }
    if (persisted) return toSnapshotInfo(persisted);
    await rm(finalPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const row = await getOwnedSnapshotRow(userId, snapshotId);
  return toSnapshotInfo(row);
}

export async function deleteWorkspaceSnapshot(
  userId: string,
  snapshotId: string,
  authScope: AuthSessionBoundaryScope
) {
  const id = safeSnapshotId(snapshotId);
  const directory = snapshotUserDirectory(userId);
  const finalPath = snapshotArchivePath(userId, id);
  const tombstonePath = path.join(directory, `.${id}.${createId("delete")}.zip`);
  let moved = false;

  try {
    await transaction(async (client) => {
      // Deleting a snapshot removes a recovery point from both SQL and the
      // filesystem. Bind that destructive transition to the session that
      // initiated it before locking or renaming the snapshot.
      await assertCurrentAuthSessionBoundary(userId, authScope, client);
      await getOwnedSnapshotRow(userId, id, client, true);
      try {
        const fileInfo = await lstat(finalPath);
        if (!fileInfo.isFile()) {
          throw new ApiError(409, "SNAPSHOT_INTEGRITY_FAILED", "Snapshot archive is not a regular file");
        }
        await rename(finalPath, tombstonePath);
        moved = true;
        await syncPath(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await client.execute("DELETE FROM workspace_snapshots WHERE id = ? AND user_id = ?", [id, userId]);
    });
  } catch (error) {
    if (moved) {
      await rename(tombstonePath, finalPath).catch(() => undefined);
      await syncPath(directory).catch(() => undefined);
    }

    let stillExists: { id: string } | undefined;
    try {
      stillExists = await db.queryOne<{ id: string }>(
        "SELECT id FROM workspace_snapshots WHERE id = ? AND user_id = ?",
        [id, userId]
      );
    } catch (verificationError) {
      console.error("Snapshot deletion outcome could not be verified; preserving archive when possible", {
        userId,
        snapshotId: id,
        verificationError
      });
      throw new ApiError(
        500,
        "SNAPSHOT_DELETE_OUTCOME_UNKNOWN",
        "Snapshot deletion outcome could not be verified. Snapshot bytes were preserved when possible."
      );
    }
    if (stillExists) throw error;
    await rm(finalPath, { force: true }).catch(() => undefined);
    await rm(tombstonePath, { force: true }).catch(() => undefined);
    return { deleted: true };
  }

  await rm(tombstonePath, { force: true }).catch(() => undefined);
  return { deleted: true };
}

export async function restoreWorkspaceSnapshot(
  userId: string,
  snapshotId: string,
  authScope: DataRestoreAuthScope
) {
  const row = await getOwnedSnapshotRow(userId, snapshotId);
  const filePath = await ensureSnapshotArchiveIntegrity(userId, row);
  return importUserDataBackup(userId, filePath, authScope);
}

export async function diffWorkspaceSnapshot(userId: string, snapshotId: string) {
  const row = await getOwnedSnapshotRow(userId, snapshotId);
  const filePath = await ensureSnapshotArchiveIntegrity(userId, row);
  const currentPlan = await prepareUserDataBackup(userId);
  try {
    const manifest = await readUserDataBackupManifest(filePath);
    return diffWorkspaceManifests(manifest, currentPlan.manifest);
  } finally {
    await rm(currentPlan.operationRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
