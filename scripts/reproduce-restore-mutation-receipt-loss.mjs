import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalize = (value) => value.replace(/\r\n/g, "\n");
const currentTransfer = normalize(readFileSync(path.join(projectRoot, "src/lib/data-transfer.ts"), "utf8"));
const baselineTransfer = normalize(execFileSync(
  "git",
  ["show", "HEAD:src/lib/data-transfer.ts"],
  { cwd: projectRoot, encoding: "utf8" }
));
const baselineSchema = normalize(readFileSync(path.join(projectRoot, "migrations/001_init.sql"), "utf8"));

const pageId = "pag_restore";
const ownerId = "usr_owner";
const resetMutationId = "mut_reset_response_lost";
const createMutationId = "mut_create_response_lost";
const createdBlockId = "blk_original";
const restoredAttachmentId = "att_restored";
const oldDeleteExpectedVersion = 42;
const restoreVersion = 9_000_000;

function restoreWithCascade({ preserveReceipts }) {
  const preserved = preserveReceipts
    ? {
        pageVersionReset: {
          ownerId,
          mutationId: resetMutationId,
          pageId,
          requestHash: "reset-hash",
          revision: 1,
          deletedCount: 7
        },
        blockCreate: {
          actorId: ownerId,
          mutationId: createMutationId,
          pageId,
          blockId: createdBlockId,
          requestHash: "create-hash"
        }
      }
    : { pageVersionReset: null, blockCreate: null };

  // DELETE FROM pages cascades all page-tied receipts. The backup then recreates
  // the page, its version history, and the original created block.
  const state = {
    pages: [pageId],
    pageVersions: [1, 2, 3, 4],
    blocks: [createdBlockId],
    pageVersionResetReceipt: preserveReceipts ? preserved.pageVersionReset : null,
    blockCreateReceipt: preserveReceipts ? preserved.blockCreate : null
  };
  return state;
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

const baselineAfterResetRetry = retryPageVersionReset(restoreWithCascade({ preserveReceipts: false }));
const fixedAfterResetRetry = retryPageVersionReset(restoreWithCascade({ preserveReceipts: true }));
const baselineAfterCreateRetry = retryBlockCreate(restoreWithCascade({ preserveReceipts: false }));
const fixedAfterCreateRetry = retryBlockCreate(restoreWithCascade({ preserveReceipts: true }));
const fixedMissingOriginalBlock = retryBlockCreate({
  ...restoreWithCascade({ preserveReceipts: true }),
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
    // removeDeletedAttachmentFiles() outside the transaction. That is correct in
    // one generation but destructive if a restore resurrected this file ID.
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
    baselineHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(),
    pageVersionResetReceiptCascadesWithPage: /CREATE TABLE IF NOT EXISTS page_version_reset_mutations[\s\S]*?FOREIGN KEY \(page_id\) REFERENCES pages\(id\) ON DELETE CASCADE/.test(baselineSchema),
    blockCreateReceiptCascadesWithPage: /CREATE TABLE IF NOT EXISTS block_create_mutations[\s\S]*?FOREIGN KEY \(page_id\) REFERENCES pages\(id\) ON DELETE CASCADE/.test(baselineSchema),
    blockDeleteReceiptCascadesWithPage: /CREATE TABLE IF NOT EXISTS block_delete_mutations[\s\S]*?FOREIGN KEY \(page_id\) REFERENCES pages\(id\) ON DELETE CASCADE/.test(baselineSchema),
    restoreDeletesOwnedPages: baselineTransfer.includes('DELETE FROM pages WHERE owner_id = ?'),
    baselineDidNotPreservePageTiedReceipts: !baselineTransfer.includes("prepareRestoreMutationReceiptPlan"),
    delayedResetRetryDeletesRestoredHistory: baselineAfterResetRetry.state.pageVersions.length === 1,
    delayedCreateRetryDuplicatesRestoredBlock: baselineAfterCreateRetry.state.blocks.length === 2
  },
  fixed: {
    capturesPageVersionResetReceipts: currentTransfer.includes("FROM page_version_reset_mutations m"),
    capturesBlockOrderReceipts: currentTransfer.includes("FROM block_order_mutations m"),
    capturesBlockCreateReceipts: currentTransfer.includes("FROM block_create_mutations m"),
    deliberatelyDoesNotPreserveBlockDeleteReceipts: !currentTransfer.includes("FROM block_delete_mutations m")
      && !currentTransfer.includes("mutationReceipts.blockDeletes"),
    locksReceiptRows: (currentTransfer.match(/FOR UPDATE/g) ?? []).length > (baselineTransfer.match(/FOR UPDATE/g) ?? []).length,
    filtersReceiptsToRestoredPageIds: currentTransfer.includes("restoredPageIds.has(row.page_id)"),
    snapshotsBeforeDestructiveImport: currentTransfer.indexOf("restoreMutationReceipts = await prepareRestoreMutationReceiptPlan")
      < currentTransfer.indexOf("await importRows(", currentTransfer.indexOf("restoreMutationReceipts = await prepareRestoreMutationReceiptPlan")),
    reinsertsPageVersionResetReceipts: currentTransfer.includes("INSERT INTO page_version_reset_mutations"),
    reinsertsBlockOrderReceipts: currentTransfer.includes("INSERT INTO block_order_mutations"),
    reinsertsBlockCreateReceipts: currentTransfer.includes("INSERT INTO block_create_mutations"),
    restoreBumpsBlockEditVersions: currentTransfer.includes("block.metadata, restoreVersion, block.created_at"),
    preservingDeleteReceiptWouldDeleteRestoredAttachment: unsafePreservedDeleteRetry.replayed
      && !unsafePreservedDeleteRetry.state.files.has(restoredAttachmentId),
    staleDeleteRetryConflictsWithoutTouchingRestoredAttachment: fixedDeleteRetry.conflicted
      && fixedDeleteRetry.state.files.has(restoredAttachmentId),
    delayedResetRetryReplaysWithoutDeletingRestoredHistory: fixedAfterResetRetry.replayed
      && fixedAfterResetRetry.state.pageVersions.length === 4,
    delayedCreateRetryReplaysWithoutDuplicate: fixedAfterCreateRetry.replayed
      && fixedAfterCreateRetry.state.blocks.length === 1,
    createReceiptTombstoneBlocksResurrectionWhenBackupOmitsOriginalBlock: fixedMissingOriginalBlock.rejectedAsUnavailable
      && fixedMissingOriginalBlock.state.blocks.length === 0
  }
};

for (const [name, value] of Object.entries(result.vulnerability)) {
  if (name === "baselineHead") continue;
  assert.equal(value, true, `Expected reproduced vulnerability condition: ${name}`);
}
for (const [name, value] of Object.entries(result.fixed)) {
  assert.equal(value, true, `Expected fixed condition: ${name}`);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
