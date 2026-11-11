import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), verify: vi.fn(), auth: vi.fn(),
  commitError: null as Error | null,
  CommitError: class extends Error { readonly commitOutcomeUnknown = true; }
}));
vi.mock("../src/lib/db.js", () => ({
  db: { query: database.query, queryOne: database.verify, execute: database.execute },
  TransactionCommitOutcomeUnknownError: database.CommitError,
  transaction: async (fn: (client: unknown) => unknown) => {
    const result = await fn(database);
    if (database.commitError) throw database.commitError;
    return result;
  }
}));
vi.mock("../src/lib/auth-sessions.js", () => ({ assertCurrentAuthSession: database.auth, assertCurrentAuthSessionBoundary: database.auth }));

import { ApiError } from "../src/lib/http.js";
import { errorHandler } from "../src/middleware/error.js";
import { parseBackupManifest, readUserDataBackupManifest, importUserDataBackup } from "../src/lib/data-transfer.js";
import { deleteWorkspaceSnapshot } from "../src/lib/workspace-snapshots.js";
import { attachmentUploadRoot, getAttachmentFilePath, moveAttachmentFile } from "../src/lib/attachments.js";
import { syncPath } from "../src/lib/storage-sync.js";
import { crc32, ZipWriter } from "../src/lib/zip.js";

function manifest(version = 6) {
  return {
    format: "brainvault-backup", version, exportedAt: "2026-11-04T00:00:00.000Z",
    source: { userId: "usr_report", username: "report" },
    account: { name: null, avatar_data: null, preferred_language: null, default_collection_icon: null,
      ...(version >= 5 ? { theme: "light" } : {}) },
    data: { pages: [], blocks: [], tags: [], pageTags: [],
      ...(version >= 4 ? { pageShares: [], collectionShares: [], pageComments: [], pageVersions: [],
        navigationCollapsedPageIds: [], navigationPageOrder: [] } : {}) },
    attachments: [], ...(version >= 2 ? { pageCovers: [] } : {}),
    ...(version >= 3 ? { retainedAttachments: [], customIcons: [], customIconLibraryRemovals: [] } : {}),
    ...(version >= 6 ? { customIconPublications: [] } : {})
  };
}

const temporaryPaths: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "brainvault-report-"));
  temporaryPaths.push(directory);
  return directory;
}
afterEach(async () => {
  for (const target of temporaryPaths.splice(0)) await rm(target, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  database.commitError = null;
  database.queryOne.mockReset();
  database.verify.mockReset();
  database.execute.mockReset();
  database.auth.mockReset();
});

async function zipManifest(value: unknown) {
  const directory = await temporaryDirectory();
  const zipPath = path.join(directory, "backup.zip");
  const data = Buffer.from(JSON.stringify(value));
  const output = createWriteStream(zipPath);
  const writer = new ZipWriter(output);
  await writer.add({ name: "brainvault-backup.json", size: BigInt(data.length), crc32: crc32(data), source: { kind: "buffer", data } });
  await writer.finalize();
  output.end();
  await once(output, "finish");
  return zipPath;
}

describe("BV-2026-01 backup validation", () => {
  it.each([1, 2, 3, 4, 5, 6])("preserves supported backup version %i", async (version) => {
    const value = manifest(version);
    expect(await readUserDataBackupManifest(await zipManifest(value))).toEqual(value);
  });

  it.each([
    ["pageVersions", 200_000], ["pageVersions", 50_000], ["pageComments", 200_000],
    ["pageTags", 100_000], ["customIconPublications", 200_000], ["customIconLibraryRemovals", 50_000]
  ] as const)("rejects %s with %i invalid rows before restore SQL and bounds the HTTP error", async (section, count) => {
    const value = manifest();
    const target = section.startsWith("custom") ? value : value.data;
    Object.assign(target, { [section]: Array.from({ length: count }, () => ({})) });
    const zipPath = await zipManifest(value);
    const app = express();
    app.post("/import", async (_req, res, next) => {
      try {
        await importUserDataBackup("usr_report", zipPath, { authVersion: 1, workspaceGeneration: 1, sessionId: "test" }, undefined,
          { admission: { userId: "usr_report", operationId: "validation", sourceKey: "upload", fingerprint: "fixture" } });
        res.sendStatus(204);
      } catch (error) { next(error); }
    });
    app.use(errorHandler);
    const response = await request(app).post("/import").expect(400);
    expect(response.body.error.code).toBe("INVALID_DATA_BACKUP");
    expect(Buffer.byteLength(response.text)).toBeLessThan(1024);
    await expect(readUserDataBackupManifest(zipPath, { enforceConfiguredSizeLimits: false }))
      .rejects.toMatchObject({ statusCode: 400, code: "INVALID_DATA_BACKUP" });
    expect(database.execute).not.toHaveBeenCalled();
    expect(database.verify).not.toHaveBeenCalled();
  });

  it("still validates the last entry in a large valid collection", () => {
    const value = manifest();
    const entries = Array.from({ length: 200_000 }, () => ({
      page_id: "page", fileName: "icon.png", created_at: "2026-11-04 00:00:00"
    }));
    Object.assign(value, { customIconPublications: entries });
    expect(parseBackupManifest(value).customIconPublications).toHaveLength(200_000);
    Object.assign(entries[entries.length - 1], { page_id: "../invalid" });
    expect(() => parseBackupManifest(value)).toThrow(ApiError);
  });

  it("rejects oversized, deep and wide structures before schema validation", () => {
    const tooMany = { ...manifest(), attachments: new Array(200_001).fill(null) };
    let deep: unknown = null;
    for (let index = 0; index < 32; index++) deep = { nested: deep };
    const wide = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`key${i}`, null]));
    for (const input of [tooMany, { ...manifest(), extra: deep }, { ...manifest(), extra: wide }]) {
      expect(() => parseBackupManifest(input)).toThrow(expect.objectContaining({ code: "DATA_BACKUP_COMPLEXITY_EXCEEDED" }));
    }
  });

  it("caps cross-version errors for otherwise valid rows", () => {
    const value = manifest();
    Object.assign(value.data, { pageShares: Array.from({ length: 20_000 }, () => ({
      page_id: "page", shared_username: "editor", permission: "EDIT", created_at: "2026-11-04 00:00:00"
    })) });
    expect(() => parseBackupManifest(value)).toThrow(expect.objectContaining({ code: "INVALID_DATA_BACKUP", details: undefined }));
  });
});

