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
    "if (data === null || !isCurrentAuthenticatedSessionScope(authenticationScope)) return null;";

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

test("auth rotation reproducer shows why OR is required for a successful stale page-delete response", () => {
  const successfulResponse = { ok: true };
  const initiatingScopeIsCurrent = false;

  const oldAndGuardReturns =
    successfulResponse === null && !initiatingScopeIsCurrent;
  const fixedOrGuardReturns =
    successfulResponse === null || !initiatingScopeIsCurrent;

  assert.equal(oldAndGuardReturns, false, "old AND guard falls through on stale successful responses");
  assert.equal(fixedOrGuardReturns, true, "OR guard rejects stale successful responses");
});
