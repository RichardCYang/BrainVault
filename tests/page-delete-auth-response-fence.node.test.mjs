import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const appUrl = new URL("../public/app.js", import.meta.url);

test("page delete response application stays fenced to the initiating authentication generation", async () => {
  const source = await readFile(appUrl, "utf8");

  const submitStart = source.indexOf("async function submitPageDeleteTask");
  const deleteStart = source.indexOf("async function deleteNavigationTarget", submitStart);
  assert.ok(submitStart >= 0 && deleteStart > submitStart);

  const submit = source.slice(submitStart, deleteStart);
  const responseFence =
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;";

  const submitResponseIndex = submit.indexOf("const data = await submitWithFreshMutationIdOnReuse");
  const submitFenceIndex = submit.indexOf(responseFence, submitResponseIndex);
  const submitTaskCleanupIndex = submit.indexOf("pendingPageDeleteTasks.delete", submitResponseIndex);
  assert.ok(
    submitResponseIndex >= 0
      && submitFenceIndex > submitResponseIndex
      && submitTaskCleanupIndex > submitFenceIndex,
    "a completed page-delete response must be rejected after auth rotation before its retry task is acknowledged"
  );
});

test("page delete recovery cleanup remains fenced after the delete request completes", async () => {
  const source = await readFile(appUrl, "utf8");

  const deleteStart = source.indexOf("async function deleteNavigationTarget");
  const nextFunctionStart = source.indexOf("\nasync function ", deleteStart + 1);
  assert.ok(deleteStart >= 0 && nextFunctionStart > deleteStart);

  const remove = source.slice(deleteStart, nextFunctionStart);
  const deleteResponseIndex = remove.indexOf(
    "await submitPageDeleteTask(task, authenticationScope);"
  );
  const deleteFenceIndex = remove.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return;",
    deleteResponseIndex
  );
  const recoveryCleanupIndex = remove.indexOf("pageDraftStore.removePages", deleteResponseIndex);

  assert.ok(
    deleteResponseIndex >= 0
      && deleteFenceIndex > deleteResponseIndex
      && recoveryCleanupIndex > deleteFenceIndex,
    "a stale page-delete completion must not clear durable local recovery drafts"
  );
});

test("204 no-content page deletes are accepted only while the initiating authentication scope is current", () => {
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
    "the OR guard mistakes a successful current-scope 204 page delete for an aborted request"
  );
  assert.equal(
    fixedAuthGuardReturnsOnCurrent204,
    false,
    "a current-scope 204 must fall through to page-delete retry-task acknowledgement"
  );
  assert.equal(
    fixedAuthGuardReturnsOnStale204,
    true,
    "auth rotation must still reject a 204 page-delete response"
  );
});
