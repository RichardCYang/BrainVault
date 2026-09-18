import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { createPageDraftStore } from "../public/draft-store.js";
import { createLatestWriteQueue } from "../public/save-queue.js";
import { rebaseCommittedBlockContent, rebaseCommittedPageTitle } from "../public/save-rebase.js";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `production source boundary: ${startMarker}`);
  return appSource.slice(start, end);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name)
  };
}

// Execute the real admission functions, writers, recovery persistence functions,
// draft store, and queue. Only browser controls, the durability barrier, and the
// HTTP endpoint are simulated; these are not live IndexedDB/MariaDB tests.
function createHarness() {
  const authScope = Object.freeze({ userId: "user-1", generation: 1 });
  const store = createPageDraftStore(new MemoryStorage(), { sourceId: "tab-1" });
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const payload = (markdown) => ({ type: "MARKDOWN", markdown, checked: false, metadata: null });
  let serverBlock = { id: "block-1", pageId: "page-1", version: 1, ...payload("original block") };
  let serverPage = { id: "page-1", title: "original title", version: 1, contentVersion: 1, blocks: [clone(serverBlock)] };
  let currentRow = { dataset: { blockId: "block-1", editRevision: "0" }, classList: classList(), payload: payload("original block") };
  const requests = [];
  const histories = [];
  const timers = new Map();
  let nextTimerId = 0;
  let nextMutationId = 0;
  let nextDurabilityBarrier = null;
  const positiveVersion = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const context = vm.createContext({
    console,
    state: { user: { id: "user-1" }, selectedPage: clone(serverPage), pageEditLockDepth: 0 },
    elements: { pageTitle: { value: "original title", classList: classList() } },
    pageDraftStore: store,
    pageDraftSourceId: "tab-1",
    pageTitleDraftSourceId: "tab-1",
    pageTitleEditRevision: 0,
    pageTitleSavedRevision: 0,
    pageTitleDraftExpectedVersion: null,
    pageTitleConflictOrigin: null,
    pageTitleDraftConflict: false,
    pageTitleTaskId: 0,
    pageTitleSaveTimer: null,
    pageTitleEditAuthenticationScope: authScope,
    workspaceNavigationGeneration: 1,
    recoveryStorageFailureDrainInFlight: false,
    blockSaveQueues: new Map(),
    blockSaveTaskIds: new Map(),
    blockEditAuthenticationScopes: new Map(),
    blockDraftRenderSources: new Map(),
    blockDraftConflictOrigins: new Map(),
    blockSaveTimers: new Map(),
    blockSaveRows: new Map(),
    createLatestWriteQueue,
    rebaseCommittedBlockContent,
    rebaseCommittedPageTitle,
    getPositiveVersion: positiveVersion,
    getLatestKnownVersion: (...values) => {
      const versions = values.map(positiveVersion).filter((value) => value !== null);
      return versions.length ? Math.max(...versions) : null;
    },
    captureAuthenticatedSessionScope: () => authScope,
    assertCurrentAuthenticatedSessionScope: (scope) => {
      if (scope !== authScope || context.state.user?.id !== authScope.userId) throw new Error("stale authentication");
    },
    isCurrentAuthenticatedSessionScope: (scope) => scope === authScope && context.state.user?.id === authScope.userId,
    isCurrentWorkspaceNavigation: (generation) => generation === context.workspaceNavigationGeneration,
    requireWritablePage: () => context.state.pageEditLockDepth === 0,
    canPersistSelectedPage: () => Boolean(context.state.selectedPage),
    isCollaborativePage: () => false,
    getDraftScope: () => ({ userId: context.state.user.id, pageId: context.state.selectedPage.id }),
    getPageSummaryById: () => context.state.selectedPage,
    getBlockById: (id) => context.state.selectedPage.blocks.find((block) => block.id === id),
    findRenderedBlockRow: (id) => currentRow.dataset.blockId === id ? currentRow : null,
    buildBlockPayload: (row) => clone(row.payload),
    jsonValuesMatch: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    blockPayloadsMatch: (block, candidate) => Object.keys(candidate).every((key) => JSON.stringify(block[key]) === JSON.stringify(candidate[key])),
    normalizeRecoveredBlockPayload: (value) => value,
    normalizePageTitle: (value) => value.trim() || "New document",
    checkDraftStoreWrite: (result) => { assert.notEqual(result, false, "recovery store write must succeed"); return result; },
    preserveInputAfterRecoveryAdmissionFailure: () => { throw new Error("unexpected recovery failure"); },
    requireDirectRecoveryDurability: () => {
      const barrier = nextDurabilityBarrier;
      nextDurabilityBarrier = null;
      return barrier?.promise ?? Promise.resolve();
    },
    recordPageTitleEditorHistory: () => histories.push({ kind: "title", value: context.elements.pageTitle.value }),
    recordBlockEditorHistory: (_row, value) => histories.push({ kind: "block", value: value.markdown }),
    submitWithFreshMutationIdOnReuse: (_task, submit) => submit(),
    isAmbiguousApiError: () => false,
    canSupersedeBlockSaveError: () => false,
    createMutationId: () => `mutation-${++nextMutationId}`,
    applyPageSummaryUpdate: (id, updates) => {
      if (context.state.selectedPage.id === id) Object.assign(context.state.selectedPage, updates);
    },
    updateBlockInState: (block) => {
      context.state.selectedPage.blocks = context.state.selectedPage.blocks.map((previous) => previous.id === block.id ? block : previous);
    },
    updateRenderedBlockPreview: (row, block) => { row.preview = clone(block); },
    applyAuthoritativePageContentVersion: (_id, data) => { if (data.contentVersion) context.state.selectedPage.contentVersion = data.contentVersion; },
    renderPageHeader: () => {},
    syncBeforeUnloadProtection: () => {},
    setStatus: () => {},
    t: (key) => key,
    window: {
      clearTimeout: (id) => timers.delete(id),
      setTimeout: (callback) => { const id = ++nextTimerId; timers.set(id, callback); return id; }
    },
    api: async (url, options) => {
      requests.push({ url, body: clone(options.body) });
      if (url === "/api/pages/page-1") {
        assert.equal(options.body.expectedVersion, serverPage.version, "page optimistic version");
        serverPage = { ...serverPage, title: options.body.title, version: serverPage.version + 1 };
        return { page: clone(serverPage) };
      }
      assert.equal(url, "/api/blocks/block-1");
      assert.equal(options.body.expectedVersion, serverBlock.version, "block optimistic version");
      const { type, markdown, checked, metadata } = options.body;
      serverBlock = { ...serverBlock, type, markdown, checked, metadata, version: serverBlock.version + 1 };
      serverPage.contentVersion += 1;
      return { block: clone(serverBlock), contentVersion: serverPage.contentVersion };
    }
  });
  vm.runInContext([
    sourceBetween("function persistPageTitleDraftValue(", "function confirmRecoveredDraftOverwrite("),
    sourceBetween("const pageTitleSaveQueue = createLatestWriteQueue", "async function downloadAttachment("),
    sourceBetween("function getBlockSaveQueue(", "function scheduleBlockSave("),
    sourceBetween("async function savePageTitleNow(", "function schedulePageTitleSave("),
    "globalThis.subject = { savePageTitleNow, saveBlockRow, persistPageTitleDraftValue, persistBlockDraft };"
  ].join("\n"), context);

  const harness = {
    context, requests, histories, timers, store,
    get row() { return currentRow; },
    get serverTitle() { return serverPage.title; },
    get serverMarkdown() { return serverBlock.markdown; },
    get titleDraft() { return store.loadPage("user-1", "page-1", "tab-1")?.title; },
    get blockDraft() { return store.loadPage("user-1", "page-1", "tab-1")?.blocks?.["block-1"]; },
    pauseNextSave() { const barrier = deferred(); nextDurabilityBarrier = barrier; return barrier; },
    editTitle(value) {
      context.elements.pageTitle.value = value;
      context.pageTitleEditRevision += 1;
      context.pageTitleEditAuthenticationScope = authScope;
      context.subject.persistPageTitleDraftValue(value);
      context.window.clearTimeout(context.pageTitleSaveTimer);
      context.pageTitleSaveTimer = value.trim() ? context.window.setTimeout(() => {}) : null;
    },
    editBlock(markdown) {
      currentRow.payload = payload(markdown);
      currentRow.dataset.editRevision = String(Number(currentRow.dataset.editRevision) + 1);
      currentRow.classList.add("is-dirty");
      context.blockEditAuthenticationScopes.set("block-1", authScope);
      context.subject.persistBlockDraft(currentRow);
      context.window.clearTimeout(context.blockSaveTimers.get("block-1"));
      context.blockSaveTimers.set("block-1", context.window.setTimeout(() => {}));
      context.blockSaveRows.set("block-1", currentRow);
    },
    rebuildRow() {
      const oldRow = currentRow;
      currentRow = { dataset: { ...oldRow.dataset }, classList: classList(), payload: clone(oldRow.payload) };
      if (oldRow.classList.contains("is-dirty")) currentRow.classList.add("is-dirty");
      return oldRow;
    },
    saveTitle(options = {}) { return context.subject.savePageTitleNow({ quiet: true, ...options }); },
    saveBlock(options = {}) { return context.subject.saveBlockRow(currentRow, { quiet: true, ...options }); }
  };
  return harness;
}

