import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { syncPath } from "./storage-sync.js";
import { env } from "../config/env.js";
import { attachmentUploadRoot } from "./attachments.js";
import {
  admitDataRestore,
  importUserDataBackup,
  prepareUserDataBackup,
  readUserDataBackupManifest,
  replayCompletedDataRestore,
  writeUserDataBackup,
  type DataRestoreAuthScope
} from "./data-transfer.js";
import { assertCurrentAuthSessionBoundary, type AuthSessionBoundaryScope } from "./auth-sessions.js";
import { db, transaction, TransactionCommitOutcomeUnknownError, type DbClient } from "./db.js";
import { ApiError } from "./http.js";
import { createId } from "./id.js";
import { diffWorkspaceManifests } from "./workspace-snapshot-diff.js";
import { selectAutomaticSnapshotsToPrune } from "./automatic-snapshot-retention.js";

const snapshotIdPattern = /^snapshot_[a-f0-9]{32}$/;
const snapshotStorageRoot = path.join(attachmentUploadRoot, ".workspace-snapshots");
const snapshotDataTransferOptions = Object.freeze({ enforceConfiguredSizeLimits: false });
const maxSnapshotArchiveBytes = BigInt(env.SNAPSHOT_MAX_ARCHIVE_MB) * 1024n * 1024n;
const maxSnapshotStorageBytes = BigInt(env.SNAPSHOT_TOTAL_MAX_MB) * 1024n * 1024n;

async function assertSnapshotCapacity(userId: string, client: DbClient, additionalBytes = 0n) {
  // Call only after assertCurrentAuthSessionBoundary has locked the users row.
  // That user lock serializes create/delete quota decisions across callers.
  const usage = await client.queryOne<{ snapshot_count: number; total_bytes: string | number | bigint }>(
    `SELECT COUNT(*) AS snapshot_count, COALESCE(SUM(archive_size), 0) AS total_bytes
     FROM workspace_snapshots WHERE user_id = ? AND kind = 'MANUAL'`,
    [userId]
  );
  const snapshotCount = Number(usage?.snapshot_count ?? 0);
  if (snapshotCount >= env.SNAPSHOT_MAX_COUNT) {
    throw new ApiError(409, "SNAPSHOT_LIMIT_REACHED", "Delete an existing snapshot before creating another one");
  }
  const remainingBytes = maxSnapshotStorageBytes - BigInt(usage?.total_bytes ?? 0);
  if (remainingBytes <= 0n || additionalBytes > remainingBytes) {
    throw new ApiError(409, "SNAPSHOT_STORAGE_LIMIT_REACHED", "Delete an existing snapshot to free snapshot storage");
  }
  return remainingBytes;
}

type SnapshotKind = "MANUAL" | "PRE_RESTORE";

type SnapshotRow = {
  id: string;
  user_id: string;
  kind?: SnapshotKind | null;
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
    kind: row.kind === "PRE_RESTORE" ? "pre-restore" : "manual",
    integrity
  };
}

