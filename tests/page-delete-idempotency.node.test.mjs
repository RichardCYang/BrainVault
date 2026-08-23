import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assessPageDeleteMutationReceipt,
  decodePageDeleteAttachmentIds,
  decodePageDeletePageIds
} from "../src/lib/page-delete-mutation.ts";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return text.slice(startIndex, endIndex);
}

const route = source("../src/routes/page.routes.ts");
const client = source("../public/app.js");
const baselineSchema = source("../migrations/001_init.sql");
const migration = source("../migrations/056_page_delete_mutation_receipts.sql");
const attachmentGenerationMigration = source("../migrations/062_delete_receipt_attachment_generation.sql");

test("page deletion receipts replay only the exact request and retain cleanup scope", () => {
  const receipt = {
    page_id: "pag_root",
    request_hash: "hash_1",
    page_ids: '["pag_root","pag_child"]',
    attachment_ids: '["att_1","att_2"]',
    attachment_generation: 4
  };

  assert.deepEqual(
    assessPageDeleteMutationReceipt(receipt, { pageId: "pag_root", requestHash: "hash_1" }),
    {
      kind: "replay",
      pageId: "pag_root",
      pageIds: ["pag_root", "pag_child"],
      attachmentIds: ["att_1", "att_2"],
      attachmentGeneration: 4
    }
  );
  assert.deepEqual(
    assessPageDeleteMutationReceipt(receipt, { pageId: "pag_other", requestHash: "hash_1" }),
    { kind: "collision" }
  );
  assert.deepEqual(
    assessPageDeleteMutationReceipt(receipt, { pageId: "pag_root", requestHash: "hash_other" }),
    { kind: "collision" }
  );
});

test("page-delete receipt attachment generations are durable but legacy receipts remain replayable without cleanup authority", () => {
  const legacyReceipt = {
    page_id: "pag_root",
    request_hash: "hash_legacy",
    page_ids: '["pag_root"]',
    attachment_ids: '["att_legacy"]'
  };

  assert.deepEqual(
    assessPageDeleteMutationReceipt(legacyReceipt, {
      pageId: "pag_root",
      requestHash: "hash_legacy"
    }),
    {
      kind: "replay",
      pageId: "pag_root",
      pageIds: ["pag_root"],
      attachmentIds: ["att_legacy"]
    }
  );

  assert.deepEqual(
    assessPageDeleteMutationReceipt({ ...legacyReceipt, attachment_generation: 0 }, {
      pageId: "pag_root",
      requestHash: "hash_legacy"
    }),
    { kind: "incomplete" }
  );
});

test("malformed page-delete receipt scopes fail closed", () => {
  assert.equal(decodePageDeletePageIds("not-json"), null);
  assert.equal(decodePageDeletePageIds([]), null);
  assert.equal(decodePageDeletePageIds(["pag_1", "pag_1"]), null);
  assert.equal(decodePageDeleteAttachmentIds(["att_1", "att_1"]), null);
  assert.equal(decodePageDeleteAttachmentIds(["att_1", 2]), null);

  assert.deepEqual(
    assessPageDeleteMutationReceipt(
      {
        page_id: "pag_root",
        request_hash: "hash_1",
        page_ids: '["pag_child"]',
        attachment_ids: "[]"
      },
      { pageId: "pag_root", requestHash: "hash_1" }
    ),
    { kind: "incomplete" }
  );
});

test("large valid page-delete receipts remain replayable past the old 10,000-id boundary", () => {
  const pageIds = ["pag_root", ...Array.from({ length: 10_000 }, (_, index) => `pag_${index}`)];
  const attachmentIds = Array.from({ length: 10_001 }, (_, index) => `att_${index}`);

  assert.equal(decodePageDeletePageIds(pageIds)?.length, 10_001);
  assert.equal(decodePageDeleteAttachmentIds(attachmentIds)?.length, 10_001);
  assert.deepEqual(
    assessPageDeleteMutationReceipt(
      {
        page_id: "pag_root",
        request_hash: "hash_large",
        page_ids: JSON.stringify(pageIds),
        attachment_ids: JSON.stringify(attachmentIds)
      },
      { pageId: "pag_root", requestHash: "hash_large" }
    ),
    {
      kind: "replay",
      pageId: "pag_root",
      pageIds,
      attachmentIds
    }
  );
});

