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
import { createWorkspaceSnapshot, deleteWorkspaceSnapshot, restoreWorkspaceSnapshot } from "../src/lib/workspace-snapshots.js";
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
    expect(mocks.import).toHaveBeenCalledWith(userId, path.join(directory, `${snapshot.id}.zip`), scope, expect.any(Function), { enforceConfiguredSizeLimits: false });
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
