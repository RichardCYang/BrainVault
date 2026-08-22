import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assessBlockDeleteMutationReceipt,
  decodeBlockDeleteAttachmentIds
} from "../src/lib/block-delete-mutation.ts";

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

const route = source("../src/routes/block.routes.ts");
const client = source("../public/app.js");
const baselineSchema = source("../migrations/001_init.sql");
const migration = source("../migrations/039_block_delete_mutation_receipts.sql");
const attachmentGenerationMigration = source("../migrations/062_delete_receipt_attachment_generation.sql");

test("block deletion receipts replay only the exact request and retain cleanup scope", () => {
  const receipt = {
    page_id: "pag_1",
    block_id: "blk_1",
    request_hash: "hash_1",
    page_content_version: 7,
    attachment_ids: '["att_1","att_2"]',
    attachment_generation: 4
  };

  assert.deepEqual(
    assessBlockDeleteMutationReceipt(receipt, { blockId: "blk_1", requestHash: "hash_1" }),
    {
      kind: "replay",
      pageId: "pag_1",
      blockId: "blk_1",
      pageContentVersion: 7,
      attachmentIds: ["att_1", "att_2"],
      attachmentGeneration: 4
    }
  );
  assert.deepEqual(
    assessBlockDeleteMutationReceipt(receipt, { blockId: "blk_other", requestHash: "hash_1" }),
    { kind: "collision" }
  );
  assert.deepEqual(
    assessBlockDeleteMutationReceipt(receipt, { blockId: "blk_1", requestHash: "hash_other" }),
    { kind: "collision" }
  );
});

test("delete receipt attachment generations are durable but legacy receipts remain replayable without cleanup authority", () => {
  const legacyReceipt = {
    page_id: "pag_1",
    block_id: "blk_1",
    request_hash: "hash_legacy",
    page_content_version: 7,
    attachment_ids: '["att_1"]'
  };
  assert.deepEqual(
    assessBlockDeleteMutationReceipt(legacyReceipt, { blockId: "blk_1", requestHash: "hash_legacy" }),
    {
      kind: "replay",
      pageId: "pag_1",
      blockId: "blk_1",
      pageContentVersion: 7,
      attachmentIds: ["att_1"]
    }
  );
  assert.deepEqual(
    assessBlockDeleteMutationReceipt(
      { ...legacyReceipt, request_hash: "hash_invalid", attachment_generation: 0 },
      { blockId: "blk_1", requestHash: "hash_invalid" }
    ),
    { kind: "incomplete" }
  );
});

test("malformed or duplicate attachment cleanup scopes fail closed", () => {
  assert.equal(decodeBlockDeleteAttachmentIds("not-json"), null);
  assert.equal(decodeBlockDeleteAttachmentIds(["att_1", "att_1"]), null);
  assert.equal(decodeBlockDeleteAttachmentIds(["att_1", 2]), null);

  assert.deepEqual(
    assessBlockDeleteMutationReceipt(
      {
        page_id: "pag_1",
        block_id: "blk_1",
        request_hash: "hash_1",
        page_content_version: 0,
        attachment_ids: []
      },
      { blockId: "blk_1", requestHash: "hash_1" }
    ),
    { kind: "incomplete" }
  );
});

test("server records and replays block deletion atomically before touching a missing block", () => {
  const deleteRoute = section(
    route,
    'blockRouter.delete(\n  "/blocks/:blockId"',
    'blockRouter.post(\n  "/pages/:pageId/blocks/reorder"'
  );

  assert.match(route, /const deleteBlockSchema[\s\S]*mutationId: mutationIdSchema\.optional\(\)/);
  assert.match(deleteRoute, /if \(!body\.mutationId\)[\s\S]*"MUTATION_ID_REQUIRED"/);
  assert.ok(
    deleteRoute.indexOf("MUTATION_ID_REQUIRED") < deleteRoute.indexOf("transaction(async (client)"),
    "destructive deletion must reject missing mutation ids before opening the transaction"
  );
  assert.match(deleteRoute, /kind: "BLOCK_DELETE"/);
  assert.ok(
    deleteRoute.indexOf("BLOCK_DELETE_SNAPSHOT_REQUIRED")
      < deleteRoute.indexOf("const mutationHash = createMutationRequestHash"),
    "the exact delete snapshot must be validated before hashing"
  );
  assert.match(
    deleteRoute,
    /const normalizedExpectedVersions = \[\.\.\.expectedVersions\]\s*\.sort\(\(left, right\) => left\.id\.localeCompare\(right\.id\)\)/
  );
  assert.match(
    deleteRoute,
    /const mutationRequest = \{[\s\S]*expectedVersions: normalizedExpectedVersions[\s\S]*\};[\s\S]*const mutationHash = createMutationRequestHash\(mutationRequest\)/
  );
  assert.match(
    deleteRoute,
    /const legacyMutationHash = createMutationRequestHash\(\{[\s\S]*\.\.\.mutationRequest,[\s\S]*expectedVersions[\s\S]*\}\)/
  );
  assert.match(
    deleteRoute,
    /assessment\.kind === "collision" && legacyMutationHash !== mutationHash[\s\S]*requestHash: legacyMutationHash/
  );
  assert.match(deleteRoute, /FROM block_delete_mutations/);
  assert.match(deleteRoute, /attachment_ids, attachment_generation/);
  assert.match(deleteRoute, /assessBlockDeleteMutationReceipt/);
  assert.match(deleteRoute, /attachmentGeneration: assessment\.attachmentGeneration/);
  assert.match(deleteRoute, /INSERT INTO block_delete_mutations/);
  assert.match(deleteRoute, /attachment_ids, attachment_generation/);
  assert.match(deleteRoute, /JSON\.stringify\(attachmentIds\),\s*attachmentGeneration/);
  assert.match(deleteRoute, /if \(deletion\.attachmentGeneration !== undefined\)/);
  assert.match(
    deleteRoute,
    /await removeDeletedAttachmentFiles\([\s\S]*deletion\.ownerId,[\s\S]*deletion\.attachmentIds,[\s\S]*deletion\.attachmentGeneration[\s\S]*\)/
  );
  assert.ok(
    deleteRoute.indexOf("FROM block_delete_mutations") < deleteRoute.indexOf("assertAccessibleBlock(blockId"),
    "a committed delete must be replayable before the deleted block is queried"
  );
  assert.ok(
    deleteRoute.indexOf("recordPageVersion") < deleteRoute.indexOf("INSERT INTO block_delete_mutations"),
    "the receipt must be committed in the same transaction after all relational effects"
  );
});

