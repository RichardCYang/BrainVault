import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("block deletion is page-scoped and fails closed before recording success", () => {
  const deleteRoute = section(
    route,
    'blockRouter.delete(\n  "/blocks/:blockId"',
    'blockRouter.post(\n  "/pages/:pageId/blocks/reorder"'
  );

  const deleteIndex = deleteRoute.indexOf(
    '"DELETE FROM blocks WHERE id = ? AND page_id = ?"'
  );
  const affectedRowsGuardIndex = deleteRoute.indexOf(
    "Number(deleteResult.affectedRows) !== 1",
    deleteIndex
  );
  const versionAdvanceIndex = deleteRoute.indexOf(
    "advancePageContentVersion",
    deleteIndex
  );
  const receiptInsertIndex = deleteRoute.indexOf(
    "INSERT INTO block_delete_mutations",
    deleteIndex
  );

  assert.ok(deleteIndex >= 0, "destructive block delete must be scoped to its locked page");
  assert.match(
    deleteRoute.slice(deleteIndex, affectedRowsGuardIndex),
    /\[blockId, block\.page_id\]/
  );
  assert.ok(
    affectedRowsGuardIndex > deleteIndex,
    "delete must verify exactly one target row was removed"
  );
  assert.match(
    deleteRoute.slice(affectedRowsGuardIndex, versionAdvanceIndex),
    /BLOCK_EDIT_CONFLICT/
  );
  assert.ok(
    versionAdvanceIndex > affectedRowsGuardIndex,
    "page version must not advance when the target row was not deleted"
  );
  assert.ok(
    receiptInsertIndex > affectedRowsGuardIndex,
    "a failed delete must not create an idempotency success receipt"
  );
});

test("the final delete sink does not retain the old id-only destructive statement", () => {
  const deleteRoute = section(
    route,
    'blockRouter.delete(\n  "/blocks/:blockId"',
    'blockRouter.post(\n  "/pages/:pageId/blocks/reorder"'
  );

  assert.doesNotMatch(
    deleteRoute,
    /DELETE FROM blocks WHERE id = \?(?=["`])/
  );
});
