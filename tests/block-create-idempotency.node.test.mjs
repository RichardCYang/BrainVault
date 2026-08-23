import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assessBlockCreateMutationReceipt } from "../src/lib/block-create-mutation.ts";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("block creation receipt assessment distinguishes replay and collision", () => {
  const receipt = { page_id: "page_1", block_id: "block_1", request_hash: "hash_1" };
  assert.deepEqual(
    assessBlockCreateMutationReceipt(receipt, { pageId: "page_1", requestHash: "hash_1" }),
    { kind: "replay", blockId: "block_1" }
  );
  assert.deepEqual(
    assessBlockCreateMutationReceipt(receipt, { pageId: "page_2", requestHash: "hash_1" }),
    { kind: "collision" }
  );
  assert.deepEqual(
    assessBlockCreateMutationReceipt(receipt, { pageId: "page_1", requestHash: "hash_2" }),
    { kind: "collision" }
  );
  assert.deepEqual(
    assessBlockCreateMutationReceipt(null, { pageId: "page_1", requestHash: "hash_1" }),
    { kind: "new" }
  );
});

test("ordinary and attachment creates reserve a receipt before durable side effects", () => {
  const route = read("../src/routes/block.routes.ts");
  const ordinary = route.slice(
    route.indexOf('blockRouter.post("/pages/:pageId/blocks"'),
    route.indexOf('blockRouter.patch("/blocks/:blockId"')
  );
  const attachment = route.slice(
    route.indexOf('"/pages/:pageId/attachments"'),
    route.indexOf('blockRouter.get("/blocks/:blockId/attachment"')
  );

  assert.match(route, /INSERT INTO block_create_mutations/);
  assert.match(route, /assessBlockCreateMutationReceipt/);
  assert.match(ordinary, /createMutationRequestHash\(\{ kind: "BLOCK", pageId, basePageContentVersion, creation \}\)/);
  assert.ok(ordinary.indexOf("reserveBlockCreateMutation") < ordinary.indexOf("assertDirectBlockMutationAllowed"));
  assert.ok(ordinary.indexOf("reserveBlockCreateMutation") < ordinary.indexOf("INSERT INTO blocks"));
  assert.match(attachment, /kind: "ATTACHMENT"/);
  assert.match(attachment, /sha256: fileHash/);
  assert.ok(attachment.indexOf("reserveBlockCreateMutation") < attachment.indexOf("ensureCollaborationState"));
  assert.ok(attachment.indexOf("reserveBlockCreateMutation") < attachment.indexOf("moveAttachmentFile"));
  assert.ok(attachment.indexOf("reserveBlockCreateMutation") < attachment.indexOf("INSERT INTO blocks"));
  assert.match(attachment, /if \(cleanupPath\)[\s\S]*removeAttachmentPath\(cleanupPath\)/);
  assert.match(route, /BLOCK_CREATE_REPLAY_UNAVAILABLE/);
});

test("browser retries ambiguous create responses with the same mutation id and fences auth changes", () => {
  const client = read("../public/app.js");
  const ordinary = client.slice(
    client.indexOf("function getBlockCreateTask"),
    client.indexOf("async function insertBlockRelative")
  );
  const attachment = client.slice(
    client.indexOf("function getAttachmentCreateTask"),
    client.indexOf("function requestAttachmentUpload")
  );

  assert.match(ordinary, /const pendingTask = pendingBlockCreateTasks\.get\(taskKey\)/);
  assert.match(ordinary, /pendingTask && !pendingTask\.inFlight/);
  assert.equal((ordinary.match(/pendingBlockCreateTasks\.set/g) ?? []).length, 2);
  assert.match(
    ordinary,
    /if \(requestGuard\?\.\(\) === false\) \{\s*pendingBlockCreateTasks\.set\(task\.taskKey, task\);\s*return skippedApiRequest;/
  );
  assert.match(
    ordinary,
    /isAmbiguousApiError\(error\)[\s\S]*pendingBlockCreateTasks\.set\(task\.taskKey, task\)/
  );
  assert.match(ordinary, /basePageContentVersion: task\.basePageContentVersion/);
  assert.match(ordinary, /mutationId: task\.mutationId/);
  assert.match(ordinary, /attempt < 2/);
  assert.match(ordinary, /isCurrentAuthenticatedSessionScope\(authenticationScope\)/);
  assert.match(attachment, /formData\.set\("basePageContentVersion", String\(task\.basePageContentVersion\)\)/);
  assert.match(attachment, /formData\.set\("mutationId", task\.mutationId\)/);
  assert.match(attachment, /submitWithFreshMutationIdOnReuse/);
  assert.match(attachment, /pendingAttachmentCreateTasks\.get\(taskKey\)/);
  assert.match(attachment, /pendingTask && !pendingTask\.inFlight/);
  assert.equal((attachment.match(/pendingAttachmentCreateTasks\.set/g) ?? []).length, 1);
  assert.match(client, /pendingBlockCreateTasks\.clear\(\)/);
  assert.match(client, /pendingAttachmentCreateTasks\.clear\(\)/);
});

test("block creation receipts remain actor-scoped across page recreation", () => {
  for (const relative of ["../migrations/001_init.sql", "../migrations/038_block_create_mutation_receipts.sql"]) {
    const migration = read(relative);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS block_create_mutations/);
    assert.match(migration, /PRIMARY KEY \(actor_id, mutation_id\)/);
    assert.match(migration, /FOREIGN KEY \(actor_id\) REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.doesNotMatch(migration, /fk_block_create_mutations_page/);
  }
  assert.match(
    read("../migrations/059_mutation_receipts_survive_page_recreation.sql"),
    /DROP FOREIGN KEY fk_block_create_mutations_page/
  );
});

test("response-loss reproduction proves duplicate legacy writes and one fixed write", () => {
  const output = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-block-create-response-loss.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));
  assert.equal(output.vulnerable.ordinaryBlockCountAfterLostResponseRetry, 2);
  assert.equal(output.vulnerable.attachmentBlockCountAfterLostResponseRetry, 2);
  assert.equal(output.vulnerable.attachmentFileCountAfterLostResponseRetry, 2);
  assert.equal(output.fixed.ordinaryBlockCountAfterLostResponseRetry, 1);
  assert.equal(output.fixed.attachmentBlockCountAfterLostResponseRetry, 1);
  assert.equal(output.fixed.attachmentFileCountAfterLostResponseRetry, 1);
  assert.equal(output.fixed.ordinaryReplayReturnedOriginalId, true);
  assert.equal(output.fixed.attachmentReplayReturnedOriginalId, true);
  assert.equal(output.fixed.changedPayloadCollisionRejected, true);
});
