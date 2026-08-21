import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");

test("deferred attachment cleanup is fenced from workspace restore generations", async () => {
  const [attachments, transfer, pageRoute, blockRoute, collaborationRoute, migration] =
    await Promise.all([
      readFile(new URL("../src/lib/attachments.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8"),
      readFile(new URL("../migrations/060_attachment_storage_generation.sql", import.meta.url), "utf8")
    ]).then((values) => values.map(normalize));

  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS attachment_generation BIGINT UNSIGNED NOT NULL DEFAULT 1/i
  );
  assert.doesNotMatch(
    migration,
    /(?:^|\n)\s*(?:DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE|UPDATE\s+users)\b/im
  );

  assert.match(
    transfer,
    /attachment_generation\s*=\s*attachment_generation\s*\+\s*1/
  );

  assert.match(
    attachments,
    /SELECT id, attachment_generation FROM users WHERE id = \? FOR UPDATE/
  );
  const generationFenceIndex = attachments.indexOf(
    "if (currentAttachmentGeneration !== expectedAttachmentGeneration) return;"
  );
  const removeFilesIndex = attachments.indexOf(
    "await removeAttachmentFiles(ownerId",
    generationFenceIndex
  );
  assert.ok(
    generationFenceIndex >= 0 && removeFilesIndex > generationFenceIndex,
    "generation mismatch must stop cleanup before filesystem deletion"
  );

  for (const [name, source] of [
    ["page delete", pageRoute],
    ["block delete", blockRoute],
    ["collaboration materialization", collaborationRoute]
  ]) {
    assert.match(
      source,
      /removeDeletedAttachmentFiles\([\s\S]*?attachmentGeneration[\s\S]*?\)/,
      `${name} must pass the generation captured by its destructive transaction`
    );
  }

  const uploadRouteIndex = blockRoute.indexOf('"/pages/:pageId/attachments"');
  const uploadGenerationCaptureIndex = blockRoute.indexOf(
    "lockUserAttachmentGeneration(client, ownerId)",
    uploadRouteIndex
  );
  const uploadMoveIndex = blockRoute.indexOf(
    "movedPath = await moveAttachmentFile(file.path, ownerId, id)",
    uploadRouteIndex
  );
  const uploadRollbackFenceIndex = blockRoute.indexOf(
    "currentAttachmentGeneration !== expectedAttachmentGeneration",
    uploadMoveIndex
  );
  const uploadRollbackRemoveIndex = blockRoute.indexOf(
    "await removeAttachmentPath(failedMovedPath)",
    uploadRollbackFenceIndex
  );
  assert.ok(
    uploadGenerationCaptureIndex > uploadRouteIndex
      && uploadGenerationCaptureIndex < uploadMoveIndex
      && uploadRollbackFenceIndex > uploadMoveIndex
      && uploadRollbackRemoveIndex > uploadRollbackFenceIndex,
    "failed upload rollback must not delete an attachment path from a restored generation"
  );

  const blockTransactionIndex = blockRoute.indexOf("const deletion = await transaction(async (client) => {");
  const blockGenerationIndex = blockRoute.indexOf(
    "lockUserAttachmentGeneration(client, user.id)",
    blockTransactionIndex
  );
  const blockPageLockIndex = blockRoute.indexOf(
    "getPageAccess(block.page_id, user.id, client, { lockPage: true })",
    blockTransactionIndex
  );
  assert.ok(
    blockGenerationIndex > blockTransactionIndex && blockGenerationIndex < blockPageLockIndex,
    "block deletion must preserve the user-before-page lock order used by restore"
  );

  const collabTransactionIndex = collaborationRoute.indexOf(
    "const result = await transaction(async (client) => {",
    collaborationRoute.indexOf('"/pages/:pageId/collaboration/snapshot"')
  );
  const collabGenerationIndex = collaborationRoute.indexOf(
    "lockUserAttachmentGeneration(client, attachmentOwnerId)",
    collabTransactionIndex
  );
  const collabPageLockIndex = collaborationRoute.indexOf(
    "getPageAccess(pageId, user.id, client, { lockPage: true })",
    collabTransactionIndex
  );
  assert.ok(
    collabGenerationIndex > collabTransactionIndex && collabGenerationIndex < collabPageLockIndex,
    "collaboration cleanup authorization must lock the owner before the page"
  );
});

test("delete receipt replay keeps the original attachment generation across workspace restores", async () => {
  const [pageRoute, blockRoute, receiptMigration] = await Promise.all([
    readFile(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8"),
    readFile(new URL("../migrations/062_delete_receipt_attachment_generation.sql", import.meta.url), "utf8")
  ]).then((values) => values.map(normalize));

  for (const [name, source] of [
    ["page delete", pageRoute],
    ["block delete", blockRoute]
  ]) {
    assert.match(
      source,
      /attachmentGeneration: assessment\.attachmentGeneration/,
      `${name} receipt replay must reuse the generation captured by the original delete`
    );
    assert.match(
      source,
      /deletion\.attachmentGeneration !== undefined/,
      `${name} must skip filesystem cleanup for legacy receipts with no trustworthy generation`
    );
  }

  assert.match(
    receiptMigration,
    /ALTER TABLE page_delete_mutations[\s\S]*attachment_generation BIGINT UNSIGNED NULL/
  );
  assert.match(
    receiptMigration,
    /ALTER TABLE block_delete_mutations[\s\S]*attachment_generation BIGINT UNSIGNED NULL/
  );

  const cleanupAuthorized = (receiptGeneration, currentGeneration) =>
    receiptGeneration !== undefined && receiptGeneration === currentGeneration;

  const originalGeneration = 4;
  const restoredGeneration = 5;
  assert.equal(cleanupAuthorized(restoredGeneration, restoredGeneration), true);
  assert.equal(cleanupAuthorized(originalGeneration, restoredGeneration), false);
  assert.equal(cleanupAuthorized(undefined, restoredGeneration), false);
});

test("standalone reproduction loses a retained restore file before the fence but not after it", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-attachment-cleanup-restore-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);

  assert.equal(result.vulnerability.oldCleanupDeletesRestoredRetainedAttachment, true);
  assert.equal(result.vulnerability.failedUploadRollbackDeletesRestoredRetainedAttachment, true);
  assert.equal(result.fixed.restoreAdvancesAttachmentGeneration, true);
  assert.equal(result.fixed.staleCleanupSkipsNewGeneration, true);
  assert.equal(result.fixed.failedUploadRollbackSkipsNewGeneration, true);
  assert.equal(result.fixed.sameGenerationCleanupStillRemovesDeletedAttachment, true);
  assert.equal(result.fixed.sameGenerationCleanupStillPreservesLiveAttachment, true);
});
