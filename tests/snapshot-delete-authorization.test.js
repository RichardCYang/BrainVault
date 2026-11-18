import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: `${process.cwd()}/uploads/snapshot-delete-authorization-${process.pid}`,
  actor: "usr_delegate", permission: "ADMIN", generation: 1, childCollection: "pag_collection",
  pages: new Map(), snapshots: new Map(), receipts: new Map(),
  query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), prepare: vi.fn(), write: vi.fn(),
  afterWrite: null, auth: vi.fn()
}));
vi.mock("../src/lib/db.js", () => ({
  db: state, transaction: async (fn) => fn(state), TransactionCommitOutcomeUnknownError: class extends Error {}
}));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req, _res, next) => { req.user = { id: state.actor }; next(); },
  requireRequestAuthScope: () => ({ authVersion: 1, workspaceGeneration: 1, sessionId: "fixture" })
}));
vi.mock("../src/lib/auth-sessions.js", () => ({ assertCurrentAuthSessionBoundary: state.auth }));
vi.mock("../src/lib/attachments.js", async (original) => ({ ...(await original()), attachmentUploadRoot: state.root }));
vi.mock("../src/lib/data-transfer.js", () => ({
  prepareUserDataBackup: state.prepare, writeUserDataBackup: state.write,
  admitDataRestore: vi.fn(), importUserDataBackup: vi.fn(), readUserDataBackupManifest: vi.fn(), replayCompletedDataRestore: vi.fn()
}));

import { pageRouter } from "../src/routes/page.routes.js";
import { errorHandler } from "../src/middleware/error.js";

const owner = "usr_owner";
const directory = path.join(state.root, ".workspace-snapshots", createHash("sha256").update(owner).digest("hex"));
const app = express().use(express.json()).use("/api/pages", pageRouter).use(errorHandler);
const deletion = (expectedSnapshot = "0".repeat(64), pageId = "pag_member", headers = {}) => request(app)
  .delete(`/api/pages/${pageId}?permanent=true`).set(headers).send({ expectedSnapshot, mutationId: "delete_fixture" });
async function preview(pageId = "pag_member") {
  const response = await request(app).get(`/api/pages/${pageId}/deletion-snapshot`).expect(200);
  return response.body.snapshot;
}
const archives = async () => readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; });

beforeEach(() => {
  vi.clearAllMocks();
  state.actor = "usr_delegate"; state.permission = "ADMIN"; state.generation = 1; state.afterWrite = null;
  state.childCollection = "pag_collection";
  state.snapshots = new Map(); state.receipts = new Map();
  state.pages = new Map([
    ["pag_collection", { id: "pag_collection", parent_page_id: null, is_collection: 1 }],
    ["pag_member", { id: "pag_member", parent_page_id: "pag_collection", is_collection: 0 }],
    ["pag_child", { id: "pag_child", parent_page_id: "pag_member", is_collection: 0 }]
  ].map(([id, page]) => [id, { ...page, owner_id: owner, title: id, edit_version: 1, content_version: 1, is_archived: 0 }]));
  state.queryOne.mockImplementation(async (sql, params = []) => {
    if (sql.includes("FROM users")) return { id: params[0], username: params[0], attachment_generation: state.generation };
    if (sql.includes("FROM pages WHERE id = ?")) return state.pages.get(params[0]);
    if (sql.includes("FROM page_collection_memberships")) return { collection_id: "pag_collection" };
    if (sql.includes("FROM collection_shares")) return state.permission ? { permission: state.permission, generation: "grant1" } : undefined;
    if (sql.includes("FROM page_delete_mutations")) return state.receipts.get(params[1]);
    if (sql.includes("COUNT(*) AS snapshot_count")) return {
      snapshot_count: state.snapshots.size,
      total_bytes: String([...state.snapshots.values()].reduce((sum, row) => sum + Number(row.archive_size), 0))
    };
    if (sql.includes("FROM workspace_snapshots")) return state.snapshots.get(params[0]);
    return undefined;
  });
  state.query.mockImplementation(async (sql, params = []) => {
    if (sql.includes("FROM users")) return params.map((id) => ({ id }));
    if (sql.includes("FROM pages") && sql.includes("WHERE owner_id")) return [...state.pages.values()];
    if (sql.includes("FROM pages") && sql.includes("WHERE id IN")) return [...state.pages.values()].filter((page) => params.includes(page.id));
    if (sql.includes("SELECT page_id, collection_id")) return [...state.pages.values()]
      .filter((page) => params.includes(sql.includes("WHERE collection_id IN") ? "pag_collection" : page.id))
      .map((page) => ({ page_id: page.id, collection_id: page.id === "pag_child" ? state.childCollection : "pag_collection" }));
    if (sql.includes("FROM workspace_snapshots")) return [...state.snapshots.values()].reverse().map((row) => ({ ...row, recent: 1 }));
    return [];
  });
  state.execute.mockImplementation(async (sql, values = []) => {
    if (sql.includes("INSERT INTO workspace_snapshots")) state.snapshots.set(values[0], {
      id: values[0], user_id: values[1], archive_size: values[2], archive_sha256: values[3],
      kind: values[9], created_at: "2026-11-18", page_count: 3, block_count: 0, attachment_count: 0, page_version_count: 0
    });
    if (sql.includes("DELETE FROM workspace_snapshots")) state.snapshots.delete(values[0]);
    if (sql.includes("DELETE FROM pages")) state.pages.delete(values[0]);
    if (sql.includes("INSERT INTO page_delete_mutations")) state.receipts.set(values[1], {
      page_id: values[2], request_hash: values[3], page_ids: values[4], attachment_ids: values[5],
      attachment_generation: values[6], workspace_owner_id: values[7]
    });
    return { affectedRows: 1 };
  });
  state.prepare.mockReset().mockResolvedValue({ archiveSize: 7n, manifest: { data: { pages: [], blocks: [] }, attachments: [] } });
  state.write.mockReset().mockImplementation(async (_plan, output) => { output.write("archive"); await state.afterWrite?.(); });
});
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });

