import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Execute the actual route handler with deterministic transaction/worker doubles.
// This verifies lock boundaries and race fencing, not MariaDB isolation or latency.
const source = stripTypeScriptTypes(readFileSync(
  new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8"
));
const routeStart = source.indexOf('"/pages/:pageId/collaboration/snapshot"');
const handlerStart = source.indexOf("async (req, res, next) => {", routeStart);
const handlerEnd = source.indexOf("\n);", handlerStart);
assert.ok(routeStart >= 0 && handlerStart > routeStart && handlerEnd > handlerStart);
const handlerSource = source.slice(handlerStart, handlerEnd).trim();

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
class CollaborationDocumentError extends Error {}
class CollaborationValidationCapacityError extends Error {}
class CollaborationValidationResourceLimitError extends Error {}
class CollaborationHistoryTimeoutError extends Error {}

function setup({ duringReplay, beforeRequest, workerError } = {}) {
  const state = {
    page: {
      id: "page", owner_id: "owner", title: "Old title", edit_version: 1,
      content_version: 1, is_archived: 0, is_collection: 0, updated_at: "2026-09-17"
    },
    history: [{ id: 7, user_id: "editor", update_data: Buffer.from([0, 0]) }],
    checkpoint: { document_epoch: "epoch", materialized_update_id: 0, materialization_version: 2 },
    shareCount: 1, shareGeneration: "grant", editable: true,
    authenticated: true, attachmentGeneration: 3, acceptHistory: true,
    transactionId: 0, activeTransaction: false, workerCalls: 0, blobReads: 0,
    authChecks: 0, lockedAccessChecks: 0, writes: [], trace: []
  };
  const cloneHistory = () => state.history.map((row) => ({ ...row, update_data: Buffer.from(row.update_data) }));
  const locked = () => assert.equal(state.activeTransaction, true);
  const client = {
    async queryOne(sql) {
      locked();
      if (sql.includes("COUNT(*) AS history_entries")) {
        return {
          history_entries: state.history.length,
          history_bytes: state.history.reduce((sum, row) => sum + row.update_data.length, 0)
        };
      }
      if (sql.startsWith("SELECT * FROM pages")) return { ...state.page };
      throw new Error(`Unexpected queryOne: ${sql}`);
    },
    async query(sql, params) {
      locked();
      if (sql.includes("SELECT id, update_data, user_id")) {
        state.blobReads += 1;
        return cloneHistory();
      }
      if (sql.includes("OCTET_LENGTH(update_data) AS update_bytes")) {
        assert.ok(sql.includes("LIMIT ? FOR UPDATE"));
        return state.history.slice(0, params[1]).map((row) => ({
          id: row.id, update_bytes: row.update_data.length
        }));
      }
      if (sql.startsWith("SELECT * FROM blocks")) return [];
      throw new Error(`Unexpected query: ${sql}`);
    },
    async execute(sql, params) {
      locked();
      state.writes.push({ transaction: state.transactionId, sql });
      if (sql.startsWith("UPDATE pages")) {
        state.page.title = params[0];
        state.page.edit_version += 1;
        state.page.content_version += 1;
      } else if (sql.startsWith("UPDATE page_collaboration_state")) {
        state.checkpoint.materialized_update_id = params[0];
        state.checkpoint.materialization_version = params[1];
      } else throw new Error(`Unexpected execute: ${sql}`);
      return { affectedRows: 1 };
    }
  };
  const dependencies = {
    ApiError, CollaborationDocumentError, CollaborationValidationCapacityError,
    CollaborationValidationResourceLimitError, CollaborationHistoryTimeoutError,
    Buffer, console,
    requireUser: (user) => user,
    requireRequestAuthScope: () => ({ authVersion: 1, workspaceGeneration: 1 }),
    notFound: () => new ApiError(404, "NOT_FOUND", "Page not found"),
    async transaction(callback) {
      assert.equal(state.activeTransaction, false);
      state.activeTransaction = true;
      state.transactionId += 1;
      state.trace.push(`begin:${state.transactionId}`);
      try { return await callback(client); }
      finally {
        state.trace.push(`end:${state.transactionId}`);
        state.activeTransaction = false;
      }
    },
    async getPageAccess(_pageId, _userId, db, options) {
      if (db) {
        locked();
        assert.equal(options.lockPage, true);
        state.lockedAccessChecks += 1;
      }
      return {
        page: { ...state.page }, shareCount: state.shareCount,
        shareGeneration: state.shareGeneration, editable: state.editable
      };
    },
    async lockCollaborationMutationUsers(_db, users) {
      locked(); assert.deepEqual(users, ["editor", "owner"]);
    },
    async assertCurrentAuthSessionBoundary() {
      locked(); state.authChecks += 1;
      if (!state.authenticated) throw new ApiError(401, "AUTH_SESSION_INVALID", "Session expired");
    },
    async lockUserAttachmentGeneration() { locked(); return state.attachmentGeneration; },
    assertShareablePage(page) {
      if (page.is_archived) throw new ApiError(409, "PAGE_ARCHIVED", "Page archived");
    },
    assertPageCanEdit(access) {
      if (!access.editable) throw new ApiError(403, "PAGE_READ_ONLY", "Access revoked");
    },
    async getCollaborationState() { locked(); return { ...state.checkpoint }; },
    assertCollaborationDocumentEpoch(checkpoint, epoch) {
      if (checkpoint.document_epoch !== epoch) {
        throw new ApiError(409, "COLLABORATION_LINEAGE_CHANGED", "Document replaced");
      }
    },
    isUnsupportedCollaborationMaterializationVersion: (version) => version > 2,
    currentCollaborationMaterializationVersion: 2,
    needsCollaborationMaterialization: ({ latestUpdateId, materializedUpdateId, materializationVersion }) =>
      latestUpdateId > materializedUpdateId || materializationVersion < 2,
    toSafeHistoryMetric: (value) => Number(value),
    assessCollaborationHistoryReplay: () => ({ accepted: state.acceptHistory }),
    collaborationMaterializationPool: {
      async materializeHistory(request) {
        assert.equal(state.activeTransaction, false, "worker replay must not hold transaction locks");
        assert.equal(request.principalKey, "editor");
        assert.deepEqual(request.updates, [Buffer.from([0, 0])]);
        state.workerCalls += 1;
        state.trace.push("worker");
        await duringReplay?.(state);
        if (workerError) throw workerError;
        return { materialization: { title: "New title", blocks: [], deletedAttachmentIds: [] } };
      }
    },
    async removeDeletedAttachmentFiles() { throw new Error("No attachments in this fixture"); },
    async loadPageVersionActors() { return []; },
    async recordPageVersion() { locked(); },
    toPageVersionActor: (user) => user,
    diffPageVersionPage: () => [], diffPageVersionBlocks: () => [],
    toBlock: (block) => block,
    assertLosslessStructuredMetadata: (_type, value) => value
  };
  const handler = new Function(...Object.keys(dependencies), `return (${handlerSource});`)(
    ...Object.values(dependencies)
  );
  return {
    state,
    async run() {
      await beforeRequest?.(state);
      let response, error;
      await handler(
        { user: { id: "editor", username: "Editor" }, params: { pageId: "page" },
          body: { documentEpoch: "epoch", updateId: 7 } },
        { json(value) { response = value; } },
        (value) => { error = value; }
      );
      assert.equal(state.activeTransaction, false);
      return { response, error };
    }
  };
}

