import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  root: `${process.cwd()}/uploads/snapshot-report-${process.pid}`,
  query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), auth: vi.fn(),
  prepare: vi.fn(), write: vi.fn(), import: vi.fn(), read: vi.fn(),
  commitError: null, transactionCount: 0, failArchiveDirectorySync: false
}));
vi.mock("../src/lib/db.js", () => ({
  db: mocks, TransactionCommitOutcomeUnknownError: class extends Error {},
  transaction: async (fn) => {
    mocks.transactionCount++;
    const result = await fn(mocks);
    if (mocks.commitError && mocks.transactionCount === 2) throw mocks.commitError;
    return result;
  }
}));
vi.mock("../src/lib/auth-sessions.js", () => ({ assertCurrentAuthSessionBoundary: mocks.auth }));
vi.mock("../src/lib/attachments.js", async (original) => ({
  ...(await original()), attachmentUploadRoot: mocks.root,
  getAttachmentFilePath: (ownerId, blockId) => path.join(mocks.root, ownerId, blockId)
}));
vi.mock("../src/lib/data-transfer.js", () => ({
  admitDataRestore: async (userId, _scope, operationId, sourceKey) => ({ userId, operationId, sourceKey, fingerprint: "fixture" }),
  replayCompletedDataRestore: async () => null,
  prepareUserDataBackup: mocks.prepare, writeUserDataBackup: mocks.write,
  importUserDataBackup: mocks.import, readUserDataBackupManifest: mocks.read
}));
vi.mock("../src/lib/storage-sync.js", async (original) => {
  const storage = await original();
  return { ...storage, syncPath: async (target) => {
    if (mocks.failArchiveDirectorySync && path.resolve(target) === path.resolve(directory)) {
      throw new Error("snapshot directory sync failed");
    }
    return storage.syncPath(target);
  } };
});

import { env } from "../src/config/env.js";
import { BoundedRateLimitStore } from "../src/lib/bounded-rate-limit-store.js";
import { createWorkspaceSnapshot, deleteWorkspaceSnapshot, pruneAutomaticSnapshots, restoreWorkspaceSnapshot } from "../src/lib/workspace-snapshots.js";
const userId = "usr_snapshot_report";
const scope = { authVersion: 1, workspaceGeneration: 1, sessionId: "session_report" };
const bytes = Buffer.from("snapshot test archive");
let row;
let usage;
let finalUsage;
let quotaChecks;
const directory = path.join(mocks.root, ".workspace-snapshots", createHash("sha256").update(userId).digest("hex"));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.commitError = null; mocks.transactionCount = 0; mocks.failArchiveDirectorySync = false;
  row = undefined; usage = { snapshot_count: 0, total_bytes: "0" }; finalUsage = null; quotaChecks = 0;
  mocks.auth.mockReset().mockResolvedValue(undefined);
  mocks.query.mockResolvedValue([]);
  mocks.queryOne.mockImplementation(async (sql) => {
    if (sql.includes("COUNT(*) AS snapshot_count")) {
      expect(mocks.auth).toHaveBeenCalledTimes(++quotaChecks);
      return quotaChecks === 1 ? usage : finalUsage ?? usage;
    }
    if (sql.includes("workspace_snapshots")) return row;
    if (sql.includes("FROM users")) return { id: userId, attachment_generation: 1, username: "snapshot_report",
      name: null, avatar_data: null, preferred_language: null, default_collection_icon: null, theme: "light" };
    return undefined;
  });
  mocks.execute.mockImplementation(async (sql, values) => {
    if (sql.includes("INSERT INTO workspace_snapshots")) row = {
      id: values[0], user_id: values[1], archive_size: values[2], archive_sha256: values[3],
      kind: values[9],
      page_count: 0, block_count: 0, attachment_count: 0, page_version_count: 0, created_at: "2026-11-06"
    };
    if (sql.includes("DELETE FROM workspace_snapshots")) row = undefined;
    return { affectedRows: 1 };
  });
  mocks.prepare.mockImplementation(async () => ({ archiveSize: BigInt(bytes.length), operationRoot: path.join(mocks.root, "staged"),
    manifest: { data: { pages: [], blocks: [] }, attachments: [] } }));
  mocks.write.mockImplementation(async (_plan, output) => { output.write(bytes); });
});
afterEach(async () => { await rm(mocks.root, { recursive: true, force: true }); });

