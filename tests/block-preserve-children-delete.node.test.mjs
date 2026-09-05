import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { planBlockDeletePreservingChildren } from "../src/lib/block-preserve-children.ts";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertBefore(source, first, second, label) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `${label}: missing ${first}`);
  assert.notEqual(secondIndex, -1, `${label}: missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${label}: ${first} must run before ${second}`);
}

function cloneRows(rows) {
  return rows.map((row) => ({ ...row }));
}

function applyPromotionPlan(rows, targetId) {
  const plan = planBlockDeletePreservingChildren(targetId, rows);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  for (const update of plan.updates) {
    const row = rowById.get(update.id);
    row.parent_block_id = update.parentBlockId;
    row.sort_order = update.sortOrder;
  }
  return plan;
}

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const collaboration = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const route = readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the actual promotion planner proves the former partial-commit window and atomic rollback", () => {
  const initial = [
    { id: "before", parent_block_id: null, sort_order: 0 },
    { id: "target", parent_block_id: null, sort_order: 1 },
    { id: "child", parent_block_id: "target", sort_order: 0 },
    { id: "grandchild", parent_block_id: "child", sort_order: 0 },
    { id: "after", parent_block_id: null, sort_order: 2 }
  ];

  const vulnerable = cloneRows(initial);
  applyPromotionPlan(vulnerable, "target");
  // The following DELETE fails in a separate request, so only the promotion remains committed.
  assert.equal(vulnerable.find((row) => row.id === "target").parent_block_id, null);
  assert.equal(vulnerable.find((row) => row.id === "child").parent_block_id, null);
  assert.notDeepEqual(vulnerable, initial);

  const transactional = cloneRows(initial);
  const before = cloneRows(transactional);
  try {
    const plan = applyPromotionPlan(transactional, "target");
    assert.deepEqual(plan.resultingSiblings.map((row) => row.id), ["before", "child", "after"]);
    throw new Error("simulated delete failure");
  } catch {
    transactional.splice(0, transactional.length, ...before);
  }
  assert.deepEqual(transactional, initial);

  const success = cloneRows(initial);
  applyPromotionPlan(success, "target");
  const afterSuccess = success.filter((row) => row.id !== "target");
  assert.equal(afterSuccess.find((row) => row.id === "grandchild").parent_block_id, "child");
});

test("the UI sends one preserve-children deletion instead of committing a reorder first", () => {
  const emptyDelete = section(client, "async function deleteEmptyBlock", "function focusPendingBlock");
  assert.doesNotMatch(emptyDelete, /persistBlockOrder\(/);
  assert.match(
    emptyDelete,
    /deleteBlockWithVersionCheck\(blockId, \{\s*includeDescendants: false,\s*preserveChildren: true,\s*authenticationScope,\s*navigationGeneration\s*\}\)/
  );

  const deletion = section(client, "async function deleteBlockWithVersionCheck", "function updateBlockInState");
  assert.match(
    deletion,
    /const deleteScope = preserveChildren\s*\? "preserve-children"\s*:\s*\(options\.includeDescendants === false \? "root-only" : "subtree"\)/
  );
  assert.match(deletion, /includeDescendants: deleteScope !== "root-only"/);
  assert.match(deletion, /const preserveChildren = options\.preserveChildren === true/);
  assert.match(deletion, /\n    preserveChildren,\n/);
  assert.match(deletion, /expectedPageContentVersion: Number\(state\.selectedPage\?\.contentVersion \?\? 1\)/);
  assert.match(deletion, /deletedVersions\.map\(\(\{ id \}\) => id\)/);
});

test("the server promotes children and deletes the target inside one locked SQL transaction", () => {
  const deletion = section(
    route,
    "blockRouter.delete(",
    'blockRouter.post(\n  "/pages/:pageId/blocks/reorder"'
  );
  assert.match(route, /planBlockDeletePreservingChildren\(target\.id, hierarchyRows\)/);
  assert.match(route, /preserveChildren: z\.boolean\(\)\.optional\(\)\.default\(false\)/);
  assert.match(route, /expectedPageContentVersion: safeVersionSchema\.optional\(\)/);
  assert.match(deletion, /getPageAccess\(block\.page_id, user\.id, client, \{ lockPage: true, lockAccess: true \}\)/);
  assert.match(deletion, /ORDER BY sort_order ASC, id ASC FOR UPDATE/);
  assert.match(deletion, /Number\(lockedAccess\.page\.content_version \?\? 1\) !== expectedPageContentVersion/);
  assertBefore(
    deletion,
    "await promoteBlockChildrenBeforeDelete",
    '"DELETE FROM blocks WHERE id = ? AND page_id = ?"',
    "atomic preserve-children deletion"
  );
  assertBefore(
    deletion,
    '"DELETE FROM blocks WHERE id = ? AND page_id = ?"',
    "await recordPageVersion",
    "atomic preserve-children deletion"
  );
});

test("collaboration promotes children and deletes their empty parent in one Yjs mutation", () => {
  const deletion = section(collaboration, "  async deleteBlock(blockId", "  adoptAttachment(");
  assert.match(deletion, /promoteChildren = false/);
  assert.match(deletion, /promotedOrder\.splice\(targetIndex, 0, \.\.\.children\)/);
  const mutation = section(deletion, "await this.commitLocalMutation", "return deletedIds;");
  assertBefore(
    mutation,
    "for (const [sortOrder, block] of promotedOrder.entries())",
    "blocks.delete(id)",
    "collaborative promote-and-delete"
  );
});