test("snapshot replay runs between transactions and commits only after reauthorization", async () => {
  const h = setup();
  const { response, error } = await h.run();
  assert.equal(error, undefined);
  assert.equal(response.applied, true);
  assert.equal(response.materializedUpdateId, 7);
  assert.equal(response.pageVersion, 2);
  assert.deepEqual(h.state.trace, ["begin:1", "end:1", "worker", "begin:2", "end:2"]);
  assert.equal(h.state.authChecks, 2);
  assert.equal(h.state.lockedAccessChecks, 2);
  assert.equal(h.state.blobReads, 1);
  assert.equal(h.state.writes.length, 2);
  assert.ok(h.state.writes.every((write) => write.transaction === 2));
});

test("an already materialized snapshot never dispatches a worker", async () => {
  const h = setup({ beforeRequest: (s) => { s.checkpoint.materialized_update_id = 7; } });
  const { response, error } = await h.run();
  assert.equal(error, undefined);
  assert.equal(response.applied, false);
  assert.equal(h.state.workerCalls, 0);
  assert.equal(h.state.writes.length, 0);
});

const races = [
  ["access revocation", (s) => { s.editable = false; }, "PAGE_READ_ONLY"],
  ["session revocation", (s) => { s.authenticated = false; }, "AUTH_SESSION_INVALID"],
  ["page ownership", (s) => { s.page.owner_id = "other"; }, "PAGE_OWNER_CHANGED"],
  ["archiving", (s) => { s.page.is_archived = 1; }, "PAGE_ARCHIVED"],
  ["collaboration disabling", (s) => { s.shareCount = 0; }, "COLLABORATION_DISABLED"],
  ["grant replacement", (s) => { s.shareGeneration = "replacement"; }, "COLLABORATION_GRANT_REPLACED"],
  ["workspace replacement", (s) => { s.attachmentGeneration += 1; }, "COLLABORATION_LINEAGE_CHANGED"],
  ["document replacement", (s) => { s.checkpoint.document_epoch = "replacement"; }, "COLLABORATION_LINEAGE_CHANGED"],
  ["new durable update", (s) => { s.history.push({ id: 8, user_id: "owner", update_data: Buffer.from([0, 0]) }); }, "COLLABORATION_SNAPSHOT_STALE"],
  ["history compaction", (s) => { s.history[0].update_data = Buffer.from([0, 0, 0]); }, "COLLABORATION_SNAPSHOT_STALE"],
  ["page edits", (s) => { s.page.edit_version += 1; }, "COLLABORATION_MATERIALIZATION_CONFLICT"],
  ["content edits", (s) => { s.page.content_version += 1; }, "COLLABORATION_MATERIALIZATION_CONFLICT"],
  ["newer materialization schema", (s) => { s.checkpoint.materialization_version = 3; }, "COLLABORATION_MATERIALIZATION_VERSION_UNSUPPORTED"],
  ["newer update already materialized", (s) => {
    s.history.push({ id: 8, user_id: "owner", update_data: Buffer.from([0, 0]) });
    s.checkpoint.materialized_update_id = 8;
  }, "COLLABORATION_SNAPSHOT_STALE"]
];
for (const [name, change, code] of races) {
  test(`${name} during replay fails closed before canonical writes`, async () => {
    const h = setup({ duringReplay: change });
    const { response, error } = await h.run();
    assert.equal(response, undefined);
    assert.equal(error?.code, code);
    assert.equal(h.state.workerCalls, 1);
    assert.equal(h.state.writes.length, 0);
  });
}

