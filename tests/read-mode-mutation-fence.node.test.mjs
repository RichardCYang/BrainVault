import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function sliceBetween(startText, endText) {
  const start = client.indexOf(startText);
  const end = client.indexOf(endText, start);
  assert.notEqual(start, -1, `${startText} must exist`);
  assert.notEqual(end, -1, `${endText} must exist after ${startText}`);
  return client.slice(start, end).trim();
}

function loadCreateAndModeHarness() {
  const fenceSource = sliceBetween(
    "function isPageModeMutationFenced",
    "async function assertWorkspacePersistenceUnlocked"
  );
  const createSource = sliceBetween(
    "async function createEmptyBlock",
    "async function insertBlockRelative"
  );
  const modeSource = sliceBetween(
    "async function setPageMode",
    "function closePageActionsMenu"
  );

  let releaseCreate;
  const deferredCreate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  const pageModes = Object.freeze({ READ: "read", WRITE: "write" });
  const state = {
    selectedPage: { id: "page-1", blocks: [{ id: "existing" }], contentVersion: 1 },
    workspaceView: "page",
    pageMode: pageModes.WRITE,
    pageModeChanging: false,
    pendingFocusBlockId: null
  };
  let serverCreateStarted = false;
  const context = {
    state,
    pageModes,
    pageModeMutationFences: new Map(),
    syncPageModeUi() {},
    canPersistSelectedPage() {
      return Boolean(
        state.selectedPage
        && state.workspaceView === "page"
        && state.pageMode === pageModes.WRITE
      );
    },
    requireWritablePage() {
      return context.canPersistSelectedPage() && !state.pageModeChanging;
    },
    isCollaborativePage() {
      return false;
    },
    captureAuthenticatedSessionScope() {
      return { generation: 1, targetKey: "user-1" };
    },
    isCurrentAuthenticatedSessionScope() {
      return true;
    },
    getBlockCreateTask(_scope, pageId, payload) {
      return { pageId, payload };
    },
    async submitBlockCreateTask() {
      serverCreateStarted = true;
      return deferredCreate;
    },
    applyPageContentVersion() {},
    t(key) {
      return key;
    },
    async flushPendingPageEdits() {
      return null;
    },
    applyMaterializedHtmlCaches() {},
    flattenBlocks(value) {
      return value;
    },
    renderSelectedPage() {},
    async openPage() {},
    setStatus() {}
  };

  vm.createContext(context);
  vm.runInContext(
    `${fenceSource}
${createSource}
${modeSource}
this.createEmptyBlock = createEmptyBlock;
this.setPageMode = setPageMode;
this.isPageModeMutationFenced = isPageModeMutationFenced;`,
    context
  );

  return {
    context,
    state,
    pageModes,
    releaseCreate,
    serverCreateStarted: () => serverCreateStarted
  };
}

test("an in-flight REST block creation fences the page against entering read mode", async () => {
  const {
    context,
    state,
    pageModes,
    releaseCreate,
    serverCreateStarted
  } = loadCreateAndModeHarness();

  const createPromise = context.createEmptyBlock(state.selectedPage.id);
  await Promise.resolve();

  assert.equal(serverCreateStarted(), true);
  assert.equal(context.isPageModeMutationFenced(state.selectedPage), true);

  await context.setPageMode(pageModes.READ);
  assert.equal(
    state.pageMode,
    pageModes.WRITE,
    "read mode must not become visible while the server can still commit a block create"
  );

  releaseCreate({ block: { id: "new-block" }, pageContentVersion: 2 });
  const created = await createPromise;
  assert.equal(created.block.id, "new-block");
  assert.equal(context.isPageModeMutationFenced(state.selectedPage), false);

  await context.setPageMode(pageModes.READ);
  assert.equal(state.pageMode, pageModes.READ);
});

test("attachment uploads hold the same page-mode mutation fence for their entire asynchronous mutation path", () => {
  const uploadSource = sliceBetween(
    "async function uploadAttachmentFromRow",
    "function requestAttachmentUpload"
  );
  const lockIndex = uploadSource.indexOf("const pageModeMutationFence = lockPageModeMutationFence(pageId);");
  const tryIndex = uploadSource.indexOf("try {");
  const unlockIndex = uploadSource.lastIndexOf("unlockPageModeMutationFence(pageModeMutationFence);");

  assert.ok(lockIndex >= 0, "attachment uploads must acquire the page-mode mutation fence");
  assert.ok(tryIndex > lockIndex, "the fence must be acquired before the first guarded async work");
  assert.ok(unlockIndex > tryIndex, "the fence must be released from the upload cleanup path");
});

test("the read/write toggle is disabled while the selected page has an active mutation fence", () => {
  assert.match(
    client,
    /elements\.pageModeToggle\.disabled\s*=\s*interactionLocked\s*\|\|\s*isPageModeMutationFenced\(\)/
  );
  assert.match(client, /pendingAttachmentCreateTasks\.clear\(\);\s*pageModeMutationFences\.clear\(\);/s);
});

test("read mode blocks destructive page-version history reset while keeping history viewing available", async () => {
  const resetSource = sliceBetween(
    "async function resetPageVersionHistory",
    "async function loadPageVersionDetail"
  );

  assert.match(resetSource, /if \(!requireWritablePage\(\)\) return;/);
  assert.match(resetSource, /withPageModeMutationFence\(pageId, \(\) => submitPageVersionResetTask\(task\)\)/);

  let writableChecks = 0;
  const context = {
    state: {
      selectedPage: { id: "page-1", title: "Example" },
      pageVersionHistory: { pageId: "page-1", loading: false, resetting: false }
    },
    isPageOwner() {
      return true;
    },
    requireWritablePage() {
      writableChecks += 1;
      return false;
    }
  };
  vm.createContext(context);
  vm.runInContext(`${resetSource}\nthis.resetPageVersionHistory = resetPageVersionHistory;`, context);
  await context.resetPageVersionHistory();
  assert.equal(writableChecks, 1, "the destructive reset must stop at the read-mode guard");
  assert.match(
    client,
    /pageVersionHistoryReset\.disabled\s*=\s*history\.loading\s*\|\|\s*history\.resetting\s*\|\|\s*isPageReadOnly\(\)/
  );
});