describe("permanent deletion snapshot authorization over HTTP", () => {
  it.each([null, "READ", "WRITE"])("permission %s creates no owner row or archive", async (permission) => {
    state.permission = permission;
    await deletion().expect(permission === null ? 404 : 403);
    expect(state.snapshots.size).toBe(0);
    expect(await archives()).toEqual([]);
    expect(state.prepare).not.toHaveBeenCalled();
  });

  it("a bogus confirmation cannot allocate a snapshot even for an administrator", async () => {
    const response = await deletion().expect(409);
    expect(response.body.error.code).toBe("PAGE_EDIT_CONFLICT");
    expect(state.prepare).not.toHaveBeenCalled();
    expect(await archives()).toEqual([]);
  });

  it("a collection administrator cannot create a safety copy by targeting the collection root", async () => {
    await deletion("0".repeat(64), "pag_collection").expect(403);
    expect(state.prepare).not.toHaveBeenCalled();
  });

  it("rejects an out-of-scope descendant before writing any workspace archive", async () => {
    state.childCollection = "pag_other_collection";
    await deletion().expect(409);
    expect(state.prepare).not.toHaveBeenCalled();
    expect(await archives()).toEqual([]);
  });

  it.each(["revocation", "restore", "content", "membership"])("fences %s during archive preparation", async (change) => {
    const snapshot = await preview();
    state.afterWrite = () => {
      if (change === "revocation") state.permission = null;
      if (change === "restore") state.generation++;
      if (change === "content") state.pages.get("pag_child").content_version++;
      if (change === "membership") state.childCollection = "pag_other_collection";
    };
    await deletion(snapshot).expect(change === "revocation" ? 404 : 409);
    expect(state.snapshots.size).toBe(0);
    expect(await archives()).toEqual([]);
    expect(state.pages.size).toBe(3);
  });

  it("an authorized delegate saves recovery data, cannot skip it, and never prunes unrelated snapshots", async () => {
    for (let i = 0; i < 21; i++) state.snapshots.set(`snapshot_${String(i).padStart(32, "0")}`, {
      id: `snapshot_${String(i).padStart(32, "0")}`, user_id: owner, kind: "PRE_DELETE", archive_size: "7"
    });
    const response = await deletion(await preview(), "pag_member", { "X-Delete-Skip-Safety-Snapshot": "1" }).expect(204);
    expect(response.headers["x-delete-safety-snapshot-owner"]).toBe("1");
    expect(response.headers["x-delete-safety-snapshot-id"]).toBeUndefined();
    expect(state.snapshots.size).toBe(22);
    expect(await archives()).toHaveLength(1);
    expect([...state.pages.keys()]).toEqual(["pag_collection"]);
  });

  it("owner deletion and a response-loss retry create only one safety copy", async () => {
    state.actor = owner;
    const snapshot = await preview();
    const response = await deletion(snapshot).expect(204);
    expect(response.headers["x-delete-safety-snapshot-id"]).toMatch(/^snapshot_/);
    await deletion(snapshot).expect(204);
    expect(state.snapshots.size).toBe(1);
    expect(await archives()).toHaveLength(1);
  });

  it.each(["pag_member", "pag_child"])("the owner may skip a safety copy for %s", async (pageId) => {
    state.actor = owner;
    await deletion(await preview(pageId), pageId, { "X-Delete-Skip-Safety-Snapshot": "1" }).expect(204);
    expect(state.pages.has(pageId)).toBe(false);
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.snapshots.size).toBe(0);
    expect(await archives()).toEqual([]);
  });
});