test("a competing materializer makes replay a no-op rather than a duplicate write", async () => {
  const h = setup({ duringReplay: (s) => {
    s.checkpoint.materialized_update_id = 7;
    s.page.edit_version += 1;
  } });
  const { response, error } = await h.run();
  assert.equal(error, undefined);
  assert.equal(response.applied, false);
  assert.equal(h.state.writes.length, 0);
});

for (const ErrorClass of [CollaborationValidationCapacityError, CollaborationValidationResourceLimitError, CollaborationHistoryTimeoutError]) {
  test(`${ErrorClass.name} leaves no transaction open or canonical write`, async () => {
    const h = setup({ workerError: new ErrorClass("Worker rejected") });
    const { error } = await h.run();
    assert.equal(error?.status, 503);
    assert.equal(h.state.transactionId, 1);
    assert.equal(h.state.writes.length, 0);
  });
}

test("over-budget history is rejected before BLOB loading or worker dispatch", async () => {
  const h = setup({ beforeRequest: (s) => { s.acceptHistory = false; } });
  const { error } = await h.run();
  assert.equal(error?.code, "COLLABORATION_HISTORY_REPLAY_LIMIT");
  assert.equal(h.state.blobReads, 0);
  assert.equal(h.state.workerCalls, 0);
  assert.equal(h.state.writes.length, 0);
});
