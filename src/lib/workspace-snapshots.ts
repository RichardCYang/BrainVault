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
import { automaticSnapshotRecentHardMaxCount, selectAutomaticSnapshotsToPrune } from "./automatic-snapshot-retention.js";
import { BoundedRateLimitStore } from "./bounded-rate-limit-store.js";

const snapshotIdPattern = /^snapshot_[a-f0-9]{32}$/;
const snapshotStorageRoot = path.join(attachmentUploadRoot, ".workspace-snapshots");
const snapshotDataTransferOptions = Object.freeze({ enforceConfiguredSizeLimits: false });
const maxSnapshotArchiveBytes = BigInt(env.SNAPSHOT_MAX_ARCHIVE_MB) * 1024n * 1024n;
const maxSnapshotStorageBytes = BigInt(env.SNAPSHOT_TOTAL_MAX_MB) * 1024n * 1024n;
const maxAutomaticSnapshotStorageBytes = BigInt(env.SNAPSHOT_AUTO_TOTAL_MAX_MB) * 1024n * 1024n;
// Keep room for a new safety copy for each kind before post-success pruning.
// Failed operations and delegated deletes must also stop at this hard limit.
const maxAutomaticSnapshotCount = 2 * (automaticSnapshotRecentHardMaxCount + 1);
const activeSnapshotOwners = {
  standard: new Set<string>(),
  ownerSafety: new Set<string>()
};
const automaticSnapshotRateStores = {
  owner: new BoundedRateLimitStore(),
  delegate: new BoundedRateLimitStore()
};
for (const store of Object.values(automaticSnapshotRateStores)) store.init({ windowMs: env.DATA_EXPORT_WINDOW_MS });

async function assertSnapshotCapacity(userId: string, client: DbClient, kind: SnapshotKind, additionalBytes = 0n, delegated = false) {
  // Call only after assertCurrentAuthSessionBoundary has locked the users row.
  // That user lock serializes create/delete quota decisions across callers.
  const usage = await client.queryOne<{ snapshot_count: number; total_bytes: string | number | bigint }>(
    `SELECT COUNT(*) AS snapshot_count, COALESCE(SUM(archive_size), 0) AS total_bytes
     FROM workspace_snapshots WHERE user_id = ? AND ${kind === "MANUAL" ? "kind = 'MANUAL'" : "kind IN ('PRE_RESTORE', 'PRE_DELETE')"}`,
    [userId]
  );
  const snapshotCount = Number(usage?.snapshot_count ?? 0);
  const maxCount = kind === "MANUAL" ? env.SNAPSHOT_MAX_COUNT : maxAutomaticSnapshotCount;
  if (snapshotCount >= (delegated ? Math.floor(maxCount * 0.75) : maxCount)) {
    throw new ApiError(409, "SNAPSHOT_LIMIT_REACHED", "Delete an existing snapshot before creating another one");
  }
  const maxBytes = kind === "MANUAL" ? maxSnapshotStorageBytes : maxAutomaticSnapshotStorageBytes;
  // Preserve room for a full-size owner archive even when the configured
  // per-archive limit is larger than a quarter of the automatic budget.
  const ownerReserve = maxBytes / 4n > maxSnapshotArchiveBytes ? maxBytes / 4n : maxSnapshotArchiveBytes;
  const delegatedMaxBytes = maxBytes - ownerReserve;
  const remainingBytes = (delegated ? delegatedMaxBytes : maxBytes) - BigInt(usage?.total_bytes ?? 0);
  if (remainingBytes <= 0n || additionalBytes > remainingBytes) {
    throw new ApiError(409, "SNAPSHOT_STORAGE_LIMIT_REACHED", "Delete an existing snapshot to free snapshot storage");
  }
  return remainingBytes;
}

type SnapshotKind = "MANUAL" | "PRE_RESTORE" | "PRE_DELETE";

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
  history_entries_omitted?: number | null;
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
    // Oldest version history entries this snapshot left out to fit its limits.
    historyEntriesOmitted: Number(row.history_entries_omitted ?? 0),
    kind: row.kind === "PRE_RESTORE" ? "pre-restore" : row.kind === "PRE_DELETE" ? "pre-delete" : "manual",
    integrity
  };
}