describe("BV-2026-003 snapshot creation", () => {
  it.each(["count", "bytes"])("rejects a full %s quota before staging or writing", async (kind) => {
    usage = kind === "count" ? { snapshot_count: env.SNAPSHOT_MAX_COUNT, total_bytes: "0" }
      : { snapshot_count: 1, total_bytes: String(BigInt(env.SNAPSHOT_TOTAL_MAX_MB) * 1024n * 1024n) };
    await expect(createWorkspaceSnapshot(userId, scope)).rejects.toMatchObject({ code: kind === "count" ? "SNAPSHOT_LIMIT_REACHED" : "SNAPSHOT_STORAGE_LIMIT_REACHED" });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("caps preparation by the smaller of the archive ceiling and remaining total quota", async () => {
    usage.total_bytes = String(BigInt(env.SNAPSHOT_TOTAL_MAX_MB) * 1024n * 1024n - BigInt(bytes.length));
    const result = await createWorkspaceSnapshot(userId, scope);
    expect(mocks.prepare).toHaveBeenCalledWith(userId, { maxArchiveBytes: BigInt(bytes.length), maxManifestBytes: env.SNAPSHOT_MAX_MANIFEST_MB * 1024 * 1024 });
    expect(result.archiveSize).toBe(String(bytes.length));
    expect(quotaChecks).toBe(2);
    expect(await readdir(directory)).toEqual([`${result.id}.zip`]);
  });

  it.each(["count", "bytes"])("rechecks the %s quota after preparation and removes a rejected archive", async (kind) => {
    finalUsage = kind === "count" ? { snapshot_count: env.SNAPSHOT_MAX_COUNT, total_bytes: "0" }
      : { snapshot_count: 1, total_bytes: String(BigInt(env.SNAPSHOT_TOTAL_MAX_MB) * 1024n * 1024n - 1n) };
    await expect(createWorkspaceSnapshot(userId, scope)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects a revoked session before writing and also fences revocation during preparation", async () => {
    mocks.auth.mockRejectedValueOnce(new Error("revoked"));
    await expect(createWorkspaceSnapshot(userId, scope)).rejects.toThrow("revoked");
    expect(mocks.prepare).not.toHaveBeenCalled();
    mocks.auth.mockClear();
    mocks.auth.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked"));
    await expect(createWorkspaceSnapshot(userId, scope)).rejects.toThrow("revoked");
    expect(await readdir(directory)).toEqual([]);
  });

  it("retains a committed archive after an ambiguous commit response", async () => {
    mocks.commitError = new Error("lost commit response");
    const result = await createWorkspaceSnapshot(userId, scope);
    expect(mocks.prepare).toHaveBeenCalledWith(userId, { maxArchiveBytes: BigInt(env.SNAPSHOT_MAX_ARCHIVE_MB) * 1024n * 1024n, maxManifestBytes: env.SNAPSHOT_MAX_MANIFEST_MB * 1024 * 1024 });
    expect(await readdir(directory)).toEqual([`${result.id}.zip`]);
  });

  it("removes an uncommitted archive if syncing its directory fails after rename", async () => {
    mocks.failArchiveDirectorySync = true;
    await expect(createWorkspaceSnapshot(userId, scope)).rejects.toThrow("snapshot directory sync failed");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("deletes recovery metadata before removing its archive", async () => {
    const snapshot = await createWorkspaceSnapshot(userId, scope);
    await deleteWorkspaceSnapshot(userId, snapshot.id, scope);
    expect(row).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not apply creation limits when restoring an existing archive", async () => {
    const snapshot = await createWorkspaceSnapshot(userId, scope);
    await restoreWorkspaceSnapshot(userId, snapshot.id, scope);
    expect(mocks.import).toHaveBeenCalledWith(userId, path.join(directory, `${snapshot.id}.zip`), scope, expect.any(Function),
      {
        enforceConfiguredSizeLimits: false,
        admission: expect.objectContaining({ userId, sourceKey: `snapshot:${snapshot.id}` }),
        // The pre-restore safety snapshot runs inside the import, after validation.
        beforeReplace: expect.any(Function)
      });
  });
});

describe("snapshot report authorization and automatic capacity", () => {
  it.each(["PRE_DELETE", "PRE_RESTORE"])("bounds %s count before copying the workspace", async (kind) => {
    usage.snapshot_count = 42;
    await expect(createWorkspaceSnapshot(userId, scope, kind)).rejects.toMatchObject({ code: "SNAPSHOT_LIMIT_REACHED" });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each(["PRE_DELETE", "PRE_RESTORE"])("bounds %s bytes before copying the workspace", async (kind) => {
    usage.total_bytes = String(BigInt(env.SNAPSHOT_AUTO_TOTAL_MAX_MB) * 1024n * 1024n);
    await expect(createWorkspaceSnapshot(userId, scope, kind)).rejects.toMatchObject({ code: "SNAPSHOT_STORAGE_LIMIT_REACHED" });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("rejects an unscoped delegated creation before preparing an archive", async () => {
    mocks.query.mockResolvedValue([{ id: userId }, { id: "usr_delegate" }]);
    await expect(createWorkspaceSnapshot(userId, scope, "PRE_DELETE", { userId: "usr_delegate" }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(row).toBeUndefined();
  });

  it.each(["PRE_DELETE", "PRE_RESTORE"])("rechecks %s quota at insertion and removes rejected bytes", async (kind) => {
    finalUsage = { snapshot_count: 0, total_bytes: String(BigInt(env.SNAPSHOT_AUTO_TOTAL_MAX_MB) * 1024n * 1024n - 1n) };
    await expect(createWorkspaceSnapshot(userId, scope, kind)).rejects.toMatchObject({ code: "SNAPSHOT_STORAGE_LIMIT_REACHED" });
    expect(row).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it("caps automatic archive preparation by its own remaining storage", async () => {
    usage.total_bytes = String(BigInt(env.SNAPSHOT_AUTO_TOTAL_MAX_MB) * 1024n * 1024n - BigInt(bytes.length));
    await createWorkspaceSnapshot(userId, scope, "PRE_DELETE");
    expect(mocks.prepare).toHaveBeenCalledWith(userId, expect.objectContaining({ maxArchiveBytes: BigInt(bytes.length) }));
    const quotaQueries = mocks.queryOne.mock.calls.filter(([sql]) => sql.includes("COUNT(*) AS snapshot_count"));
    expect(quotaQueries).toHaveLength(2);
    for (const [sql] of quotaQueries) expect(sql).toContain("kind IN ('PRE_RESTORE', 'PRE_DELETE')");
  });

  it("rate-limits the delegated actor before streaming", async () => {
    mocks.query.mockResolvedValue([{ id: userId }, { id: "usr_delegate" }]);
    const increment = vi.spyOn(BoundedRateLimitStore.prototype, "increment")
      .mockResolvedValueOnce({ totalHits: env.DATA_EXPORT_MAX + 1 });
    try {
      await expect(createWorkspaceSnapshot(userId, scope, "PRE_DELETE", { userId: "usr_delegate", authorize: async () => {} }))
        .rejects.toMatchObject({ statusCode: 429, code: "DATA_EXPORT_RATE_LIMITED" });
      expect(increment).toHaveBeenCalledWith("usr_delegate");
      expect(mocks.prepare).not.toHaveBeenCalled();
    } finally { increment.mockRestore(); }
  });

  it("retains the workspace admission slot until streaming finishes, across different delegates", async () => {
    let release;
    let entered;
    const waiting = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const prepare = mocks.prepare.getMockImplementation();
    mocks.prepare.mockImplementationOnce(async (...args) => { entered(); await waiting; return prepare(...args); });
    const first = createWorkspaceSnapshot(userId, scope, "PRE_DELETE");
    await started;
    try {
      await expect(createWorkspaceSnapshot(userId, scope, "PRE_DELETE", { userId: "usr_other_delegate", authorize: async () => {} }))
        .rejects.toMatchObject({ statusCode: 429, code: "DATA_EXPORT_IN_PROGRESS" });
      expect(mocks.prepare).toHaveBeenCalledTimes(1);
    } finally { release(); await first; }
    // A completed request releases admission for the next actual writer.
    mocks.auth.mockClear(); quotaChecks = 0;
    await createWorkspaceSnapshot(userId, scope, "PRE_DELETE");
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
  });

  it("reserves owner safety capacity while a manual snapshot is active", async () => {
    let release;
    let entered;
    const waiting = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const prepare = mocks.prepare.getMockImplementation();
    mocks.prepare.mockImplementationOnce(async (...args) => { entered(); await waiting; return prepare(...args); });
    const manual = createWorkspaceSnapshot(userId, scope, "MANUAL");
    await started;
    try {
      await expect(createWorkspaceSnapshot(`${userId}_other`, scope, "MANUAL"))
        .rejects.toMatchObject({ statusCode: 503, code: "DATA_EXPORT_BUSY" });
      await expect(createWorkspaceSnapshot(`${userId}_recovery`, scope, "PRE_DELETE"))
        .resolves.toMatchObject({ kind: "pre-delete" });
      expect(mocks.prepare).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await manual;
    }
  });

  it("rechecks delegated page authorization after streaming and removes the rejected ZIP", async () => {
    mocks.query.mockResolvedValue([{ id: userId }, { id: "usr_delegate" }]);
    const authorize = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("grant revoked"));
    await expect(createWorkspaceSnapshot(userId, scope, "PRE_DELETE", { userId: "usr_delegate", authorize }))
      .rejects.toThrow("grant revoked");
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(row).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["MANUAL", "PRE_DELETE", "PRE_RESTORE"])("a delegate cannot remove a %s row or archive", async (kind) => {
    const snapshot = await createWorkspaceSnapshot(userId, scope, kind);
    mocks.query.mockResolvedValue([{ id: userId }, { id: "usr_delegate" }]);
    await expect(deleteWorkspaceSnapshot(userId, snapshot.id, scope, { userId: "usr_delegate" }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(row.id).toBe(snapshot.id);
    expect(await readdir(directory)).toEqual([`${snapshot.id}.zip`]);
  });

  it("a delegated prune preserves unrelated automatic recovery rows and ZIPs", async () => {
    const snapshot = await createWorkspaceSnapshot(userId, scope, "PRE_DELETE");
    mocks.query.mockImplementation(async (sql) => sql.includes("FROM users")
      ? [{ id: userId }, { id: "usr_delegate" }]
      : Array.from({ length: 21 }, (_, i) => ({ id: i === 20 ? snapshot.id : `snapshot_${String(i).padStart(32, "0")}`, kind: "PRE_DELETE", recent: 1 })));
    await pruneAutomaticSnapshots(userId, scope, [], { userId: "usr_delegate" });
    expect(row.id).toBe(snapshot.id);
    expect(await readdir(directory)).toEqual([`${snapshot.id}.zip`]);
  });
});

describe("real backup preparation uses explicit snapshot byte ceilings", () => {
  it("rejects oversized retained files before staging their bytes", async () => {
    const { prepareUserDataBackup, dataTransferTempDir } = await vi.importActual("../src/lib/data-transfer.js");
    const ownerDirectory = path.join(mocks.root, userId);
    await mkdir(ownerDirectory, { recursive: true });
    await writeFile(path.join(ownerDirectory, "blk_retained"), Buffer.alloc(1024));
    await expect(prepareUserDataBackup(userId, { maxArchiveBytes: 1023n })).rejects.toMatchObject({ code: "DATA_BACKUP_TOO_LARGE" });
    expect(await readdir(dataTransferTempDir)).toEqual([]);
    expect(await readdir(ownerDirectory)).toEqual(["blk_retained"]);
  });

  it("includes ZIP headers in the limit and cleans staging on rejection", async () => {
    const { prepareUserDataBackup, dataTransferTempDir } = await vi.importActual("../src/lib/data-transfer.js");
    const plan = await prepareUserDataBackup(userId, { maxArchiveBytes: 1024n * 1024n, maxManifestBytes: 1024 * 1024 });
    expect(plan.archiveSize).toBeGreaterThan(BigInt(plan.manifestBuffer.length));
    await rm(plan.operationRoot, { recursive: true, force: true });
    await expect(prepareUserDataBackup(userId, { maxArchiveBytes: plan.archiveSize - 1n })).rejects.toMatchObject({ code: "DATA_BACKUP_TOO_LARGE" });
    expect(await readdir(dataTransferTempDir)).toEqual([]);
    const exact = await prepareUserDataBackup(userId, { maxArchiveBytes: plan.archiveSize });
    await rm(exact.operationRoot, { recursive: true, force: true });
  });

  it("bounds manifest allocation even when configured network limits are disabled", async () => {
    const { prepareUserDataBackup, dataTransferTempDir } = await vi.importActual("../src/lib/data-transfer.js");
    await expect(prepareUserDataBackup(userId, { enforceConfiguredSizeLimits: false, maxManifestBytes: 32 })).rejects.toMatchObject({ code: "DATA_BACKUP_TOO_LARGE" });
    expect(await readdir(dataTransferTempDir)).toEqual([]);
  });
});
