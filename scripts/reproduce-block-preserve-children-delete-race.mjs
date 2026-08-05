import assert from "node:assert/strict";
import { planBlockDeletePreservingChildren } from "../src/lib/block-preserve-children.ts";

function cloneRows(rows) {
  return rows.map((row) => ({ ...row }));
}

function sortSiblings(rows, parentBlockId) {
  return rows
    .filter((row) => row.parent_block_id === parentBlockId)
    .sort((left, right) => left.sort_order - right.sort_order || left.id.localeCompare(right.id));
}

function applyPromotionPlan(rows, targetId) {
  const plan = planBlockDeletePreservingChildren(targetId, rows);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  for (const update of plan.updates) {
    const row = rowById.get(update.id);
    if (!row) throw new Error(`planned block ${update.id} is missing`);
    row.parent_block_id = update.parentBlockId;
    row.sort_order = update.sortOrder;
  }
}

function vulnerableTwoRequestDelete(rows, targetId) {
  const committed = cloneRows(rows);
  applyPromotionPlan(committed, targetId);
  // The independent DELETE request now fails. The first request cannot roll back.
  return committed;
}

function fixedTransactionalDelete(rows, targetId, { failBeforeDelete = false } = {}) {
  const transactionRows = cloneRows(rows);
  try {
    applyPromotionPlan(transactionRows, targetId);
    if (failBeforeDelete) throw new Error("simulated DELETE failure");
    return transactionRows.filter((row) => row.id !== targetId);
  } catch {
    return cloneRows(rows);
  }
}

const initial = [
  { id: "before", parent_block_id: null, sort_order: 0 },
  { id: "empty-parent", parent_block_id: null, sort_order: 1 },
  { id: "child-a", parent_block_id: "empty-parent", sort_order: 0 },
  { id: "grandchild", parent_block_id: "child-a", sort_order: 0 },
  { id: "child-b", parent_block_id: "empty-parent", sort_order: 1 },
  { id: "after", parent_block_id: null, sort_order: 2 }
];

const vulnerableAfterFailure = vulnerableTwoRequestDelete(initial, "empty-parent");
const fixedAfterFailure = fixedTransactionalDelete(initial, "empty-parent", { failBeforeDelete: true });
const fixedAfterSuccess = fixedTransactionalDelete(initial, "empty-parent");

assert.equal(vulnerableAfterFailure.some((row) => row.id === "empty-parent"), true);
const vulnerableRootRows = sortSiblings(vulnerableAfterFailure, null);
assert.deepEqual(
  new Set(vulnerableRootRows.map((row) => row.id)),
  new Set(["before", "empty-parent", "child-a", "child-b", "after"]),
  "the old flow leaves the undeleted target mixed with already-promoted children"
);
assert.ok(
  vulnerableRootRows.some((row, index) =>
    vulnerableRootRows.some((other, otherIndex) => otherIndex !== index && other.sort_order === row.sort_order)
  ),
  "the partial commit also leaves an ambiguous duplicate sibling sort order"
);
assert.deepEqual(fixedAfterFailure, initial, "a failed atomic deletion must roll back every hierarchy change");
assert.deepEqual(
  sortSiblings(fixedAfterSuccess, null).map((row) => row.id),
  ["before", "child-a", "child-b", "after"]
);
assert.equal(fixedAfterSuccess.some((row) => row.id === "empty-parent"), false);
assert.equal(
  fixedAfterSuccess.find((row) => row.id === "grandchild").parent_block_id,
  "child-a",
  "deeper descendants must remain attached to their immediate preserved parent"
);

console.log(JSON.stringify({
  scenario: "delete an empty parent block while preserving its children",
  vulnerableAfterSecondRequestFailure: vulnerableAfterFailure,
  fixedAfterTransactionFailure: fixedAfterFailure,
  fixedAfterSuccess,
  reproduced: true
}, null, 2));