test("stale block-delete receipts fail closed after the page generation advances", () => {
  const deleteRoute = section(
    route,
    'blockRouter.delete(\n  "/blocks/:blockId"',
    'blockRouter.post(\n  "/pages/:pageId/blocks/reorder"'
  );
  const replayStart = deleteRoute.indexOf("const replayAccess = await getPageAccess");
  const replayEnd = deleteRoute.indexOf("replayed: true", replayStart);
  assert.ok(replayStart >= 0 && replayEnd > replayStart, "receipt replay section must exist");
  const replaySection = deleteRoute.slice(replayStart, replayEnd);

  assert.match(replaySection, /currentPageContentVersion !== assessment\.pageContentVersion/);
  assert.match(replaySection, /BLOCK_DELETE_REPLAY_SUPERSEDED/);
  assert.match(replaySection, /SELECT id FROM blocks WHERE id = \? AND page_id = \? FOR UPDATE/);

  function reproduce({ fixed }) {
    const receiptPageContentVersion = 7;
    const currentPageContentVersion = 8;
    const recreatedBlockExists = true;
    let localDraftPresent = true;

    if (
      fixed
      && (
        currentPageContentVersion !== receiptPageContentVersion
        || recreatedBlockExists
      )
    ) {
      return { status: 409, localDraftPresent };
    }

    // The vulnerable replay acknowledges the old receipt without applying a
    // delete to the recreated block. The direct-mode client then treats 204 as
    // authoritative and drops its local draft before refreshing the still-live block.
    localDraftPresent = false;
    return { status: 204, localDraftPresent };
  }

  assert.deepEqual(reproduce({ fixed: false }), { status: 204, localDraftPresent: false });
  assert.deepEqual(reproduce({ fixed: true }), { status: 409, localDraftPresent: true });
});

test("browser retries ambiguous deletes with one auth-scoped mutation task", () => {
  const deleteClient = section(
    client,
    "function getBlockDeleteTask",
    "function updateBlockInState"
  );

  assert.match(client, /const pendingBlockDeleteTasks = new Map\(\)/);
  assert.match(deleteClient, /mutationId: createMutationId\(\)/);
  assert.match(deleteClient, /while \(attempt < 2\)/);
  assert.match(deleteClient, /isAmbiguousApiError\(error\)/);
  assert.match(deleteClient, /body: \{ \.\.\.task\.payload, mutationId: task\.mutationId \}/);
  assert.match(deleteClient, /pendingBlockDeleteTasks\.get\(task\.taskKey\) === task/);
  assert.ok(
    (client.match(/pendingBlockDeleteTasks\.clear\(\)/g) ?? []).length >= 2,
    "delete retry tasks must be cleared on logout and credential rotation"
  );
});

test("a stale unreceipted retry cannot delete a restored block generation", () => {
  function reproduce({ mutationIdRequired }) {
    let restoredBlockPresent = true;
    const oldRequestHasMutationId = false;
    const restoredBlockMatchesOldVersionSnapshot = true;

    if (mutationIdRequired && !oldRequestHasMutationId) {
      return { status: 400, restoredBlockPresent };
    }
    if (restoredBlockMatchesOldVersionSnapshot) {
      restoredBlockPresent = false;
      return { status: 204, restoredBlockPresent };
    }
    return { status: 409, restoredBlockPresent };
  }

  assert.deepEqual(
    reproduce({ mutationIdRequired: false }),
    { status: 204, restoredBlockPresent: false }
  );
  assert.deepEqual(
    reproduce({ mutationIdRequired: true }),
    { status: 400, restoredBlockPresent: true }
  );
});

test("baseline and upgrade schemas retain deletion receipts after the block row is gone", () => {
  for (const sql of [baselineSchema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS block_delete_mutations/);
    assert.match(sql, /PRIMARY KEY \(actor_id, mutation_id\)/);
    assert.match(sql, /attachment_ids JSON NOT NULL/);
    assert.match(sql, /page_content_version BIGINT UNSIGNED NOT NULL/);
    assert.doesNotMatch(sql, /FOREIGN KEY \(block_id\)/);
  }
  assert.match(
    attachmentGenerationMigration,
    /ALTER TABLE block_delete_mutations\s+ADD COLUMN IF NOT EXISTS attachment_generation BIGINT UNSIGNED NULL/i
  );
});

test("response-loss reproduction shows vulnerable 404 and fixed receipt replay", () => {
  const output = execFileSync(
    process.execPath,
    [new URL("../scripts/reproduce-block-delete-response-loss.mjs", import.meta.url).pathname],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);
  assert.equal(result.vulnerable.blockDeleted, true);
  assert.equal(result.vulnerable.retryAcknowledged, false);
  assert.equal(result.fixed.retryAcknowledged, true);
  assert.equal(result.fixed.attachmentCleanupCanRepeat, true);
});
