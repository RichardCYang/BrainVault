import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function extractBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  assert.notEqual(end, -1, `${endMarker} must exist`);
  return appSource.slice(start, end).trim();
}

function loadSubmitHarness(apiImpl) {
  const source = extractBetween(
    "async function submitBlockCreateTask",
    "async function createEmptyBlock"
  );
  const skippedApiRequest = Symbol("skipped-api-request");
  const pendingBlockCreateTasks = new Map();
  const context = {
    skippedApiRequest,
    pendingBlockCreateTasks,
    isCurrentAuthenticatedSessionScope() { return true; },
    isAmbiguousApiError(error) { return error?.ambiguous === true; },
    async submitWithFreshMutationIdOnReuse(_task, submit) { return submit(); },
    api: apiImpl
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.submitBlockCreateTask = submitBlockCreateTask;`, context);
  return context;
}

function createTask() {
  return {
    taskKey: "task-1",
    pageId: "page-A",
    basePageContentVersion: 1,
    payload: { type: "MARKDOWN", markdown: "" },
    mutationId: "mut-1",
    inFlight: false
  };
}

test("block create rechecks navigation after asynchronous API header preparation and before fetch", async () => {
  let current = true;
  let enteredHeaderPreparation;
  let releaseHeaderPreparation;
  const entered = new Promise((resolve) => {
    enteredHeaderPreparation = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseHeaderPreparation = resolve;
  });
  let fetchCount = 0;
  let context;

  context = loadSubmitHarness(async (_path, options) => {
    enteredHeaderPreparation();
    await gate;
    if (options.beforeFetch?.() === false) return context.skippedApiRequest;
    fetchCount += 1;
    return { block: { id: "block-1" } };
  });

  const task = createTask();
  const submission = context.submitBlockCreateTask(
    task,
    { generation: 1 },
    { requestGuard: () => current }
  );

  await entered;
  current = false;
  releaseHeaderPreparation();
  const result = await submission;

  assert.equal(result, context.skippedApiRequest);
  assert.equal(fetchCount, 0, "a stale page intent must not reach fetch");
  assert.equal(context.pendingBlockCreateTasks.size, 0, "an unsent create needs no retry receipt");
  assert.equal(task.inFlight, false);
});

test("an ambiguous attempted block create keeps its mutation id but does not retry after navigation", async () => {
  let current = true;
  let fetchCount = 0;
  let context;

  context = loadSubmitHarness(async (_path, options) => {
    if (options.beforeFetch?.() === false) return context.skippedApiRequest;
    fetchCount += 1;
    current = false;
    const error = new Error("network outcome unknown");
    error.ambiguous = true;
    throw error;
  });

  const task = createTask();
  const result = await context.submitBlockCreateTask(
    task,
    { generation: 1 },
    { requestGuard: () => current }
  );

  assert.equal(result, context.skippedApiRequest);
  assert.equal(fetchCount, 1, "the stale interaction must not issue a second write attempt");
  assert.equal(context.pendingBlockCreateTasks.get(task.taskKey), task);
  assert.equal(task.mutationId, "mut-1");
  assert.equal(task.inFlight, false);
});

test("createEmptyBlock binds block creation to the initiating page and navigation generation", () => {
  const source = extractBetween(
    "async function createEmptyBlock",
    "async function insertBlockRelative"
  );

  assert.match(source, /navigationGeneration = workspaceNavigationGeneration/);
  assert.match(source, /isCurrentWorkspaceNavigation\(navigationGeneration\)/);
  assert.match(source, /state\.selectedPage\?\.id === pageId/);
  assert.match(source, /requestGuard: isCreateIntentCurrent/);
  assert.match(source, /data === skippedApiRequest/);
});
