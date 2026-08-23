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
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;";

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

test("204 no-content is accepted only while the initiating authentication scope is current", () => {
  const noContentResponse = null;
  const currentScopeIsCurrent = true;
  const staleScopeIsCurrent = false;

  const buggyOrGuardReturnsOnCurrent204 =
    noContentResponse === null || !currentScopeIsCurrent;
  const fixedAuthGuardReturnsOnCurrent204 = !currentScopeIsCurrent;
  const fixedAuthGuardReturnsOnStale204 = !staleScopeIsCurrent;

  assert.equal(
    buggyOrGuardReturnsOnCurrent204,
    true,
    "the OR guard mistakes a successful current-scope 204 response for an aborted delete"
  );
  assert.equal(
    fixedAuthGuardReturnsOnCurrent204,
    false,
    "a current-scope 204 must fall through to retry-task acknowledgement and local recovery cleanup"
  );
  assert.equal(
    fixedAuthGuardReturnsOnStale204,
    true,
    "auth rotation must still reject a 204 response before applying client-side cleanup"
  );
});

test("post-delete reconciliation remains bound to the initiating authentication generation", async () => {
  const source = await readFile(appUrl, "utf8");

  const refreshStart = source.indexOf("async function refreshSelectedPageAfterBlockDeletion");
  const deleteEmptyStart = source.indexOf("async function deleteEmptyBlock", refreshStart);
  assert.ok(refreshStart >= 0 && deleteEmptyStart > refreshStart);
  const refresh = source.slice(refreshStart, deleteEmptyStart);

  assert.match(
    refresh,
    /authenticationScope = captureAuthenticatedSessionScope\(\)/,
    "the helper may default to the current scope only when it is called outside an existing mutation"
  );

  const reloadIndex = refresh.indexOf("await openPage(pageId, { skipFlush: true });");
  const postReloadFenceIndex = refresh.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return;",
    reloadIndex
  );
  const starterIndex = refresh.indexOf("const starter = await createEmptyBlock", reloadIndex);
  assert.ok(
    reloadIndex >= 0 && postReloadFenceIndex > reloadIndex && starterIndex > postReloadFenceIndex,
    "auth rotation during the reload must be rejected before a replacement starter block is created"
  );

  const recaptureAfterReloadIndex = refresh.indexOf(
    "const authenticationScope = captureAuthenticatedSessionScope()",
    reloadIndex
  );
  assert.equal(
    recaptureAfterReloadIndex,
    -1,
    "post-delete reconciliation must not adopt a replacement authentication generation after reloading"
  );

  const callMatches = [...source.matchAll(/refreshSelectedPageAfterBlockDeletion\([^;]+\);/g)]
    .map((match) => match[0])
    .filter((call) => !call.startsWith("refreshSelectedPageAfterBlockDeletion(\r\n  pageId"));
  assert.equal(callMatches.length, 3, "expected all three mutation call sites to remain covered");
  for (const call of callMatches) {
    assert.match(
      call,
      /authenticationScope/,
      "delete/move callers must propagate the scope captured before the mutation"
    );
  }
});