test("server reconciles a page-delete receipt before querying a page that may already be gone", () => {
  const deleteRoute = section(
    route,
    'pageRouter.delete(\n  "/:pageId"',
    'pageRouter.put("/:pageId/tags"'
  );

  assert.match(deleteRoute, /MUTATION_ID_REQUIRED/);
  assert.match(deleteRoute, /kind: "PAGE_DELETE"/);
  assert.match(deleteRoute, /SELECT page_id, request_hash, page_ids, attachment_ids, attachment_generation/);
  assert.match(deleteRoute, /assessPageDeleteMutationReceipt/);
  assert.match(deleteRoute, /attachmentGeneration: assessment\.attachmentGeneration/);
  assert.match(deleteRoute, /INSERT INTO page_delete_mutations/);
  assert.match(deleteRoute, /attachment_ids, attachment_generation/);
  assert.match(deleteRoute, /JSON\.stringify\(pageIds\)/);
  assert.match(deleteRoute, /JSON\.stringify\(attachmentIds\)/);
  assert.match(deleteRoute, /attachmentGeneration\s*\]/);
  assert.match(deleteRoute, /deletion\.attachmentGeneration !== undefined/);
  assert.ok(
    deleteRoute.indexOf("FROM page_delete_mutations") < deleteRoute.indexOf("getOwnedPageTreeRows(user.id"),
    "a committed delete must be replayable before the deleted page tree is queried"
  );
  assert.ok(
    deleteRoute.indexOf("DELETE FROM pages") < deleteRoute.indexOf("INSERT INTO page_delete_mutations"),
    "the receipt must be committed in the same transaction after relational deletion effects"
  );
});

test("stale delete receipts fail closed when a restored page generation reuses the same ids", () => {
  const replayGuard = section(
    route,
    "async function assertPageDeleteReplayNotSuperseded",
    "async function assertCollaborationMaterialized"
  );
  const deleteRoute = section(
    route,
    'pageRouter.delete(\n  "/:pageId"',
    'pageRouter.put("/:pageId/tags"'
  );

  assert.match(replayGuard, /SELECT id FROM pages/);
  assert.match(replayGuard, /WHERE id IN/);
  assert.match(replayGuard, /FOR UPDATE/);
  assert.match(replayGuard, /PAGE_DELETE_REPLAY_SUPERSEDED/);

  const receiptIndex = deleteRoute.indexOf("FROM page_delete_mutations");
  const guardIndex = deleteRoute.indexOf("await assertPageDeleteReplayNotSuperseded");
  const replayReturnIndex = deleteRoute.indexOf("replayed: true", guardIndex);
  assert.ok(
    receiptIndex >= 0 && guardIndex > receiptIndex && replayReturnIndex > guardIndex,
    "a receipt replay must reject reused page ids before it can acknowledge the old deletion"
  );

  const disconnectIndex = deleteRoute.indexOf(
    "disconnectPageCollaboratorsForDocumentEpoch",
    replayReturnIndex
  );
  const replayFenceIndex = deleteRoute.lastIndexOf("if (!deletion.replayed)", disconnectIndex);
  assert.ok(
    replayFenceIndex > replayReturnIndex && replayFenceIndex < disconnectIndex,
    "a receipt replay must not disconnect collaborators from a later page generation"
  );

  function reproduce({ fixed }) {
    const restoredPageIds = new Set(["pag_root", "pag_child"]);
    let localDraftPresent = true;
    let collaboratorsConnected = true;
    const staleReceiptPageIds = ["pag_root", "pag_child"];
    const superseded = staleReceiptPageIds.some((pageId) => restoredPageIds.has(pageId));

    if (fixed && superseded) {
      return { status: 409, localDraftPresent, collaboratorsConnected };
    }

    // The vulnerable server acknowledged the stale receipt as a successful
    // delete, so the browser cleaned its draft and the server disconnected
    // users even though the restored rows were never deleted.
    localDraftPresent = false;
    collaboratorsConnected = false;
    return { status: 204, localDraftPresent, collaboratorsConnected };
  }

  assert.deepEqual(reproduce({ fixed: false }), {
    status: 204,
    localDraftPresent: false,
    collaboratorsConnected: false
  });
  assert.deepEqual(reproduce({ fixed: true }), {
    status: 409,
    localDraftPresent: true,
    collaboratorsConnected: true
  });
});

