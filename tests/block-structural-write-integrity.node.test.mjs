import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const blockRoute = fs.readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8");

function vulnerableCreate(rows, id, requestedSortOrder) {
  return [...rows, { id, sortOrder: requestedSortOrder }];
}

function collisionFreeCreate(rows, id, requestedSortOrder) {
  const occupied = rows.some((row) => row.sortOrder === requestedSortOrder);
  const maxSortOrder = rows.reduce((max, row) => Math.max(max, row.sortOrder), -1);
  return [...rows, { id, sortOrder: occupied ? maxSortOrder + 1 : requestedSortOrder }];
}

function hasDuplicateSortOrder(rows) {
  return new Set(rows.map((row) => row.sortOrder)).size !== rows.length;
}

test("reproduction: concurrent sparse creates can strand duplicate sibling positions", () => {
  const initial = [
    { id: "a", sortOrder: 0 },
    { id: "b", sortOrder: 1 }
  ];

  const afterFirst = vulnerableCreate(initial, "from-tab-a", 1);
  const afterSecond = vulnerableCreate(afterFirst, "from-tab-b", 1);
  assert.equal(hasDuplicateSortOrder(afterSecond), true);

  // Once both tabs have created a sibling, each tab's previously captured complete
  // reorder snapshot is stale. The hardened reorder route rejects that snapshot,
  // so creation itself must not have left the canonical rows duplicated.
  const fixedFirst = collisionFreeCreate(initial, "from-tab-a", 1);
  const fixedSecond = collisionFreeCreate(fixedFirst, "from-tab-b", 1);
  assert.equal(hasDuplicateSortOrder(fixedSecond), false);
  assert.deepEqual(fixedSecond.map((row) => row.sortOrder), [0, 1, 2, 3]);
});

test("block and attachment creates use collision-free canonical placement", () => {
  assert.match(blockRoute, /async function getCollisionFreeBlockCreateSortOrder\(/);
  assert.equal((blockRoute.match(/const createSortOrder = await getCollisionFreeBlockCreateSortOrder\(/g) ?? []).length, 2);
  assert.doesNotMatch(blockRoute, /body\.sortOrder \?\? getNextBlockSortOrder/);
  assert.doesNotMatch(blockRoute, /creation\.sortOrder \?\? getNextBlockSortOrder/);
});

test("sparse hierarchy PATCH writes are fenced by page generation and sibling occupancy", () => {
  assert.match(blockRoute, /BLOCK_HIERARCHY_VERSION_REQUIRED/);
  assert.match(blockRoute, /basePageContentVersion !== lockedContentVersion/);
  assert.match(blockRoute, /row\.parent_block_id === nextParentBlockId/);
  assert.match(blockRoute, /Number\(row\.sort_order\) === nextSortOrder/);
  assert.match(blockRoute, /Use the reorder endpoint with the complete sibling list/);
});
