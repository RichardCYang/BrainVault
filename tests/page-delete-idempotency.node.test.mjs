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

test("page deletion receipts replay only the exact request and retain cleanup scope", () => {
  const receipt = {
    page_id: "pag_root",
    request_hash: "hash_1",
    page_ids: '["pag_root","pag_child"]',
    attachment_ids: '["att_1","att_2"]'
  };

  assert.deepEqual(
    assessPageDeleteMutationReceipt(receipt, { pageId: "pag_root", requestHash: "hash_1" }),
    {
      kind: "replay",
      pageId: "pag_root",
      pageIds: ["pag_root", "pag_child"],
      attachmentIds: ["att_1", "att_2"]
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

test("server reconciles a page-delete receipt before querying a page that may already be gone", () => {
  const deleteRoute = section(
    route,
    'pageRouter.delete(\n  "/:pageId"',
    'pageRouter.put("/:pageId/tags"'
  );

  assert.match(deleteRoute, /MUTATION_ID_REQUIRED/);
  assert.match(deleteRoute, /kind: "PAGE_DELETE"/);
  assert.match(deleteRoute, /FROM page_delete_mutations/);
  assert.match(deleteRoute, /assessPageDeleteMutationReceipt/);
  assert.match(deleteRoute, /INSERT INTO page_delete_mutations/);
  assert.match(deleteRoute, /JSON\.stringify\(pageIds\)/);
  assert.match(deleteRoute, /JSON\.stringify\(attachmentIds\)/);
  assert.ok(
    deleteRoute.indexOf("FROM page_delete_mutations") < deleteRoute.indexOf("getOwnedPageTreeRows(user.id"),
    "a committed delete must be replayable before the deleted page tree is queried"
  );
  assert.ok(
    deleteRoute.indexOf("DELETE FROM pages") < deleteRoute.indexOf("INSERT INTO page_delete_mutations"),
    "the receipt must be committed in the same transaction after relational deletion effects"
  );
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