test("fresh page deletes invalidate only the collaboration lineage that was deleted", () => {
  const collaborationServer = source("../src/lib/collaboration-server.ts");
  const deleteRoute = section(
    route,
    'pageRouter.delete(\n  "/:pageId"',
    'pageRouter.put("/:pageId/tags"'
  );

  const captureIndex = deleteRoute.indexOf(
    "const collaborationDocumentEpochs = await getPageCollaborationDocumentEpochs(client, pageIds)"
  );
  const deleteIndex = deleteRoute.indexOf('DELETE FROM pages WHERE id = ? AND owner_id = ?');
  const postCommitIndex = deleteRoute.indexOf("if (!deletion.replayed)", deleteIndex);
  const disconnectIndex = deleteRoute.indexOf(
    "disconnectPageCollaboratorsForDocumentEpoch(",
    postCommitIndex
  );

  assert.ok(captureIndex >= 0 && captureIndex < deleteIndex);
  assert.ok(postCommitIndex > deleteIndex && disconnectIndex > postCommitIndex);
  assert.match(collaborationServer, /room\.documentEpoch !== documentEpoch/);
  assert.match(collaborationServer, /this\.disconnectPage\(pageId, reason\)/);

  // Reproduction: delete commits lineage A, then restore recreates the same
  // page id as lineage B before post-COMMIT cleanup. An existence-only check
  // sees the restored row and leaves the old A room connected. The fixed
  // cleanup targets A directly, while a B room is left untouched.
  const deletedEpoch = "epoch_A";
  const restoredEpoch = "epoch_B";
  const disconnectForDeletedEpoch = (localRoomEpoch) => localRoomEpoch === deletedEpoch;

  assert.equal(disconnectForDeletedEpoch(deletedEpoch), true);
  assert.equal(disconnectForDeletedEpoch(restoredEpoch), false);
});

test("browser retries ambiguous permanent page deletes with one auth-scoped mutation id", () => {
  const deleteClient = section(
    client,
    "function findPendingPageDeleteTask",
    "function renderCollectionView"
  );

  assert.match(client, /const pendingPageDeleteTasks = new Map\(\)/);
  assert.match(deleteClient, /function findPendingPageDeleteTask\(authenticationScope, pageId\)/);
  assert.match(deleteClient, /mutationId: createMutationId\(\)/);
  assert.match(deleteClient, /pageIds: Object\.freeze\(\[\.\.\.pageIds\]\)/);
  assert.match(deleteClient, /task\.attempted = true/);
  assert.ok(
    deleteClient.indexOf("findPendingPageDeleteTask(authenticationScope, target.id)")
      < deleteClient.indexOf("deletion-snapshot"),
    "a response-loss retry must reuse its mutation id before requesting a snapshot that may now 404"
  );
  assert.match(deleteClient, /while \(attempt < 2\)/);
  assert.match(deleteClient, /isAmbiguousApiError\(error\)/);
  assert.match(deleteClient, /expectedSnapshot: task\.expectedSnapshot, mutationId: task\.mutationId/);
  assert.ok(
    (client.match(/pendingPageDeleteTasks\.clear\(\)/g) ?? []).length >= 2,
    "page-delete retry tasks must be cleared on logout and credential rotation"
  );
});

test("permanent page delete binds authentication before asynchronous save settlement", async () => {
  const deleteClient = section(
    client,
    "async function deleteNavigationTarget()",
    "function renderCollectionView"
  );
  const captureIndex = deleteClient.indexOf("const authenticationScope = captureAuthenticatedSessionScope()");
  const workspaceBarrierIndex = deleteClient.indexOf("await assertWorkspacePersistenceUnlocked()");
  const editLockIndex = deleteClient.indexOf("return withPageEditLock");
  const postLockFenceIndex = deleteClient.indexOf(
    "!isCurrentAuthenticatedSessionScope(authenticationScope)",
    editLockIndex
  );
  const snapshotRequestIndex = deleteClient.indexOf("deletion-snapshot", editLockIndex);

  assert.ok(captureIndex >= 0, "page delete must capture its authentication generation");
  assert.ok(
    captureIndex < workspaceBarrierIndex && captureIndex < editLockIndex,
    "page delete must bind auth before any asynchronous persistence/save barrier can rotate credentials"
  );
  assert.ok(
    postLockFenceIndex > editLockIndex && postLockFenceIndex < snapshotRequestIndex,
    "page delete must revalidate the initiating auth generation after edit-lock save settlement"
  );

  async function reproduce({ fixed }) {
    let generation = 1;
    let deleteRequests = 0;
    const capture = () => generation;
    const current = (scope) => scope === generation;
    const settlePendingSaves = async () => {
      // Simulate another tab changing the password while this tab waits for
      // an already-running save to settle.
      generation += 1;
    };

    const initiatingScope = fixed ? capture() : null;
    await settlePendingSaves();
    const destructiveScope = fixed ? initiatingScope : capture();
    if (!current(destructiveScope)) return { deleteRequests, generation };
    deleteRequests += 1;
    return { deleteRequests, generation };
  }

  assert.deepEqual(
    await reproduce({ fixed: false }),
    { deleteRequests: 1, generation: 2 },
    "capturing after the save barrier donates the replacement credential generation to the old delete click"
  );
  assert.deepEqual(
    await reproduce({ fixed: true }),
    { deleteRequests: 0, generation: 2 },
    "capturing before the save barrier aborts the stale destructive action after credential rotation"
  );
});