it("caps generic Zod HTTP details, including attacker-controlled messages and field names", async () => {
  const error = new z.ZodError(Array.from({ length: 50_000 }, (_, i) => ({
    code: "custom", path: [i === 0 ? "__proto__" : "x".repeat(10_000) + i], message: "y".repeat(10_000)
  })));
  const app = express();
  app.get("/error", (_req, _res, next) => next(error));
  app.use(errorHandler);
  const response = await request(app).get("/error").expect(400);
  expect(response.body.error.code).toBe("VALIDATION_ERROR");
  expect(Buffer.byteLength(response.text)).toBeLessThan(7000);
  expect(Object.values(response.body.error.details.fieldErrors).flat()).toHaveLength(20);
});

describe("BV-2026-02 snapshot deletion", () => {
  const id = "snapshot_" + "a".repeat(32);
  const auth = { authVersion: 1, workspaceGeneration: 1, sessionId: "test" };
  const owner = "usr_report_snapshot_owner";
  const stranger = "usr_report_snapshot_stranger";
  const directory = (user: string) => path.join(attachmentUploadRoot, ".workspace-snapshots", createHash("sha256").update(user).digest("hex"));
  async function archive(user: string) {
    const folder = directory(user);
    await mkdir(folder, { recursive: true });
    temporaryPaths.push(folder);
    const file = path.join(folder, id + ".zip");
    await writeFile(file, "recovery bytes");
    return file;
  }

  it("returns 404 for both foreign and absent IDs without touching archives", async () => {
    const ownerArchive = await archive(owner);
    const strangerArchive = await archive(stranger);
    database.queryOne.mockImplementation(async (_sql, params) => params[1] === owner ? { id, user_id: owner } : undefined);
    await expect(deleteWorkspaceSnapshot(stranger, id, auth)).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteWorkspaceSnapshot(stranger, "snapshot_" + "b".repeat(32), auth)).rejects.toMatchObject({ statusCode: 404 });
    expect(database.execute).not.toHaveBeenCalled();
    expect(database.verify).not.toHaveBeenCalled();
    expect(await readFile(ownerArchive, "utf8")).toBe("recovery bytes");
    expect(await readFile(strangerArchive, "utf8")).toBe("recovery bytes");
  });

  it("propagates revoked sessions without checking for an absent row", async () => {
    database.auth.mockRejectedValue(new ApiError(401, "SESSION_REVOKED", "Revoked"));
    await expect(deleteWorkspaceSnapshot(owner, id, auth)).rejects.toMatchObject({ statusCode: 401 });
    expect(database.queryOne).not.toHaveBeenCalled();
    expect(database.verify).not.toHaveBeenCalled();
  });

  it.each([false, true])("cleans up only after a successful or verified commit (ambiguous=%s)", async (ambiguous) => {
    const file = await archive(owner);
    database.queryOne.mockResolvedValue({ id, user_id: owner });
    database.execute.mockImplementation(async () => {
      expect(await readFile(file, "utf8")).toBe("recovery bytes");
    });
    if (ambiguous) database.commitError = new database.CommitError("lost COMMIT reply");
    expect(await deleteWorkspaceSnapshot(owner, id, auth)).toEqual({ deleted: true });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(database.verify).toHaveBeenCalledTimes(ambiguous ? 1 : 0);
  });

  it.each(["row-present", "verification-failed", "delete-failed"])("preserves recovery bytes on %s", async (mode) => {
    const file = await archive(owner);
    database.queryOne.mockResolvedValue({ id, user_id: owner });
    database.commitError = new database.CommitError("lost COMMIT reply");
    if (mode === "row-present") database.verify.mockResolvedValue({ id });
    if (mode === "verification-failed") database.verify.mockRejectedValue(new Error("database unavailable"));
    if (mode === "delete-failed") database.execute.mockRejectedValue(new Error("rollback"));
    await expect(deleteWorkspaceSnapshot(owner, id, auth)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("recovery bytes");
  });
});

describe("BV-2026-03 storage synchronization", () => {
  it("flushes regular files and supports directory synchronization on this platform", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "note.txt");
    await writeFile(file, "durable bytes");
    await syncPath(file);
    await syncPath(directory);
    await expect(syncPath(path.join(directory, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("moves an actual attachment without losing source bytes", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "note.txt");
    await writeFile(file, "attachment bytes");
    const target = getAttachmentFilePath("usr_report_move", "blk_report_move");
    temporaryPaths.push(path.dirname(target));
    expect(await moveAttachmentFile(file, "usr_report_move", "blk_report_move")).toBe(target);
    expect(await readFile(target, "utf8")).toBe("attachment bytes");
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
