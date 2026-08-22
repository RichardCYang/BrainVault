import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function loadRefreshAfterDeletion() {
  const start = appSource.indexOf("async function refreshSelectedPageAfterBlockDeletion");
  const end = appSource.indexOf("async function deleteEmptyBlock", start);
  assert.notEqual(start, -1, "refreshSelectedPageAfterBlockDeletion must exist");
  assert.notEqual(end, -1, "refreshSelectedPageAfterBlockDeletion boundary must exist");
  return appSource.slice(start, end).trim();
}

function createHarness({ collaborative = false, pageMode = "write", backendBlocks = [] } = {}) {
  let persistedBlocks = backendBlocks.map((block) => ({ ...block }));
  const state = {
    selectedPage: {
      id: "page-1",
      blocks: collaborative ? persistedBlocks.map((block) => ({ ...block })) : [{ id: "deleted-block" }],
      collaboration: { enabled: collaborative }
    },
    workspaceView: "page",
    pageMode,
    pendingFocusBlockId: null
  };
  const calls = { opened: 0, rendered: 0, created: 0 };
  const context = {
    state,
    Boolean,
    flattenBlocks(blocks) {
      return blocks;
    },
    isPageReadOnly() {
      return state.pageMode !== "write";
    },
    isCollaborativePage() {
      return collaborative;
    },
    renderSelectedPage() {
      calls.rendered += 1;
    },
    async openPage(pageId, options) {
      assert.equal(pageId, "page-1");
      assert.equal(options?.skipFlush, true);
      calls.opened += 1;
      state.selectedPage.blocks = persistedBlocks.map((block) => ({ ...block }));
    },
    async createEmptyBlock(pageId, options) {
      assert.equal(pageId, "page-1");
      assert.equal(options?.allowLocked, true);
      calls.created += 1;
      const block = { id: "starter-block" };
      persistedBlocks = [block];
      if (collaborative) state.selectedPage.blocks = [block];
      return { block };
    },
    captureAuthenticatedSessionScope() { return { generation: 1 }; },
    isCurrentAuthenticatedSessionScope() { return true; },
    async reconcileCanonicalCreatedBlock(pageId, _block, options) {
      assert.equal(options?.skipFlush, true);
      await context.openPage(pageId, { skipFlush: true });
    }
  };
  vm.createContext(context);
  vm.runInContext(`${loadRefreshAfterDeletion()}\nthis.refreshSelectedPageAfterBlockDeletion = refreshSelectedPageAfterBlockDeletion;`, context);
  return { context, state, calls };
}

test("deleting the last direct-edit block recreates a focused starter while write mode is active", async () => {
  const { context, state, calls } = createHarness({ backendBlocks: [] });

  await context.refreshSelectedPageAfterBlockDeletion("page-1");

  assert.equal(state.pendingFocusBlockId, "starter-block");
  assert.deepEqual(calls, { opened: 2, rendered: 0, created: 1 });
  assert.deepEqual(state.selectedPage.blocks, [{ id: "starter-block" }]);
});

test("deleting a non-final block keeps the remaining editor and does not create another block", async () => {
  const { context, state, calls } = createHarness({ backendBlocks: [{ id: "remaining-block" }] });

  await context.refreshSelectedPageAfterBlockDeletion("page-1", { focusBlockId: "remaining-block" });

  assert.equal(state.pendingFocusBlockId, "remaining-block");
  assert.deepEqual(calls, { opened: 1, rendered: 0, created: 0 });
});

test("an empty page in read mode stays empty after deletion refresh", async () => {
  const { context, state, calls } = createHarness({ pageMode: "read", backendBlocks: [] });

  await context.refreshSelectedPageAfterBlockDeletion("page-1");

  assert.equal(state.pendingFocusBlockId, null);
  assert.deepEqual(calls, { opened: 1, rendered: 0, created: 0 });
});

test("collaborative last-block deletion restores the starter without a page reload", async () => {
  const { context, state, calls } = createHarness({ collaborative: true, backendBlocks: [] });

  await context.refreshSelectedPageAfterBlockDeletion("page-1");

  assert.equal(state.pendingFocusBlockId, "starter-block");
  assert.deepEqual(calls, { opened: 0, rendered: 2, created: 1 });
  assert.deepEqual(state.selectedPage.blocks, [{ id: "starter-block" }]);
});

test("both keyboard-empty and context-menu deletion paths share the recovery helper", () => {
  const emptyDeleteStart = appSource.indexOf("async function deleteEmptyBlock");
  const emptyDeleteEnd = appSource.indexOf("function focusPendingBlock", emptyDeleteStart);
  const contextDeleteStart = appSource.indexOf('if (button.dataset.action === "delete-block")');
  const contextDeleteEnd = appSource.indexOf("document.addEventListener(\"visibilitychange\"", contextDeleteStart);

  const emptyDeleteSource = appSource.slice(emptyDeleteStart, emptyDeleteEnd);
  const contextDeleteSource = appSource.slice(contextDeleteStart, contextDeleteEnd);
  assert.match(emptyDeleteSource, /await refreshSelectedPageAfterBlockDeletion\(state\.selectedPage\.id, \{ focusBlockId \}\)/);
  assert.match(contextDeleteSource, /await refreshSelectedPageAfterBlockDeletion\(pageId\)/);
});
