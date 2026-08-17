import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");

function tableDefinition(source, tableName) {
  const match = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\([\\s\\S]*?\\n\\) ENGINE=`));
  assert.ok(match, `Missing ${tableName} table definition`);
  return match[0];
}

test("restore keeps reset/create mutation ids as durable tombstones across page recreation", async () => {
  const [transfer, baseline, resetMigration, createMigration, durableMigration] = await Promise.all([
    readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"),
    readFile(new URL("../migrations/001_init.sql", import.meta.url), "utf8"),
    readFile(new URL("../migrations/037_page_version_reset_mutation_receipts.sql", import.meta.url), "utf8"),
    readFile(new URL("../migrations/038_block_create_mutation_receipts.sql", import.meta.url), "utf8"),
    readFile(new URL("../migrations/059_mutation_receipts_survive_page_recreation.sql", import.meta.url), "utf8")
  ]).then((values) => values.map(normalize));

  for (const [source, tableName] of [
    [baseline, "page_version_reset_mutations"],
    [baseline, "block_create_mutations"],
    [resetMigration, "page_version_reset_mutations"],
    [createMigration, "block_create_mutations"]
  ]) {
    assert.doesNotMatch(
      tableDefinition(source, tableName),
      /FOREIGN KEY \(page_id\) REFERENCES pages\(id\)/,
      `${tableName} must survive deletion of the referenced page`
    );
  }

  assert.match(
    tableDefinition(baseline, "page_version_reset_mutations"),
    /FOREIGN KEY \(owner_id\) REFERENCES users\(id\) ON DELETE CASCADE/
  );
  assert.match(
    tableDefinition(baseline, "block_create_mutations"),
    /FOREIGN KEY \(actor_id\) REFERENCES users\(id\) ON DELETE CASCADE/
  );
  assert.match(durableMigration, /DROP FOREIGN KEY fk_page_version_reset_mutations_page/);
  assert.match(durableMigration, /DROP FOREIGN KEY fk_block_create_mutations_page/);

  assert.match(transfer, /async function prepareRestoreMutationReceiptPlan/);
  assert.doesNotMatch(transfer, /FROM page_version_reset_mutations m/);
  assert.doesNotMatch(transfer, /FROM block_create_mutations m/);
  assert.doesNotMatch(transfer, /mutationReceipts\.pageVersionResets/);
  assert.doesNotMatch(transfer, /mutationReceipts\.blockCreates/);

  assert.match(
    transfer,
    /FROM block_order_mutations m[\s\S]*?INNER JOIN pages p ON p\.id = m\.page_id[\s\S]*?WHERE p\.owner_id = \?[\s\S]*?FOR UPDATE/
  );
  assert.match(transfer, /INSERT INTO block_order_mutations/);
  assert.match(transfer, /blockOrders: blockOrders\.filter\(\(row\) => restoredPageIds\.has\(row\.page_id\)\)/);
  assert.doesNotMatch(transfer, /FROM block_delete_mutations m/);
  assert.doesNotMatch(transfer, /mutationReceipts\.blockDeletes/);
  assert.match(transfer, /block\.metadata, restoreVersion, block\.created_at/);

  const captureIndex = transfer.indexOf("restoreMutationReceipts = await prepareRestoreMutationReceiptPlan");
  const importIndex = transfer.indexOf("await importRows(", captureIndex);
  assert.ok(captureIndex >= 0 && importIndex > captureIndex, "page-tied order receipts must be captured before page replacement");
});

test("standalone reproduction proves stale retries cross page deletion plus restore before the fix but not after it", () => {
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
  assert.equal(result.fixed.pageVersionResetReceiptSurvivesPageDeletion, true);
  assert.equal(result.fixed.blockCreateReceiptSurvivesPageDeletion, true);
  assert.equal(result.fixed.delayedResetRetryReplaysWithoutDeletingRestoredHistory, true);
  assert.equal(result.fixed.delayedCreateRetryReplaysWithoutDuplicate, true);
  assert.equal(result.fixed.createReceiptTombstoneBlocksResurrectionWhenBackupOmitsOriginalBlock, true);
  assert.equal(result.fixed.preservingDeleteReceiptWouldDeleteRestoredAttachment, true);
  assert.equal(result.fixed.staleDeleteRetryConflictsWithoutTouchingRestoredAttachment, true);
});