describe("delegated permanent deletion of a single ordinary page", () => {
  const pageId = "pag_child";

  it.each([{}, { "X-Delete-Skip-Safety-Snapshot": "1" }])("saves an owner copy before deleting with headers %j", async (headers) => {
    state.afterWrite = () => expect(state.pages.has(pageId)).toBe(true);
    const snapshot = await preview(pageId);
    const response = await deletion(snapshot, pageId, headers).expect(204);

    expect(response.headers["x-delete-safety-snapshot-owner"]).toBe("1");
    expect(response.headers["x-delete-safety-snapshot-id"]).toBeUndefined();
    expect(state.prepare).toHaveBeenCalledWith(owner, expect.any(Object));
    expect([...state.snapshots.values()]).toEqual([
      expect.objectContaining({ user_id: owner, kind: "PRE_DELETE" })
    ]);
    expect(await archives()).toHaveLength(1);
    expect([...state.pages.keys()]).toEqual(["pag_collection", "pag_member"]);

    // A lost response must replay the receipt without creating another copy.
    await deletion(snapshot, pageId, headers).expect(204);
    expect(state.prepare).toHaveBeenCalledTimes(1);
    expect(state.snapshots.size).toBe(1);
    expect(await archives()).toHaveLength(1);
  });

  it.each(["prepare", "write"])("stops deletion when snapshot %s fails even with the skip header", async (stage) => {
    const failure = new Error("fixture snapshot failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      state[stage].mockRejectedValueOnce(failure);
      const response = await deletion(await preview(pageId), pageId, {
        "X-Delete-Skip-Safety-Snapshot": "1"
      }).expect(409);

      expect(response.body.error.code).toBe("OWNER_DELETE_SAFETY_SNAPSHOT_FAILED");
      expect(state.pages.size).toBe(3);
      expect(state.receipts.size).toBe(0);
      expect(state.snapshots.size).toBe(0);
      expect(await archives()).toEqual([]);
      expect(state.execute.mock.calls.some(([sql]) => sql.includes("DELETE FROM pages"))).toBe(false);
    } finally {
      errorLog.mockRestore();
    }
  });

  it.each([null, "READ", "WRITE"])("permission %s cannot allocate a leaf safety copy", async (permission) => {
    state.permission = permission;
    await deletion(undefined, pageId).expect(permission === null ? 404 : 403);
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.pages.size).toBe(3);
    expect(await archives()).toEqual([]);
  });

  it.each(["revocation", "restore", "content"])("fences a leaf %s change during snapshot creation", async (change) => {
    const snapshot = await preview(pageId);
    state.afterWrite = () => {
      if (change === "revocation") state.permission = null;
      if (change === "restore") state.generation++;
      if (change === "content") state.pages.get(pageId).content_version++;
    };
    await deletion(snapshot, pageId).expect(change === "revocation" ? 404 : 409);
    expect(state.pages.size).toBe(3);
    expect(state.receipts.size).toBe(0);
    expect(state.snapshots.size).toBe(0);
    expect(await archives()).toEqual([]);
  });
});
