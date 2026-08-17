import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

function section(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertBefore(body, first, second, message) {
  const firstIndex = body.indexOf(first);
  const secondIndex = body.indexOf(second);
  assert.notEqual(firstIndex, -1, `${message}: missing ${first}`);
  assert.notEqual(secondIndex, -1, `${message}: missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${message}: ${first} must precede ${second}`);
}

test("direct block HTTP saves cannot outrun strict browser recovery admission", () => {
  const saveBlock = section("async function saveBlockRow(", "function scheduleBlockSave(");
  assertBefore(
    saveBlock,
    'await requireDirectRecoveryDurability("direct-block-recovery", row, {',
    "const data = await queue.enqueue(task)",
    "block recovery barrier"
  );
  const conflictBarrier = saveBlock.indexOf(
    'await requireDirectRecoveryDurability("direct-block-conflict-recovery", row);'
  );
  assert.notEqual(conflictBarrier, -1, "conflict recovery barrier must exist");
  assert.notEqual(saveBlock.indexOf("return null;", conflictBarrier), -1, "conflict path must return only after the barrier");
});

test("direct title HTTP saves cannot outrun strict browser recovery admission", () => {
  const saveTitle = section("async function savePageTitleNow(", "function schedulePageTitleSave(");
  assertBefore(
    saveTitle,
    'await requireDirectRecoveryDurability("direct-title-recovery", null, {',
    "const data = await pageTitleSaveQueue.enqueue(task)",
    "title recovery barrier"
  );
});

test("application-controlled page flush waits for queued recovery storage writes", () => {
  const flush = section("async function flushPendingPageEdits(", "function applyMaterializedHtmlCaches(");
  assert.match(flush, /await requireDirectRecoveryDurability\("page-edit-flush", null, \{/);
  assert.match(flush, /allowRecoveryFailure: allowLocked && recoveryStorageFailureDrainInFlight/);
  assert.match(flush, /preserveInput: false/);
});

test("recovery durability failures fail closed outside the authoritative server drain", () => {
  const helper = section("async function requireDirectRecoveryDurability(", "function persistPageTitleDraftValue(");
  assert.match(helper, /await recoveryStorage\.flush\?\.\(\)/);
  assert.match(helper, /if \(allowRecoveryFailure\) return false;/);
  assert.match(helper, /admissionError\.code = "DIRECT_RECOVERY_DURABILITY_FAILED";/);
  assert.match(helper, /throw admissionError;/);
});


test("direct edits are hidden until their strict recovery transaction completes", () => {
  const helper = section("function beginDirectRecoveryVisibilityAdmission(", "function persistPageTitleDraftValue(");
  assert.match(helper, /classList\.add\("recovery-admission-pending"\)/);
  assert.match(helper, /direct-title-visible-admission/);
  assert.match(helper, /direct-block-visible-admission/);
  assert.match(helper, /await recoveryStorage\.refresh\?\.\(\)/);

  const markDirty = section("function markBlockDirty(", "function getBlockSaveQueue(");
  assertBefore(markDirty, "beginDirectRecoveryVisibilityAdmission(row)", "persistBlockDraft(row, historyPayload)", "block visibility fence");
  assertBefore(markDirty, "persistBlockDraft(row, historyPayload)", "scheduleDirectBlockRecoveryAdmission(row, recoveryAdmissionSequence)", "block durable admission");

  const title = section("function schedulePageTitleSave(", "function normalizeRecoveredBlockPayload(");
  assertBefore(title, "beginDirectRecoveryVisibilityAdmission(elements.pageTitle)", "persistPageTitleDraftValue(\"\")", "blank-title visibility fence");
  assert.match(
    title,
    /if \(!persistPageTitleDraft\(\)\) \{[\s\S]*?scheduleDirectTitleRecoveryAdmission\(recoveryAdmissionSequence, pageId\);/
  );
  assert.doesNotMatch(title, /removeTitle\(scope\.userId, scope\.pageId/);
});
