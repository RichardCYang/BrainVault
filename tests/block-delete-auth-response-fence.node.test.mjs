import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const appUrl = new URL("../public/app.js", import.meta.url);

test("block delete response application stays fenced to the initiating authentication generation", async () => {
  const source = await readFile(appUrl, "utf8");

  const submitStart = source.indexOf("async function submitBlockDeleteTask");
  const moveTaskStart = source.indexOf("function getBlockMoveTask", submitStart);
  const deleteStart = source.indexOf("async function deleteBlockWithVersionCheck");
  const updateStart = source.indexOf("function updateBlockInState", deleteStart);
  assert.ok(submitStart >= 0 && moveTaskStart > submitStart);
  assert.ok(deleteStart >= 0 && updateStart > deleteStart);

  const submit = source.slice(submitStart, moveTaskStart);
  const remove = source.slice(deleteStart, updateStart);
  const responseFence =
    "if (data === null || !isCurrentAuthenticatedSessionScope(authenticationScope)) return null;";

  const submitResponseIndex = submit.indexOf("const data = await submitWithFreshMutationIdOnReuse");
  const submitFenceIndex = submit.indexOf(responseFence, submitResponseIndex);
  const submitTaskCleanupIndex = submit.indexOf("pendingBlockDeleteTasks.delete", submitResponseIndex);
  assert.ok(
    submitResponseIndex >= 0
      && submitFenceIndex > submitResponseIndex
      && submitTaskCleanupIndex > submitFenceIndex,
    "a completed block-delete response must be rejected after auth rotation before its retry task is acknowledged"
  );

  const deleteResponseIndex = remove.indexOf(
    "const data = await submitBlockDeleteTask(task, authenticationScope);"
  );
  const deleteFenceIndex = remove.indexOf(responseFence, deleteResponseIndex);
  const firstRecoveryCleanupIndex = Math.min(
    ...[
      remove.indexOf("blockDraftRenderSources.delete", deleteResponseIndex),
      remove.indexOf("pageDraftStore.removeBlocks", deleteResponseIndex)
    ].filter((index) => index >= 0)
  );
  assert.ok(
    deleteResponseIndex >= 0
      && deleteFenceIndex > deleteResponseIndex
      && Number.isFinite(firstRecoveryCleanupIndex)
      && firstRecoveryCleanupIndex > deleteFenceIndex,
    "a stale successful block-delete response must not clear local recovery state"
  );
});

test("auth rotation reproducer shows why OR is required for a successful stale response", () => {
  const successfulResponse = { ok: true };
  const initiatingScopeIsCurrent = false;

  const oldAndGuardReturns =
    successfulResponse === null && !initiatingScopeIsCurrent;
  const fixedOrGuardReturns =
    successfulResponse === null || !initiatingScopeIsCurrent;

  assert.equal(oldAndGuardReturns, false, "old AND guard falls through on stale successful responses");
  assert.equal(fixedOrGuardReturns, true, "OR guard rejects stale successful responses");
});