test("a paused title save cannot acknowledge a newer unsaved title revision", async () => {
  const h = createHarness();
  h.editTitle("title A");
  const barrier = h.pauseNextSave();
  const oldSave = h.saveTitle();
  h.editTitle("title B");
  const timer = h.context.pageTitleSaveTimer;
  barrier.resolve();
  await oldSave;
  assert.equal(h.titleDraft?.value, "title B", "the newer recovery draft must survive");
  assert.equal(h.requests.length, 0, "superseded snapshots must not enter the queue");
  assert.ok(h.timers.has(timer), "the newer autosave remains scheduled");
  await h.saveTitle();
  assert.equal(h.serverTitle, "title B");
  assert.equal(h.titleDraft, undefined);
});

test("a paused title save cannot overwrite a newer completed title save", async () => {
  const h = createHarness();
  h.editTitle("title A");
  const barrier = h.pauseNextSave();
  const oldSave = h.saveTitle();
  h.editTitle("title B");
  await h.saveTitle();
  assert.equal(h.serverTitle, "title B");
  barrier.resolve();
  await oldSave;
  assert.equal(h.serverTitle, "title B", "old title must not borrow B's acknowledged version");
  assert.equal(h.requests.length, 1);
  assert.equal(h.context.pageTitleSavedRevision, 2);
});