test("page delete auth rotation cannot fall through into local draft cleanup", async () => {
  const deleteClient = section(
    client,
    "async function deleteNavigationTarget()",
    "function renderCollectionView"
  );
  const submitIndex = deleteClient.indexOf("submitPageDeleteTask(task, authenticationScope, {");
  const completionFenceIndex = deleteClient.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return;",
    submitIndex
  );
  const cleanupIndex = deleteClient.indexOf("pageDraftStore.removePages", submitIndex);
  assert.ok(submitIndex >= 0, "page delete must submit through the auth-scoped task");
  assert.ok(
    completionFenceIndex > submitIndex && completionFenceIndex < cleanupIndex,
    "authentication must be revalidated after submit and before local draft cleanup"
  );

  async function reproduce({ fixed }) {
    let currentAuthenticationScope = true;
    let serverDeleteRequests = 0;
    let localDraftPresent = true;

    const submit = async () => {
      if (!currentAuthenticationScope) return null;
      serverDeleteRequests += 1;
      return null;
    };

    // A same-account credential rotation can increment the authentication
    // generation while the destructive transition is waiting on its barriers.
    currentAuthenticationScope = false;
    await submit();
    if (fixed && !currentAuthenticationScope) {
      return { serverDeleteRequests, localDraftPresent };
    }
    localDraftPresent = false;
    return { serverDeleteRequests, localDraftPresent };
  }

  assert.deepEqual(
    await reproduce({ fixed: false }),
    { serverDeleteRequests: 0, localDraftPresent: false },
    "the vulnerable ordering erases recovery even though no delete request was sent"
  );
  assert.deepEqual(
    await reproduce({ fixed: true }),
    { serverDeleteRequests: 0, localDraftPresent: true },
    "the completion fence preserves recovery when authentication supersedes the delete"
  );
});

test("baseline and upgrade schemas keep page-delete receipts after page rows are gone", () => {
  for (const sql of [baselineSchema, migration]) {
    const start = sql.indexOf("CREATE TABLE IF NOT EXISTS page_delete_mutations");
    assert.notEqual(start, -1, "page_delete_mutations table must exist");
    const end = sql.indexOf(";", start);
    assert.notEqual(end, -1, "page_delete_mutations DDL must terminate");
    const tableSql = sql.slice(start, end + 1);

    assert.match(tableSql, /PRIMARY KEY \(actor_id, mutation_id\)/);
    assert.match(tableSql, /page_ids JSON NOT NULL/);
    assert.match(tableSql, /attachment_ids JSON NOT NULL/);
    assert.doesNotMatch(tableSql, /FOREIGN KEY \(page_id\)/);
  }

  assert.match(
    attachmentGenerationMigration,
    /ALTER TABLE page_delete_mutations[\s\S]*attachment_generation BIGINT UNSIGNED NULL/
  );
});

test("response-loss reproduction shows vulnerable 404 and fixed receipt replay", () => {
  const output = execFileSync(
    process.execPath,
    [new URL("../scripts/reproduce-page-delete-response-loss.mjs", import.meta.url).pathname],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);
  assert.equal(result.vulnerable.pageDeleted, true);
  assert.equal(result.vulnerable.retryAcknowledged, false);
  assert.equal(result.fixed.retryAcknowledged, true);
  assert.equal(result.fixed.relationalDeleteRepeated, false);
});
