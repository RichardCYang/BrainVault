import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { createPageDraftStore } from "../public/draft-store.js";
import { createLatestWriteQueue } from "../public/save-queue.js";
import { rebaseCommittedBlockContent, rebaseCommittedPageTitle } from "../public/save-rebase.js";

// Recovery persistence legitimately refreshes updatedAt. Keep time deterministic
// so byte-for-byte draft assertions do not depend on two writes sharing a real
// millisecond. Node's per-test mock is reset automatically after each case.
test.beforeEach((context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
});

// Point at an extracted pre-patch app.js to reproduce the same failures without
// modifying the working tree or Git metadata.
const appSource = readFileSync(
  process.env.BRAINVAULT_QA_APP_SOURCE ?? new URL("../public/app.js", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

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
  const storage = new MemoryStorage();
  const store = createPageDraftStore(storage, { sourceId: "tab-1" });
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
    collaborationBlockMutationPromises: new Map(),
    beginDirectRecoveryVisibilityAdmission: () => 1,
    scheduleDirectBlockRecoveryAdmission: () => {},
    finishDirectRecoveryVisibilityAdmission: () => {},
    normalizeParentBlockId: (id) => id || null,
    updateCollaborationAwareness: () => {},
    document: { activeElement: null },
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
        if (options.body.expectedVersion !== serverPage.version) {
          throw Object.assign(new Error("Remote title changed"), { code: "PAGE_EDIT_CONFLICT" });
        }
        serverPage = { ...serverPage, title: options.body.title, version: serverPage.version + 1 };
        return { page: clone(serverPage) };
      }
      assert.equal(url, "/api/blocks/block-1");
      if (options.body.expectedVersion !== serverBlock.version) {
        throw Object.assign(new Error("Remote block changed"), { code: "BLOCK_EDIT_CONFLICT" });
      }
      const { type, markdown, checked, metadata } = options.body;
      serverBlock = { ...serverBlock, type, markdown, checked, metadata, version: serverBlock.version + 1 };
      serverPage.contentVersion += 1;
      return { block: clone(serverBlock), contentVersion: serverPage.contentVersion };
    }
  });
  vm.runInContext([
    sourceBetween("function persistPageTitleDraftValue(", "function confirmRecoveredDraftOverwrite("),
    sourceBetween("const pageTitleSaveQueue = createLatestWriteQueue", "async function downloadAttachment("),
    sourceBetween("function isCurrentCollaborationMutationContext(", "function cancelScheduledBlockSave("),
    sourceBetween("function cancelScheduledBlockSave(", "function restoreBlockRowFromDurableState("),
    sourceBetween("function markBlockDirty(", "function getBlockSaveQueue("),
    sourceBetween("function getBlockSaveQueue(", "function scheduleBlockSave("),
    sourceBetween("function scheduleBlockSave(", "function getTextareaSelection("),
    sourceBetween("async function savePageTitleNow(", "function schedulePageTitleSave("),
    "globalThis.subject = { savePageTitleNow, saveBlockRow, persistPageTitleDraftValue, persistBlockDraft, markBlockDirty, scheduleBlockSave };"
  ].join("\n"), context);

  const harness = {
    context, requests, histories, timers, store, storage,
    get row() { return currentRow; },
    get serverTitle() { return serverPage.title; },
    get serverMarkdown() { return serverBlock.markdown; },
    get titleDraft() { return store.loadPage("user-1", "page-1", "tab-1")?.title; },
    get blockDraft() { return store.loadPage("user-1", "page-1", "tab-1")?.blocks?.["block-1"]; },
    pauseNextSave() { const barrier = deferred(); nextDurabilityBarrier = barrier; return barrier; },
    remoteEdit(kind, value) {
      if (kind === "title") {
        serverPage = { ...serverPage, title: value, version: serverPage.version + 1 };
      } else {
        serverBlock = { ...serverBlock, ...payload(value), version: serverBlock.version + 1 };
        serverPage.contentVersion += 1;
      }
    },
    refreshCanonicalVersion(kind) {
      if (kind === "title") context.state.selectedPage.version = serverPage.version;
      else context.state.selectedPage.blocks = [clone(serverBlock)];
    },
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
    navigateToOtherPage() {
      const oldRow = currentRow;
      currentRow = { dataset: { blockId: "block-2", editRevision: "0" }, classList: classList(), payload: payload("other block") };
      context.state.selectedPage = {
        id: "page-2", title: "other title", version: 1, contentVersion: 1,
        blocks: [{ id: "block-2", pageId: "page-2", version: 1, ...payload("other block") }]
      };
      context.workspaceNavigationGeneration += 1;
      return oldRow;
    },
    removeRenderedRow() { currentRow = { dataset: {}, classList: classList(), payload: payload("") }; },
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


// Delayed callbacks can hold an old DOM row before saveBlockRow even starts.
// A post-await revision check is too late: persistence itself can replace the
// newer recovery record, and a manufactured revision can alias a completed edit.
test("a detached callback cannot replace a newer durable draft before admission", async () => {
  const h = createHarness();
  h.editBlock("block A");
  const detachedRow = h.rebuildRow();
  h.editBlock("block B");
  const timer = h.context.blockSaveTimers.get("block-1");
  const before = JSON.stringify(h.blockDraft);
  assert.equal(await h.context.subject.saveBlockRow(detachedRow, { quiet: true }), null);
  assert.equal(JSON.stringify(h.blockDraft), before, "B must remain the crash-recovery copy");
  assert.equal(h.requests.length, 0);
  assert.ok(h.timers.has(timer));
});

test("a detached callback cannot overwrite a newer completed block save", async () => {
  const h = createHarness();
  h.editBlock("block A");
  const detachedRow = h.rebuildRow();
  h.editBlock("block B");
  await h.saveBlock();
  assert.equal(h.serverMarkdown, "block B");
  assert.equal(h.blockDraft, undefined);
  await h.context.subject.saveBlockRow(detachedRow, { quiet: true });
  assert.equal(h.serverMarkdown, "block B", "an old DOM row must not manufacture B's revision");
  assert.equal(h.blockDraft, undefined);
  assert.equal(h.requests.length, 1);
});

test("an equivalent rebuilt row can still be saved by its pending callback", async () => {
  const h = createHarness();
  h.editBlock("unchanged rebuild");
  const detachedRow = h.rebuildRow();
  await h.context.subject.saveBlockRow(detachedRow, { quiet: true });
  assert.equal(h.serverMarkdown, "unchanged rebuild");
  assert.equal(h.blockDraft, undefined);
  assert.equal(h.requests.length, 1);
});

for (const kind of ["title", "block"]) {
  test(`a paused ${kind} save cannot bypass a conflict raised by another save`, async () => {
    const h = createHarness();
    const save = () => kind === "title" ? h.saveTitle() : h.saveBlock();
    if (kind === "title") h.editTitle("local draft");
    else h.editBlock("local draft");
    const barrier = h.pauseNextSave();
    const delayedSave = save();
    h.remoteEdit(kind, "new remote content");
    await assert.rejects(save(), { code: kind === "title" ? "PAGE_EDIT_CONFLICT" : "BLOCK_EDIT_CONFLICT" });
    // A canonical summary/row refresh must not count as overwrite consent.
    h.refreshCanonicalVersion(kind);
    const requestCount = h.requests.length;
    const draft = kind === "title" ? h.titleDraft : h.blockDraft;
    barrier.resolve();
    assert.equal(await delayedSave, null);
    assert.equal(h.requests.length, requestCount, "the rejected draft must not be silently re-admitted");
    assert.equal(kind === "title" ? h.serverTitle : h.serverMarkdown, "new remote content");
    assert.deepEqual(kind === "title" ? h.titleDraft : h.blockDraft, draft);
    assert.equal(kind === "title" ? h.context.pageTitleDraftConflict : h.row.dataset.draftConflict === "true", true);
  });
}

test("same-revision block payload replacement during durability is not stale-save consent", async () => {
  const h = createHarness();
  h.editBlock("old local payload");
  const barrier = h.pauseNextSave();
  const delayedSave = h.saveBlock();
  h.rebuildRow();
  h.row.payload.markdown = "replacement recovery payload";
  h.context.subject.persistBlockDraft(h.row);
  barrier.resolve();
  assert.equal(await delayedSave, null);
  assert.equal(h.requests.length, 0);
  assert.equal(h.blockDraft.payload.markdown, "replacement recovery payload");
});

test("same-revision block recovery-source replacement cannot authorize the old source", async () => {
  const h = createHarness();
  h.editBlock("old source payload");
  const barrier = h.pauseNextSave();
  const delayedSave = h.saveBlock();
  const otherStore = createPageDraftStore(h.storage, { sourceId: "replacement-source" });
  assert.equal(otherStore.saveBlock({
    userId: "user-1", pageId: "page-1", blockId: "block-1",
    payload: h.row.payload, expectedVersion: 1, revision: 1
  }), true);
  h.row.dataset.draftSourceId = "replacement-source";
  barrier.resolve();
  assert.equal(await delayedSave, null);
  assert.equal(h.requests.length, 0);
  assert.equal(h.blockDraft.payload.markdown, "old source payload");
  assert.ok(h.store.loadPage("user-1", "page-1", "replacement-source")?.blocks?.["block-1"]);
});


test("a same-revision replacement title during durability remains recoverable", async () => {
  const h = createHarness();
  h.editTitle("old title");
  const barrier = h.pauseNextSave();
  const delayedSave = h.saveTitle();
  h.context.elements.pageTitle.value = "replacement title";
  h.context.subject.persistPageTitleDraftValue("replacement title");
  barrier.resolve();
  assert.equal(await delayedSave, null);
  assert.equal(h.requests.length, 0);
  assert.equal(h.titleDraft.value, "replacement title");
});

test("a block marked for deletion during durability is not re-admitted", async () => {
  const h = createHarness();
  h.editBlock("pending deletion");
  const barrier = h.pauseNextSave();
  const delayedSave = h.saveBlock({ allowLocked: true });
  h.row.dataset.deleting = "true";
  barrier.resolve();
  assert.equal(await delayedSave, null);
  assert.equal(h.requests.length, 0);
  assert.equal(h.blockDraft.payload.markdown, "pending deletion");
});


// Follow-up audit: protect the earlier dirty/scheduling entry points, not only
// saveBlockRow's asynchronous admission boundary.
test("a detached dirty callback cannot replace the live row's durable recovery payload", () => {
  const h = createHarness();
  h.editBlock("older A");
  const stale = h.rebuildRow();
  h.editBlock("newer B");
  const before = JSON.stringify(h.blockDraft);
  const revision = stale.dataset.editRevision;
  const result = h.context.subject.markBlockDirty(stale);
  assert.equal(JSON.stringify(h.blockDraft), before, "stale input must not overwrite B in recovery storage");
  assert.equal(stale.dataset.editRevision, revision, "an obsolete callback must not manufacture a matching revision");
  assert.equal(h.histories.length, 0, "obsolete input must not enter undo history");
  assert.equal(result, false);
});

test("a detached scheduled callback cannot replace the live row's autosave timer", async () => {
  const h = createHarness();
  h.editBlock("older A");
  const stale = h.rebuildRow();
  h.editBlock("newer B");
  const timer = h.context.blockSaveTimers.get("block-1");
  const before = JSON.stringify(h.blockDraft);
  const result = h.context.subject.scheduleBlockSave(stale);
  assert.ok(h.timers.has(timer), "B's timer must survive stale scheduler admission");
  assert.equal(h.context.blockSaveTimers.get("block-1"), timer);
  assert.equal(h.context.blockSaveRows.get("block-1"), h.row);
  assert.equal(JSON.stringify(h.blockDraft), before);
  assert.equal(result, false);
  await h.saveBlock();
  assert.equal(h.serverMarkdown, "newer B");
});

test("a detached dirty callback cannot recreate recovery data after the newer save completes", async () => {
  const h = createHarness();
  h.editBlock("older A");
  const stale = h.rebuildRow();
  h.editBlock("newer B");
  await h.saveBlock();
  assert.equal(h.blockDraft, undefined);
  const historyCount = h.histories.length;
  assert.equal(h.context.subject.markBlockDirty(stale), false);
  assert.equal(h.blockDraft, undefined, "completed content must not acquire an obsolete recovery draft");
  assert.equal(h.serverMarkdown, "newer B");
  assert.equal(h.histories.length, historyCount);
});

test("a deleting row cannot admit another dirty or scheduled mutation", () => {
  const h = createHarness();
  h.editBlock("keep this recovery value");
  const before = JSON.stringify(h.blockDraft);
  const timer = h.context.blockSaveTimers.get("block-1");
  h.row.dataset.deleting = "true";
  h.row.payload.markdown = "late input during deletion";
  assert.equal(h.context.subject.markBlockDirty(h.row), false);
  assert.equal(h.context.subject.scheduleBlockSave(h.row), false);
  assert.equal(JSON.stringify(h.blockDraft), before);
  assert.ok(h.timers.has(timer), "an ignored callback cannot alter the deletion owner's timer state");
});

test("a row whose block left the selected page cannot write a recovery draft", () => {
  const h = createHarness();
  h.editBlock("existing draft");
  const before = JSON.stringify(h.blockDraft);
  h.context.state.selectedPage.blocks = [];
  h.row.payload.markdown = "input for a removed block";
  assert.equal(h.context.subject.markBlockDirty(h.row), false);
  assert.equal(JSON.stringify(h.blockDraft), before);
});

test("a previous page's direct callback cannot save its block under the new page's draft scope", async () => {
  const h = createHarness();
  h.editBlock("stale previous-page content");
  const stale = h.navigateToOtherPage();
  const result = await h.context.subject.saveBlockRow(stale, { quiet: true });
  assert.equal(h.requests.length, 0, "navigation must not re-scope an old row into a new page's save task");
  assert.equal(result, null);
  assert.equal(h.serverMarkdown, "original block");
  assert.equal(h.store.loadPage("user-1", "page-2", "tab-1"), null);
  assert.equal(h.blockDraft?.payload.markdown, "stale previous-page content");
});

test("a direct callback for a block absent from the selected model sends no PATCH", async () => {
  const h = createHarness();
  h.editBlock("keep recovery");
  const before = JSON.stringify(h.blockDraft);
  h.context.state.selectedPage.blocks = [];
  assert.equal(await h.saveBlock(), null);
  assert.equal(h.requests.length, 0);
  assert.equal(JSON.stringify(h.blockDraft), before);
});

test("a removed editor row cannot use the detached fallback after recovery durability settles", async () => {
  const h = createHarness();
  h.editBlock("keep recovery");
  const before = JSON.stringify(h.blockDraft);
  const barrier = h.pauseNextSave();
  const save = h.saveBlock();
  h.removeRenderedRow();
  barrier.resolve();
  assert.equal(await save, null);
  assert.equal(h.requests.length, 0);
  assert.equal(JSON.stringify(h.blockDraft), before);
});

test("a block removed from the model during durability is not admitted from a leftover row", async () => {
  const h = createHarness();
  h.editBlock("keep recovery");
  const before = JSON.stringify(h.blockDraft);
  const barrier = h.pauseNextSave();
  const save = h.saveBlock();
  h.context.state.selectedPage.blocks = [];
  barrier.resolve();
  assert.equal(await save, null);
  assert.equal(h.requests.length, 0);
  assert.equal(JSON.stringify(h.blockDraft), before);
});

test("a current dirty editor still schedules, saves, and acknowledges its payload", async () => {
  const h = createHarness();
  h.row.payload.markdown = "valid current input";
  assert.equal(h.context.subject.scheduleBlockSave(h.row), true);
  assert.equal(h.blockDraft?.payload.markdown, "valid current input");
  assert.ok(h.timers.has(h.context.blockSaveTimers.get("block-1")));
  await h.saveBlock();
  assert.equal(h.serverMarkdown, "valid current input");
  assert.equal(h.blockDraft, undefined);
});

test("a detached collaborative dirty callback cannot overwrite the live shared block", async () => {
  const h = createHarness();
  const stale = h.rebuildRow();
  h.row.payload.markdown = "new shared input";
  const mutations = [];
  h.context.isCollaborativePage = () => true;
  h.context.state.collaborationSession = {
    isReady: true, upsertBlock: async (block) => { mutations.push(block); return block; }
  };
  assert.equal(h.context.subject.markBlockDirty(stale), false);
  assert.equal(h.context.subject.scheduleBlockSave(stale), false);
  await Promise.resolve();
  assert.equal(mutations.length, 0, "obsolete editors must never submit to the active Yjs session");
  assert.equal(h.histories.length, 0);
});

test("a current collaborative dirty callback still submits and settles normally", async () => {
  const h = createHarness();
  h.row.payload.markdown = "valid shared input";
  const mutations = [];
  h.context.isCollaborativePage = () => true;
  h.context.state.collaborationSession = {
    isReady: true, upsertBlock: async (block) => { mutations.push(block); return block; }
  };
  assert.equal(h.context.subject.scheduleBlockSave(h.row), true);
  await Promise.resolve();
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].markdown, "valid shared input");
  assert.equal(h.context.collaborationBlockMutationPromises.size, 0);
  assert.equal(h.histories.length, 1);
  assert.equal(h.blockDraft, undefined);
});
