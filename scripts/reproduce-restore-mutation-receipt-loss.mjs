import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalize = (value) => value.replace(/\r\n/g, "\n");
const readSource = (relativePath) => normalize(readFileSync(path.join(projectRoot, relativePath), "utf8"));

const currentTransfer = readSource("src/lib/data-transfer.ts");
const baselineSchema = readSource("migrations/001_init.sql");
const resetCreateMigration = readSource("migrations/037_page_version_reset_mutation_receipts.sql");
const blockCreateMigration = readSource("migrations/038_block_create_mutation_receipts.sql");
const durableReceiptMigration = readSource("migrations/059_mutation_receipts_survive_page_recreation.sql");

const tableDefinition = (source, tableName) => {
  const match = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\([\\s\\S]*?\\n\\) ENGINE=`));
  assert.ok(match, `Missing ${tableName} table definition`);
  return match[0];
};

const pageResetTable = tableDefinition(baselineSchema, "page_version_reset_mutations");
const blockCreateTable = tableDefinition(baselineSchema, "block_create_mutations");
const blockDeleteTable = tableDefinition(baselineSchema, "block_delete_mutations");
const resetIncrementalTable = tableDefinition(resetCreateMigration, "page_version_reset_mutations");
const createIncrementalTable = tableDefinition(blockCreateMigration, "block_create_mutations");

const pageId = "pag_restore";
const ownerId = "usr_owner";
const resetMutationId = "mut_reset_response_lost";
const createMutationId = "mut_create_response_lost";
const createdBlockId = "blk_original";
const restoredAttachmentId = "att_restored";
const oldDeleteExpectedVersion = 42;
const restoreVersion = 9_000_000;

function deletePageThenRestore({ durableResetReceipt, durableCreateReceipt }) {
  // The completed operations existed before permanent deletion. Historical page
  // FKs cascaded their receipts away; durable tombstones intentionally survive.
  const resetReceipt = durableResetReceipt
    ? {
        ownerId,
        mutationId: resetMutationId,
        pageId,
        requestHash: "reset-hash",
        revision: 1,
        deletedCount: 7
      }
    : null;
  const createReceipt = durableCreateReceipt
    ? {
        actorId: ownerId,
        mutationId: createMutationId,
        pageId,
        blockId: createdBlockId,
        requestHash: "create-hash"
      }
    : null;

  // A backup recreates the same durable page identity and its user-visible data.
  return {
    pages: [pageId],
    pageVersions: [1, 2, 3, 4],
    blocks: [createdBlockId],
    pageVersionResetReceipt: resetReceipt,
    blockCreateReceipt: createReceipt
  };
}

function retryPageVersionReset(state) {
  if (state.pageVersionResetReceipt?.mutationId === resetMutationId) {
    return { replayed: true, state };
  }
  // Without the receipt the exact old retry is treated as a new destructive reset.
  return {
    replayed: false,
    state: { ...state, pageVersions: [1] }
  };
}

function retryBlockCreate(state) {
  if (state.blockCreateReceipt?.mutationId === createMutationId) {
    const originalStillExists = state.blocks.includes(state.blockCreateReceipt.blockId);
    return {
      replayed: originalStillExists,
      rejectedAsUnavailable: !originalStillExists,
      state
    };
  }
  // Without the receipt the old create intent gets a fresh server-generated ID.
  return {
    replayed: false,
    rejectedAsUnavailable: false,
    state: { ...state, blocks: [...state.blocks, "blk_duplicate_after_restore"] }
  };
}

const historicalAfterDeleteRestore = deletePageThenRestore({
  durableResetReceipt: false,
  durableCreateReceipt: false
});
const fixedAfterDeleteRestore = deletePageThenRestore({
  durableResetReceipt: true,
  durableCreateReceipt: true
});

const baselineAfterResetRetry = retryPageVersionReset(historicalAfterDeleteRestore);
const fixedAfterResetRetry = retryPageVersionReset(fixedAfterDeleteRestore);
const baselineAfterCreateRetry = retryBlockCreate(historicalAfterDeleteRestore);
const fixedAfterCreateRetry = retryBlockCreate(fixedAfterDeleteRestore);
const fixedMissingOriginalBlock = retryBlockCreate({
  ...fixedAfterDeleteRestore,
  blocks: []
});

function retryBlockDeleteAfterRestore({ preserveDeleteReceipt }) {
  const state = {
    block: { id: restoredAttachmentId, editVersion: restoreVersion },
    files: new Set([restoredAttachmentId]),
    receipt: preserveDeleteReceipt
      ? { mutationId: "mut_delete_response_lost", attachmentIds: [restoredAttachmentId] }
      : null
  };
  if (state.receipt) {
    // The real route replays the receipt before version checks and then performs
    // attachment cleanup outside the transaction. Preserving this receipt across
    // a restore generation could delete a file intentionally resurrected by backup.
    for (const id of state.receipt.attachmentIds) state.files.delete(id);
    return { replayed: true, conflicted: false, state };
  }
  if (state.block.editVersion !== oldDeleteExpectedVersion) {
    return { replayed: false, conflicted: true, state };
  }
  state.files.delete(state.block.id);
  return { replayed: false, conflicted: false, state };
}

const unsafePreservedDeleteRetry = retryBlockDeleteAfterRestore({ preserveDeleteReceipt: true });
const fixedDeleteRetry = retryBlockDeleteAfterRestore({ preserveDeleteReceipt: false });

const result = {
  vulnerability: {
    baselineModel: "embedded pre-fix page-delete-before-restore model",
    pageVersionResetReceiptCascadesWithPage: true,
    blockCreateReceiptCascadesWithPage: true,
    blockDeleteReceiptCascadesWithPage:
      /FOREIGN KEY \(page_id\) REFERENCES pages\(id\) ON DELETE CASCADE/.test(blockDeleteTable),
    restoreDeletesOwnedPages: currentTransfer.includes('DELETE FROM pages WHERE owner_id = ?'),
    vulnerableModelDidNotPreservePageTiedReceipts: true,
    delayedResetRetryDeletesRestoredHistory: baselineAfterResetRetry.state.pageVersions.length === 1,
    delayedCreateRetryDuplicatesRestoredBlock: baselineAfterCreateRetry.state.blocks.length === 2
  },
  fixed: {
    pageVersionResetReceiptSurvivesPageDeletion:
      !/FOREIGN KEY \(page_id\) REFERENCES pages\(id\)/.test(pageResetTable)
      && !/FOREIGN KEY \(page_id\) REFERENCES pages\(id\)/.test(resetIncrementalTable),
    blockCreateReceiptSurvivesPageDeletion:
      !/FOREIGN KEY \(page_id\) REFERENCES pages\(id\)/.test(blockCreateTable)
      && !/FOREIGN KEY \(page_id\) REFERENCES pages\(id\)/.test(createIncrementalTable),
    durableReceiptsRemainAccountScoped:
      /FOREIGN KEY \(owner_id\) REFERENCES users\(id\) ON DELETE CASCADE/.test(pageResetTable)
      && /FOREIGN KEY \(actor_id\) REFERENCES users\(id\) ON DELETE CASCADE/.test(blockCreateTable),
    upgradeDropsHistoricalResetPageFk:
      durableReceiptMigration.includes("DROP FOREIGN KEY fk_page_version_reset_mutations_page"),
    upgradeDropsHistoricalCreatePageFk:
      durableReceiptMigration.includes("DROP FOREIGN KEY fk_block_create_mutations_page"),
    restoreLeavesDurableResetAndCreateReceiptsInPlace:
      !currentTransfer.includes("FROM page_version_reset_mutations m")
      && !currentTransfer.includes("FROM block_create_mutations m")
      && !currentTransfer.includes("mutationReceipts.pageVersionResets")
      && !currentTransfer.includes("mutationReceipts.blockCreates"),
    capturesBlockOrderReceipts: currentTransfer.includes("FROM block_order_mutations m"),
    deliberatelyDoesNotPreserveBlockDeleteReceipts:
      !currentTransfer.includes("FROM block_delete_mutations m")
      && !currentTransfer.includes("mutationReceipts.blockDeletes"),
    filtersPageTiedOrderReceiptsToRestoredPageIds:
      currentTransfer.includes("blockOrders: blockOrders.filter((row) => restoredPageIds.has(row.page_id))"),
    snapshotsBeforeDestructiveImport:
      currentTransfer.indexOf("restoreMutationReceipts = await prepareRestoreMutationReceiptPlan")
      < currentTransfer.indexOf(
        "await importRows(",
        currentTransfer.indexOf("restoreMutationReceipts = await prepareRestoreMutationReceiptPlan")
      ),
    reinsertsBlockOrderReceipts: currentTransfer.includes("INSERT INTO block_order_mutations"),
    restoreBumpsBlockEditVersions: currentTransfer.includes("block.metadata, restoreVersion, block.created_at"),
    preservingDeleteReceiptWouldDeleteRestoredAttachment:
      unsafePreservedDeleteRetry.replayed && !unsafePreservedDeleteRetry.state.files.has(restoredAttachmentId),
    staleDeleteRetryConflictsWithoutTouchingRestoredAttachment:
      fixedDeleteRetry.conflicted && fixedDeleteRetry.state.files.has(restoredAttachmentId),
    delayedResetRetryReplaysWithoutDeletingRestoredHistory:
      fixedAfterResetRetry.replayed && fixedAfterResetRetry.state.pageVersions.length === 4,
    delayedCreateRetryReplaysWithoutDuplicate:
      fixedAfterCreateRetry.replayed && fixedAfterCreateRetry.state.blocks.length === 1,
    createReceiptTombstoneBlocksResurrectionWhenBackupOmitsOriginalBlock:
      fixedMissingOriginalBlock.rejectedAsUnavailable && fixedMissingOriginalBlock.state.blocks.length === 0
  }
};

for (const [name, value] of Object.entries(result.vulnerability)) {
  if (name === "baselineModel") continue;
  assert.equal(value, true, `Expected reproduced vulnerability condition: ${name}`);
}
for (const [name, value] of Object.entries(result.fixed)) {
  assert.equal(value, true, `Expected fixed condition: ${name}`);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
