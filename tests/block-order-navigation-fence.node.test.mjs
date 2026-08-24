import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `${startText} must exist`);
  assert.notEqual(end, -1, `${endText} must exist after ${startText}`);
  return source.slice(start, end).trim();
}

function createSubmissionContext() {
  const pageModes = Object.freeze({ READ: "read", WRITE: "write" });
  const state = {
    selectedPage: { id: "page-a" },
    workspaceView: "page",
    pageMode: pageModes.WRITE
  };
  let workspaceNavigationGeneration = 7;
  let durabilityResolve;
  let requestPreparationResolve;
  let waitForDurability = false;
  let waitForRequestPreparation = false;
  let apiCalls = 0;
  let fetchCalls = 0;
  const skippedApiRequest = Symbol("skipped-api-request");

  const context = {
    state,
    pageModes,
    skippedApiRequest,
    isCurrentAuthenticatedSessionScope: () => true,
    assertCurrentAuthenticatedSessionScope: () => {},
    isCurrentWorkspaceNavigation: (generation) => generation === workspaceNavigationGeneration,
    canPersistSelectedPage: () => Boolean(
      state.selectedPage
      && state.workspaceView === "page"
      && state.pageMode === pageModes.WRITE
    ),
    isAmbiguousApiError: () => false,
    persistBlockOrderDraft: () => {},
    applyPageContentVersion: () => {},
    updateBlockInState: () => {},
    normalizeParentBlockId: (value) => value ?? null,
    getBlockSiblings: () => [],
    reorderBlockSiblingsInState: () => {},
    submitWithFreshMutationIdOnReuse: async (_task, submit) => submit(),
    requireDirectRecoveryDurability: async () => {
      if (!waitForDurability) return;
      await new Promise((resolve) => {
        durabilityResolve = resolve;
      });
    },
    api: async (_path, options) => {
      apiCalls += 1;
      if (waitForRequestPreparation) {
        await new Promise((resolve) => {
          requestPreparationResolve = resolve;
        });
      }
      if (options.beforeFetch?.() === false) return skippedApiRequest;
      fetchCalls += 1;
      return { pageContentVersion: 1, blocks: [] };
    }
  };

  Object.assign(context, {
    setWorkspaceNavigationGeneration(value) {
      workspaceNavigationGeneration = value;
    },
    enableDurabilityWait() {
      waitForDurability = true;
    },
    releaseDurability() {
      durabilityResolve?.();
    },
    enableRequestPreparationWait() {
      waitForRequestPreparation = true;
    },
    releaseRequestPreparation() {
      requestPreparationResolve?.();
    },
    getApiCalls: () => apiCalls,
    getFetchCalls: () => fetchCalls
  });

  vm.createContext(context);
  return context;
}

function installSubmissionFunctions(context) {
  const submitSource = sliceBetween(
    client,
    "async function submitBlockOrderTask",
    "async function requireBlockOrderRecoveryDurability"
  );
  const durabilitySource = sliceBetween(
    client,
    "async function requireBlockOrderRecoveryDurability",
    "async function submitBlockOrderTaskWithReplay"
  );
  const replaySource = sliceBetween(
    client,
    "async function submitBlockOrderTaskWithReplay",
    "async function retryPendingBlockOrder"
  );

  vm.runInContext(
    `${submitSource}\n${durabilitySource}\n${replaySource}\n`
      + "this.submitBlockOrderTask = submitBlockOrderTask;\n"
      + "this.submitBlockOrderTaskWithReplay = submitBlockOrderTaskWithReplay;",
    context
  );
}

function makeTask() {
  return {
    pageId: "page-a",
    parentBlockId: null,
    mutationId: "mut-order-nav-fence",
    items: [],
    authenticationScope: { generation: 1 },
    navigationGeneration: 7
  };
}

test("block-order replay does not dispatch after navigation changes during recovery durability", async () => {
  const context = createSubmissionContext();
  installSubmissionFunctions(context);
  context.enableDurabilityWait();

  const pending = context.submitBlockOrderTaskWithReplay(makeTask());
  await Promise.resolve();

  context.setWorkspaceNavigationGeneration(8);
  context.state.selectedPage = { id: "page-b" };
  context.releaseDurability();

  const result = await pending;
  assert.equal(result, context.skippedApiRequest);
  assert.equal(context.getApiCalls(), 0);
  assert.equal(context.getFetchCalls(), 0);
});

test("block-order request rechecks navigation after async API preparation and immediately before fetch", async () => {
  const context = createSubmissionContext();
  installSubmissionFunctions(context);
  context.enableRequestPreparationWait();

  const task = makeTask();
  const isRequestCurrent = () => (
    context.isCurrentWorkspaceNavigation(task.navigationGeneration)
    && context.canPersistSelectedPage()
    && context.state.selectedPage?.id === task.pageId
  );

  const pending = context.submitBlockOrderTask(task, { requestGuard: isRequestCurrent });
  await Promise.resolve();

  context.setWorkspaceNavigationGeneration(8);
  context.state.selectedPage = { id: "page-b" };
  context.releaseRequestPreparation();

  const result = await pending;
  assert.equal(result, context.skippedApiRequest);
  assert.equal(context.getApiCalls(), 1, "request preparation may begin before navigation changes");
  assert.equal(context.getFetchCalls(), 0, "stale reorder must be stopped immediately before fetch");
});

test("block-order callers preserve durable recovery when a stale dispatch is skipped", () => {
  const drag = sliceBetween(client, "async function finishBlockDrag", "function setRowType");
  const retry = sliceBetween(client, "async function retryPendingBlockOrder", "async function persistBlockOrder");
  const persist = sliceBetween(client, "async function persistBlockOrder", "function getBlockCreateTask");

  const dragSubmit = drag.indexOf("const data = await submitBlockOrderTaskWithReplay(task)");
  const dragSkip = drag.indexOf("if (data === skippedApiRequest) return;", dragSubmit);
  const dragAck = drag.indexOf("acknowledgeBlockOrderDraft(task)", dragSubmit);
  assert.ok(dragSubmit >= 0 && dragSkip > dragSubmit && dragAck > dragSkip);

  const retrySubmit = retry.indexOf(
    "const data = await submitBlockOrderTaskWithReplay(task, { keepalive, allowRecoveryFailure })"
  );
  const retrySkip = retry.indexOf("if (data === skippedApiRequest) return null;", retrySubmit);
  const retryAck = retry.indexOf("acknowledgeBlockOrderDraft(task)", retrySubmit);
  assert.ok(retrySubmit >= 0 && retrySkip > retrySubmit && retryAck > retrySkip);

  const persistSubmit = persist.indexOf("const data = await submitBlockOrderTaskWithReplay(task)");
  const persistSkip = persist.indexOf("if (data === skippedApiRequest) return null;", persistSubmit);
  const persistAck = persist.indexOf("acknowledgeBlockOrderDraft(task)", persistSubmit);
  assert.ok(persistSubmit >= 0 && persistSkip > persistSubmit && persistAck > persistSkip);
});