async function getOwnedSnapshotRow(userId: string, snapshotId: string, client: DbClient = db, lock = false) {
  const id = safeSnapshotId(snapshotId);
  const row = await client.queryOne<SnapshotRow>(
    `SELECT id, user_id, kind, archive_size, archive_sha256, page_count, block_count,
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

async function writeSnapshotArchive(userId: string, snapshotId: string, remainingBytes: bigint) {
  const directory = await ensureSnapshotUserDirectory(userId);
  const plan = await prepareUserDataBackup(userId, {
    maxArchiveBytes: remainingBytes < maxSnapshotArchiveBytes ? remainingBytes : maxSnapshotArchiveBytes,
    maxManifestBytes: env.SNAPSHOT_MAX_MANIFEST_MB * 1024 * 1024
  });
  const finalPath = snapshotArchivePath(userId, snapshotId);
  const temporaryPath = path.join(directory, `.${snapshotId}.${createId("tmp")}.zip`);
  let output: ReturnType<typeof createWriteStream> | null = null;
  let backupWriterInvoked = false;
  let archiveRenamed = false;

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
    archiveRenamed = true;
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
    // No metadata insertion has begun yet. A directory-sync failure after the
    // rename must not leave an unaccounted archive outside the user's quota.
    if (archiveRenamed) await rm(finalPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function listWorkspaceSnapshots(userId: string) {
  const rows = await db.query<SnapshotRow>(
    `SELECT id, user_id, kind, archive_size, archive_sha256, page_count, block_count,
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
  authScope: AuthSessionBoundaryScope,
  kind: SnapshotKind = "MANUAL"
) {
  // Reject full accounts before staging/copying any workspace files. The HTTP
  // export gate permits one operation per user; the final locked recheck also
  // covers direct callers and quota changes during archive preparation.
  // Automatic pre-restore snapshots are bounded by SNAPSHOT_AUTO_MAX_COUNT
  // instead, so a full manual quota never blocks the safety copy.
  const remainingBytes = await transaction(async (client) => {
    await assertCurrentAuthSessionBoundary(userId, authScope, client);
    return kind === "MANUAL" ? assertSnapshotCapacity(userId, client) : maxSnapshotArchiveBytes;
  });
  const snapshotId = createId("snapshot");
  const { finalPath, inspection, counts } = await writeSnapshotArchive(userId, snapshotId, remainingBytes);

  try {
    await transaction(async (client) => {
      // Snapshot creation can spend substantial time streaming a workspace archive.
      // Revalidate the exact credential/device session at the durable insertion
      // boundary so a request admitted before revocation cannot persist recovery data.
      await assertCurrentAuthSessionBoundary(userId, authScope, client);
      if (kind === "MANUAL") await assertSnapshotCapacity(userId, client, inspection.size);
      await client.execute(
        `INSERT INTO workspace_snapshots
           (id, user_id, archive_size, archive_sha256, page_count, block_count, attachment_count, page_version_count, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshotId,
          userId,
          inspection.size.toString(),
          inspection.sha256,
          counts.pages,
          counts.blocks,
          counts.attachments,
          counts.pageVersions,
          kind
        ]
      );
    });
  } catch (error) {
    let persisted: SnapshotRow | undefined;
    try {
      persisted = await db.queryOne<SnapshotRow>(
        `SELECT id, user_id, kind, archive_size, archive_sha256, page_count, block_count,
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

export const restoreSafetySnapshotSkipHeader = "X-Restore-Skip-Safety-Snapshot";

export function wantsRestoreWithoutSafetySnapshot(headerValue: string | undefined) {
  return headerValue === "1";
}

/**
 * Saves the workspace as it is right now, just before a restore or backup
 * import replaces it, so replacing the wrong workspace can itself be undone.
 * Old automatic snapshots are pruned only after the restore succeeded (see
 * pruneAutomaticSnapshots), so a failed restore never costs a recovery point.
 *
 * Any failure stops the restore with RESTORE_SAFETY_SNAPSHOT_FAILED. The person
 * can then choose to restore without the safety copy.
 */
export async function createPreRestoreSafetySnapshot(
  userId: string,
  authScope: AuthSessionBoundaryScope
) {
  let created;
  try {
    created = await createWorkspaceSnapshot(userId, authScope, "PRE_RESTORE");
  } catch (error) {
    // A revoked or expired session is not a storage problem; keep its answer.
    if (error instanceof ApiError && (error.statusCode === 401 || error.statusCode === 403)) throw error;
    console.error("Pre-restore safety snapshot failed; the restore was not started", { userId, error });
    throw new ApiError(
      409,
      "RESTORE_SAFETY_SNAPSHOT_FAILED",
      "The current workspace could not be saved as a snapshot before restoring. Nothing was replaced."
    );
  }

  return created;
}

/**
 * A committed restore advances the workspace generation, so the request's own
 * scope no longer passes the session boundary. Pruning happens after that
 * commit and must act under the generation the restore produced.
 */
export function authScopeAfterRestore<T extends AuthSessionBoundaryScope>(
  authScope: T,
  user: { attachment_generation?: number | bigint | string | null } | null | undefined
): T {
  const generation = Number(user?.attachment_generation ?? authScope.workspaceGeneration);
  return Number.isSafeInteger(generation) && generation >= 1
    ? { ...authScope, workspaceGeneration: generation }
    : authScope;
}

/**
 * Keeps the newest SNAPSHOT_AUTO_MAX_COUNT automatic snapshots plus every one
 * younger than SNAPSHOT_AUTO_RETENTION_HOURS (see
 * selectAutomaticSnapshotsToPrune). Pruning never fails the caller.
 */
export async function pruneAutomaticSnapshots(
  userId: string,
  authScope: AuthSessionBoundaryScope,
  keepIds: Array<string | null | undefined> = []
) {
  const keep = keepIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  try {
    const rows = await db.query<{ id: string; recent: number | null }>(
      `SELECT id, (created_at >= CURRENT_TIMESTAMP(3) - INTERVAL ? HOUR) AS recent
       FROM workspace_snapshots
       WHERE user_id = ? AND kind = 'PRE_RESTORE'
       ORDER BY created_at DESC, id DESC`,
      [env.SNAPSHOT_AUTO_RETENTION_HOURS, userId]
    );
    const pruneIds = selectAutomaticSnapshotsToPrune(rows, keep, {
      maxCount: env.SNAPSHOT_AUTO_MAX_COUNT
    });
    for (const snapshotId of pruneIds) {
      await deleteWorkspaceSnapshot(userId, snapshotId, authScope).catch((error) => {
        console.error("Old automatic snapshot could not be pruned; keeping it", { userId, snapshotId, error });
      });
    }
  } catch (error) {
    // Keeping one more snapshot than configured is harmless.
    console.error("Automatic snapshot pruning failed; keeping every snapshot", { userId, error });
  }
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

  try {
    await transaction(async (client) => {
      // A snapshot is a recovery point. Do not move or remove its only archive
      // until the SQL deletion is durably committed: a process crash before
      // commit must leave both the row and canonical archive intact.
      await assertCurrentAuthSessionBoundary(userId, authScope, client);
      await getOwnedSnapshotRow(userId, id, client, true);
      try {
        const fileInfo = await lstat(finalPath);
        if (!fileInfo.isFile()) {
          throw new ApiError(409, "SNAPSHOT_INTEGRITY_FAILED", "Snapshot archive is not a regular file");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await client.execute("DELETE FROM workspace_snapshots WHERE id = ? AND user_id = ?", [id, userId]);
    });
  } catch (error) {
    // Only a COMMIT failure can mean our authorized deletion already succeeded.
    // Missing/foreign rows, revoked sessions and rollback errors must propagate.
    if (!(error instanceof TransactionCommitOutcomeUnknownError)) throw error;
    let stillExists: { id: string } | undefined;
    try {
      stillExists = await db.queryOne<{ id: string }>(
        "SELECT id FROM workspace_snapshots WHERE id = ? AND user_id = ?",
        [id, userId]
      );
    } catch (verificationError) {
      console.error("Snapshot deletion outcome could not be verified; preserving archive", {
        userId,
        snapshotId: id,
        verificationError
      });
      throw new ApiError(
        500,
        "SNAPSHOT_DELETE_OUTCOME_UNKNOWN",
        "Snapshot deletion outcome could not be verified. The archive was preserved for recovery."
      );
    }
    if (stillExists) throw error;
  }

  // SQL is now known to be absent (either the transaction returned normally or
  // outcome verification proved it committed). Filesystem cleanup is therefore
  // post-commit only. A crash here can leave an orphan file, but cannot strand
  // a live snapshot row whose canonical archive has been renamed away.
  try {
    await rename(finalPath, tombstonePath);
    await syncPath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Snapshot archive cleanup could not be staged after SQL deletion; preserving bytes", {
        userId,
        snapshotId: id,
        error
      });
      return { deleted: true };
    }
  }
  await rm(tombstonePath, { force: true }).catch((error) => {
    console.error("Snapshot tombstone cleanup failed after SQL deletion; preserving bytes", {
      userId,
      snapshotId: id,
      error
    });
  });
  return { deleted: true };
}

export async function restoreWorkspaceSnapshot(
  userId: string,
  snapshotId: string,
  authScope: DataRestoreAuthScope,
  operationId = createId("restore"),
  { safetySnapshot = true }: { safetySnapshot?: boolean } = {}
) {
  const id = safeSnapshotId(snapshotId);
  const admission = await admitDataRestore(userId, authScope, operationId, `snapshot:${id}`);
  const completed = await replayCompletedDataRestore(userId, authScope, admission);
  if (completed) return completed;
  const row = await getOwnedSnapshotRow(userId, snapshotId);
  const filePath = await ensureSnapshotArchiveIntegrity(userId, row);
  let safetyCopy: Awaited<ReturnType<typeof createPreRestoreSafetySnapshot>> | null = null;
  const result = await importUserDataBackup(userId, filePath, authScope, async (client) => {
    let current: SnapshotRow;
    try {
      // Keep the source row locked through the destructive restore transaction.
      // A concurrent delete either commits first (and this restore is rejected)
      // or waits until this already-admitted restore has committed.
      current = await getOwnedSnapshotRow(userId, row.id, client, true);
    } catch (error) {
      if (error instanceof ApiError && error.code === "SNAPSHOT_NOT_FOUND") {
        throw new ApiError(
          409,
          "SNAPSHOT_RESTORE_CONFLICT",
          "The snapshot was deleted while the restore was being prepared. No data was replaced."
        );
      }
      throw error;
    }

    if (
      BigInt(current.archive_size) !== BigInt(row.archive_size)
      || current.archive_sha256 !== row.archive_sha256
    ) {
      throw new ApiError(
        409,
        "SNAPSHOT_RESTORE_CONFLICT",
        "The snapshot changed while the restore was being prepared. No data was replaced."
      );
    }
  }, {
    ...snapshotDataTransferOptions,
    admission,
    // Runs only when this operation has not committed yet, so a retry never
    // saves the already restored state as the "before" copy.
    beforeReplace: safetySnapshot
      ? async () => { safetyCopy = await createPreRestoreSafetySnapshot(userId, authScope); }
      : undefined
  });
  // Assigned inside the hook; widen it back from the narrowed initializer.
  const safetySnapshotId = (safetyCopy as { id: string } | null)?.id ?? null;
  if (safetySnapshotId) {
    await pruneAutomaticSnapshots(userId, authScopeAfterRestore(authScope, result.user), [safetySnapshotId, row.id]);
  }
  return { ...result, safetySnapshotId };
}

export async function diffWorkspaceSnapshot(userId: string, snapshotId: string) {
  const row = await getOwnedSnapshotRow(userId, snapshotId);
  const filePath = await ensureSnapshotArchiveIntegrity(userId, row);
  const currentPlan = await prepareUserDataBackup(userId, snapshotDataTransferOptions);
  try {
    const manifest = await readUserDataBackupManifest(filePath, snapshotDataTransferOptions);
    return diffWorkspaceManifests(manifest, currentPlan.manifest);
  } finally {
    await rm(currentPlan.operationRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
