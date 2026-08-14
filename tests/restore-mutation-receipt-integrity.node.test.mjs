import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");

test("workspace restore preserves page-tied mutation receipts for surviving page identities", async () => {
  const transfer = normalize(await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"));

  assert.match(transfer, /async function prepareRestoreMutationReceiptPlan/);
  for (const table of [
    "page_version_reset_mutations",
    "block_order_mutations",
    "block_create_mutations"
  ]) {
    assert.match(transfer, new RegExp(`FROM ${table} m[\\s\\S]*?INNER JOIN pages p ON p\\.id = m\\.page_id[\\s\\S]*?WHERE p\\.owner_id = \\?[\\s\\S]*?FOR UPDATE`));
    assert.match(transfer, new RegExp(`INSERT INTO ${table}`));
  }
  assert.match(transfer, /restoredPageIds\.has\(row\.page_id\)/);
  assert.doesNotMatch(transfer, /FROM block_delete_mutations m/);
  assert.doesNotMatch(transfer, /mutationReceipts\.blockDeletes/);
  assert.match(transfer, /block\.metadata, restoreVersion, block\.created_at/);

  const captureIndex = transfer.indexOf("restoreMutationReceipts = await prepareRestoreMutationReceiptPlan");
  const importIndex = transfer.indexOf("await importRows(", captureIndex);
  assert.ok(captureIndex >= 0 && importIndex > captureIndex, "mutation receipts must be captured before page replacement");
});

test("standalone reproduction proves stale retries cross the restore boundary before the fix but not after it", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-restore-mutation-receipt-loss.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "")
      }
    }
  );
  const result = JSON.parse(output);
  assert.equal(result.vulnerability.delayedResetRetryDeletesRestoredHistory, true);
  assert.equal(result.vulnerability.delayedCreateRetryDuplicatesRestoredBlock, true);
  assert.equal(result.fixed.delayedResetRetryReplaysWithoutDeletingRestoredHistory, true);
  assert.equal(result.fixed.delayedCreateRetryReplaysWithoutDuplicate, true);
  assert.equal(result.fixed.createReceiptTombstoneBlocksResurrectionWhenBackupOmitsOriginalBlock, true);
  assert.equal(result.fixed.preservingDeleteReceiptWouldDeleteRestoredAttachment, true);
  assert.equal(result.fixed.staleDeleteRetryConflictsWithoutTouchingRestoredAttachment, true);
});
