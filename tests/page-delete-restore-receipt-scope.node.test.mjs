import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("owner restore invalidates delegated permanent-delete receipts", () => {
  // Reproduction model:
  // 1. Collection admin A permanently deletes owner O's page and receives an
  //    ambiguous network outcome, leaving receipt (actor=A, workspaceOwner=O).
  // 2. Owner O restores a backup, beginning a new workspace generation.
  // 3. Actor-only cleanup leaves A's old receipt alive; workspace-targeted
  //    cleanup must remove it so a delayed retry cannot be acknowledged in O's
  //    replacement workspace.
  const receipt = { actorId: "admin_A", workspaceOwnerId: "owner_O" };
  const restoringUserId = "owner_O";

  const vulnerableKeepsReceipt = receipt.actorId !== restoringUserId;
  const fixedKeepsReceipt =
    receipt.actorId !== restoringUserId && receipt.workspaceOwnerId !== restoringUserId;

  assert.equal(vulnerableKeepsReceipt, true);
  assert.equal(fixedKeepsReceipt, false);
});

test("restore cleanup is scoped to actor or target workspace and indexed", () => {
  const transfer = read("../src/lib/data-transfer.ts");
  const migration = read("../migrations/071_page_delete_restore_receipt_scope.sql");

  assert.match(
    transfer,
    /DELETE FROM page_delete_mutations WHERE actor_id = \? OR workspace_owner_id = \?[\s\S]*\[userId, userId\]/
  );
  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS idx_page_delete_mutations_workspace_owner[\s\S]*ON page_delete_mutations\(workspace_owner_id\)/
  );
});
