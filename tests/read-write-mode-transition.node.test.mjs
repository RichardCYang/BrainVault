import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadSetPageMode() {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function setPageMode");
  const end = source.indexOf("function closePageActionsMenu", start);
  assert.notEqual(start, -1, "setPageMode must exist");
  assert.notEqual(end, -1, "setPageMode boundary must exist");
  return source.slice(start, end).trim();
}

function createHarness(blocks = [], { initialMode = "read", materialization = null } = {}) {
  const pageModes = Object.freeze({ READ: "read", WRITE: "write" });
  const state = {
    selectedPage: { id: "page-1", blocks },
    workspaceView: "page",
    pageMode: initialMode === pageModes.WRITE ? pageModes.WRITE : pageModes.READ,
    pageModeChanging: false,
    pendingFocusBlockId: null
  };
  const calls = { created: 0, opened: 0, appliedMaterialization: 0 };
  const context = {
    state,
    pageModes,
    recoveryStoragePersistence: {
      isPersistent() { return true; },
      async ensurePersistent() { return true; }
    },
    syncPageModeUi() {},
    async flushPendingPageEdits() { return materialization; },
    applyMaterializedHtmlCaches(result) {
      assert.equal(result, materialization);
      calls.appliedMaterialization += 1;
    },
    flattenBlocks(value) { return value; },
    renderSelectedPage() {},
    canPersistSelectedPage() {
      return Boolean(state.selectedPage && state.workspaceView === "page" && state.pageMode === pageModes.WRITE);
    },
    canEditSelectedPage() {
      return context.canPersistSelectedPage() && !state.pageModeChanging;
    },
    isPageModeMutationFenced() {
      return false;
    },
    requireWritablePage() {
      return context.canEditSelectedPage();
    },
    async createEmptyBlock(_pageId, { allowLocked = false } = {}) {
      const writable = allowLocked ? context.canPersistSelectedPage() : context.requireWritablePage();
      if (!writable) throw new Error("read-only");
      calls.created += 1;
      return { block: { id: "block-1" } };
    },
    async openPage() { calls.opened += 1; },
    setStatus() {},
    t(key) { return key; }
  };
  vm.createContext(context);
  vm.runInContext(`${loadSetPageMode()}
this.setPageMode = setPageMode;`, context);
  return { context, state, pageModes, calls };
}

test("empty pages enter write mode and create the first block under the transition lock", async () => {
  const { context, state, pageModes, calls } = createHarness();
  await context.setPageMode(pageModes.WRITE);
  assert.equal(state.pageMode, pageModes.WRITE);
  assert.equal(state.pageModeChanging, false);
  assert.equal(state.pendingFocusBlockId, "block-1");
  assert.deepEqual(calls, { created: 1, opened: 1, appliedMaterialization: 0 });
});

test("pages with blocks enter write mode without creating another block", async () => {
  const { context, state, pageModes, calls } = createHarness([{ id: "existing" }]);
  await context.setPageMode(pageModes.WRITE);
  assert.equal(state.pageMode, pageModes.WRITE);
  assert.equal(state.pageModeChanging, false);
  assert.deepEqual(calls, { created: 0, opened: 0, appliedMaterialization: 0 });
});

test("entering read mode applies the materialized rendered cache before completing the transition", async () => {
  const materialization = { blocks: [{ id: "ai-1", htmlCache: "<strong>rendered</strong>" }] };
  const { context, state, pageModes, calls } = createHarness([{ id: "ai-1" }], {
    initialMode: "write",
    materialization
  });

  await context.setPageMode(pageModes.READ);

  assert.equal(state.pageMode, pageModes.READ);
  assert.equal(state.pageModeChanging, false);
  assert.deepEqual(calls, { created: 0, opened: 0, appliedMaterialization: 1 });
});