async function getOwnedSnapshotRow(userId: string, snapshotId: string, client: DbClient = db, lock = false) {
  const id = safeSnapshotId(snapshotId);
  const row = await client.queryOne<SnapshotRow>(
    `SELECT id, user_id, kind, archive_size, archive_sha256, page_count, block_count,
            attachment_count, page_version_count, history_entries_omitted,
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
      },
      historyEntriesOmitted: plan.historyEntriesOmitted
    };
  } catch (error) {
    output?.destroy();
    // destroy() can return while the file is still opening or closing. Wait
    // before unlinking, otherwise a failed writer can leave an untracked ZIP.
    if (output) await finished(output).catch(() => undefined);
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
            attachment_count, page_version_count, history_entries_omitted,
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

/**
 * Who is acting on `userId`'s snapshots. Normally the owner, under their own
 * session. A collection administrator deleting the owner's pages acts under
 * their own session instead: the snapshot still belongs to the owner, who is
 * the one who can restore it.
 */
type SnapshotActor = Readonly<{
  userId: string;
  /** Revalidate the exact destructive operation under the locked users. */
  authorize?: (client: DbClient) => Promise<void>;
}>;

async function assertSnapshotBoundary(
  userId: string,
  authScope: AuthSessionBoundaryScope,
  client: DbClient,
  actor?: SnapshotActor
) {
  if (!actor || actor.userId === userId) {
    await assertCurrentAuthSessionBoundary(userId, authScope, client);
    await actor?.authorize?.(client);
    return;
  }
  // Same deterministic user-lock order as a delegated page deletion.
  const ids = [actor.userId, userId].sort();
  const locked = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE id IN (?, ?) ORDER BY id ASC FOR UPDATE",
    ids
  );
  if (!locked.some((row) => row.id === userId)) throw new ApiError(404, "NOT_FOUND", "Workspace owner not found");
  await assertCurrentAuthSessionBoundary(actor.userId, authScope, client);
  await actor.authorize?.(client);
}

export async function createWorkspaceSnapshot(
  userId: string,
  authScope: AuthSessionBoundaryScope,
  kind: SnapshotKind = "MANUAL",
  actor?: SnapshotActor
) {
  if (actor && actor.userId !== userId && (kind !== "PRE_DELETE" || !actor.authorize)) {
    throw new ApiError(403, "SNAPSHOT_OWNER_REQUIRED", "Only an authorized page deletion can create a delegated safety snapshot");
  }
  // Hold admission until the actual writer settles, including after an HTTP
  // disconnect. Different delegates cannot stage the same owner's files at once.
  const delegated = Boolean(actor && actor.userId !== userId);
  const activeOwners = kind === "MANUAL" || delegated ? activeSnapshotOwners.standard : activeSnapshotOwners.ownerSafety;
  if (activeOwners.has(userId) || (delegated && activeSnapshotOwners.ownerSafety.has(userId))) {
    throw new ApiError(429, "DATA_EXPORT_IN_PROGRESS", "Another snapshot is already active for this workspace");
  }
  if (activeOwners.size > 0) {
    throw new ApiError(503, "DATA_EXPORT_BUSY", "The server is already creating the maximum number of snapshots");
  }
  activeOwners.add(userId);
  try {
    return await createAdmittedWorkspaceSnapshot(userId, authScope, kind, actor);
  } finally {
    activeOwners.delete(userId);
  }
}

async function createAdmittedWorkspaceSnapshot(
  userId: string,
  authScope: AuthSessionBoundaryScope,
  kind: SnapshotKind,
  actor?: SnapshotActor
) {
  // Reject full accounts before staging/copying any workspace files. The HTTP
  // export gate permits one operation per user; the final locked recheck also
  // covers direct callers and quota changes during archive preparation.
  // Automatic snapshots have their own bounded quota, so a full manual quota
  // never consumes the storage reserved for a safety copy.
  const remainingBytes = await transaction(async (client) => {
    await assertSnapshotBoundary(userId, authScope, client, actor);
    return assertSnapshotCapacity(userId, client, kind, 0n, Boolean(actor && actor.userId !== userId));
  });
  // Charge the actor only after authorization, and only for work that actually
  // creates an automatic archive. Plain deletes and receipt replays stay cheap.
  if (kind !== "MANUAL") {
    const isDelegated = actor && actor.userId !== userId;
    const store = isDelegated ? automaticSnapshotRateStores.delegate : automaticSnapshotRateStores.owner;
    const rate = await store.increment(isDelegated ? actor.userId : userId);
    if (rate.totalHits > env.DATA_EXPORT_MAX) {
      throw new ApiError(429, "DATA_EXPORT_RATE_LIMITED", "Too many safety snapshot requests. Try again later.");
    }
  }
  const snapshotId = createId("snapshot");
  const { finalPath, inspection, counts, historyEntriesOmitted } = await writeSnapshotArchive(userId, snapshotId, remainingBytes);

  try {
    await transaction(async (client) => {
      // Snapshot creation can spend substantial time streaming a workspace archive.
      // Revalidate the exact credential/device session at the durable insertion
      // boundary so a request admitted before revocation cannot persist recovery data.
      await assertSnapshotBoundary(userId, authScope, client, actor);
      await assertSnapshotCapacity(userId, client, kind, inspection.size, Boolean(actor && actor.userId !== userId));
      await client.execute(
        `INSERT INTO workspace_snapshots
           (id, user_id, archive_size, archive_sha256, page_count, block_count, attachment_count, page_version_count,
            history_entries_omitted, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshotId,
          userId,
          inspection.size.toString(),
          inspection.sha256,
          counts.pages,
          counts.blocks,
          counts.attachments,
          counts.pageVersions,
          historyEntriesOmitted,
          kind
        ]
      );
    });
  } catch (error) {
    let persisted: SnapshotRow | undefined;
    try {
      persisted = await db.queryOne<SnapshotRow>(
        `SELECT id, user_id, kind, archive_size, archive_sha256, page_count, block_count,
                attachment_count, page_version_count, history_entries_omitted,
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

/**
 * A workspace past what one backup holds can never get a safety copy, and the
 * person should hear that (and what to do) instead of a generic failure.
 */
function safetySnapshotFailureDetails(error: unknown) {
  return error instanceof ApiError && error.statusCode === 413
    ? { reason: "WORKSPACE_TOO_LARGE" }
    : undefined;
}

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
    if (error instanceof ApiError && [401, 403, 429, 503].includes(error.statusCode)) throw error;
    console.error("Pre-restore safety snapshot failed; the restore was not started", { userId, error });
    throw new ApiError(
      409,
      "RESTORE_SAFETY_SNAPSHOT_FAILED",
      "The current workspace could not be saved as a snapshot before restoring. Nothing was replaced.",
      safetySnapshotFailureDetails(error)
    );
  }

  return created;
}

export const deleteSafetySnapshotSkipHeader = "X-Delete-Skip-Safety-Snapshot";
/** Response header naming the snapshot saved before a permanent deletion. */
export const deleteSafetySnapshotIdHeader = "X-Delete-Safety-Snapshot-Id";
/** Set instead when the snapshot was saved in the page owner's workspace. */
export const deleteSafetySnapshotOwnerHeader = "X-Delete-Safety-Snapshot-Owner";

/**
 * Saves the owner's workspace before a collection/subtree permanent deletion
 * or any delegated permanent deletion, including a single ordinary page.
 * Only owner deletions may prune old automatic snapshots after success.
 *
 * Failure stops deletion; backup failures use DELETE_SAFETY_SNAPSHOT_FAILED.
 * Only the owner can choose to delete without the safety copy.
 */
export async function createPreDeleteSafetySnapshot(
  userId: string,
  authScope: AuthSessionBoundaryScope,
  actor?: SnapshotActor
) {
  try {
    // `userId` is the workspace owner. When a collection administrator deletes
    // the owner's pages, `actor` is that administrator: the copy is still the
    // owner's, so the owner can undo a deletion someone else made.
    return await createWorkspaceSnapshot(userId, authScope, "PRE_DELETE", actor);
  } catch (error) {
    if (error instanceof ApiError && ([401, 403, 404, 429, 503].includes(error.statusCode)
      || ["PAGE_EDIT_CONFLICT", "PAGE_OWNER_CHANGED"].includes(error.code))) throw error;
    console.error("Pre-delete safety snapshot failed; the deletion was not started", { userId, error });
    throw new ApiError(
      409,
      "DELETE_SAFETY_SNAPSHOT_FAILED",
      "The workspace could not be saved as a snapshot before deleting. Nothing was deleted.",
      safetySnapshotFailureDetails(error)
    );
  }
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
 * Keeps, for each kind of automatic snapshot, the newest
 * SNAPSHOT_AUTO_MAX_COUNT plus every one younger than
 * SNAPSHOT_AUTO_RETENTION_HOURS (see selectAutomaticSnapshotsToPrune).
 * Pruning never fails the caller.
 *
 * The kinds are pruned apart: a "Before deletion" snapshot is the only copy of
 * what that deletion removed (a later snapshot was taken after it), so a burst
 * of restores must not push it out, nor the other way round.
 */
export async function pruneAutomaticSnapshots(
  userId: string,
  authScope: AuthSessionBoundaryScope,
  keepIds: Array<string | null | undefined> = [],
  actor?: SnapshotActor
) {
  // Page administration never authorizes workspace-wide recovery deletion.
  if (actor && actor.userId !== userId) return;
  const keep = keepIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  try {
    const rows = await db.query<{ id: string; kind: SnapshotKind; recent: number | null }>(
      `SELECT id, kind, (created_at >= CURRENT_TIMESTAMP(3) - INTERVAL ? HOUR) AS recent
       FROM workspace_snapshots
       WHERE user_id = ? AND kind IN ('PRE_RESTORE', 'PRE_DELETE')
       ORDER BY created_at DESC, id DESC`,
      [env.SNAPSHOT_AUTO_RETENTION_HOURS, userId]
    );
    const pruneIds = (["PRE_RESTORE", "PRE_DELETE"] as const).flatMap((kind) =>
      selectAutomaticSnapshotsToPrune(rows.filter((row) => row.kind === kind), keep, {
        maxCount: env.SNAPSHOT_AUTO_MAX_COUNT
      })
    );
    for (const snapshotId of pruneIds) {
      await deleteWorkspaceSnapshot(userId, snapshotId, authScope, actor).catch((error) => {
        console.error("Old automatic snapshot could not be pruned; keeping it", { userId, snapshotId, error });
      });
    }
  } catch (error) {
    // Creation's hard quota also bounds snapshots left by failed pruning.
    console.error("Automatic snapshot pruning failed; keeping every snapshot", { userId, error });
  }
}

export async function deleteWorkspaceSnapshot(
  userId: string,
  snapshotId: string,
  authScope: AuthSessionBoundaryScope,
  actor?: SnapshotActor
) {
  if (actor && actor.userId !== userId) {
    throw new ApiError(403, "SNAPSHOT_OWNER_REQUIRED", "Only the workspace owner can delete recovery snapshots");
  }
  const id = safeSnapshotId(snapshotId);
  const directory = snapshotUserDirectory(userId);
  const finalPath = snapshotArchivePath(userId, id);
  const tombstonePath = path.join(directory, `.${id}.${createId("delete")}.zip`);

  try {
    await transaction(async (client) => {
      // A snapshot is a recovery point. Do not move or remove its only archive
      // until the SQL deletion is durably committed: a process crash before
      // commit must leave both the row and canonical archive intact.
      await assertSnapshotBoundary(userId, authScope, client, actor);
      const row = await getOwnedSnapshotRow(userId, id, client, true);
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