test("a newer blank title remains recoverable while an earlier save resumes", async () => {
  const h = createHarness();
  h.editTitle("title A");
  const barrier = h.pauseNextSave();
  const oldSave = h.saveTitle();
  h.editTitle("");
  barrier.resolve();
  await oldSave;
  assert.equal(h.titleDraft?.value, "", "blank user-authored state has no replacement autosave");
  assert.equal(h.requests.length, 0);
});

test("a paused block save cannot cancel the newer edit's autosave", async () => {
  const h = createHarness();
  h.editBlock("block A");
  const barrier = h.pauseNextSave();
  const oldSave = h.saveBlock();
  h.editBlock("block B");
  const timer = h.context.blockSaveTimers.get("block-1");
  barrier.resolve();
  await oldSave;
  assert.ok(h.timers.has(timer), "the B timer must not be canceled by A");
  assert.equal(h.context.blockSaveTimers.get("block-1"), timer);
  assert.equal(h.blockDraft?.payload.markdown, "block B");
  assert.equal(h.requests.length, 0);
  await h.saveBlock();
  assert.equal(h.serverMarkdown, "block B");
  assert.equal(h.blockDraft, undefined);
});

test("a paused block save cannot overwrite a newer completed block save", async () => {
  const h = createHarness();
  h.editBlock("block A");
  const barrier = h.pauseNextSave();
  const oldSave = h.saveBlock();
  h.editBlock("block B");
  await h.saveBlock();
  assert.equal(h.serverMarkdown, "block B");
  barrier.resolve();
  await oldSave;
  assert.equal(h.serverMarkdown, "block B", "old block must not borrow B's acknowledged version");
  assert.equal(h.requests.length, 1);
  assert.equal(h.blockDraft, undefined);
});

test("block admission checks the current rendered row after an editor rebuild", async () => {
  const h = createHarness();
  h.editBlock("block A");
  const barrier = h.pauseNextSave();
  const oldSave = h.saveBlock();
  const oldRow = h.rebuildRow();
  h.editBlock("block B");
  assert.equal(oldRow.dataset.editRevision, "1");
  assert.equal(h.row.dataset.editRevision, "2");
  barrier.resolve();
  await oldSave;
  assert.equal(h.requests.length, 0, "a detached row cannot authorize stale content");
  assert.equal(h.blockDraft?.payload.markdown, "block B");
});

for (const kind of ["title", "block"]) {
  const edit = (h, value) => kind === "title" ? h.editTitle(value) : h.editBlock(value);
  const save = (h, options) => kind === "title" ? h.saveTitle(options) : h.saveBlock(options);

  test(`unchanged ${kind} snapshots still save and acknowledge their own revision`, async () => {
    const h = createHarness();
    edit(h, "current value");
    await save(h);
    assert.equal(h.requests.length, 1);
    assert.equal(kind === "title" ? h.serverTitle : h.serverMarkdown, "current value");
    assert.equal(kind === "title" ? h.titleDraft : h.blockDraft, undefined);
  });

  test(`flush-owned ${kind} saves still work under a page-edit lock`, async () => {
    const h = createHarness();
    edit(h, "flush value");
    h.context.state.pageEditLockDepth = 1;
    await save(h, { allowLocked: true });
    assert.equal(h.requests.length, 1);
    assert.equal(kind === "title" ? h.serverTitle : h.serverMarkdown, "flush value");
  });

  test(`a navigation change still fences an awaiting ${kind} save`, async () => {
    const h = createHarness();
    edit(h, "draft value");
    const barrier = h.pauseNextSave();
    const oldSave = save(h);
    h.context.workspaceNavigationGeneration += 1;
    barrier.resolve();
    assert.equal(await oldSave, null);
    assert.equal(h.requests.length, 0);
    assert.ok(kind === "title" ? h.titleDraft : h.blockDraft);
  });

  test(`an authentication change still rejects an awaiting ${kind} save`, async () => {
    const h = createHarness();
    edit(h, "private draft");
    const barrier = h.pauseNextSave();
    const oldSave = save(h);
    h.context.state.user = { id: "other-user" };
    barrier.resolve();
    await assert.rejects(oldSave, /stale authentication/);
    assert.equal(h.requests.length, 0);
    assert.ok(kind === "title" ? h.titleDraft : h.blockDraft);
  });
}
