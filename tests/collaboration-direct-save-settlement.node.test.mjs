import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Exercise the production browser entry points with controlled local-mutation
// settlement. No network, live Yjs document, IndexedDB, or MariaDB is simulated
// as a passing integration test: the scope here is browser callback ownership.
const app = readFileSync(
  process.env.BRAINVAULT_QA_APP_SOURCE ?? new URL("../public/app.js", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

function section(start, end) {
  const a = app.indexOf(start);
  const b = app.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `production source boundary: ${start}`);
  return app.slice(a, b);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function classes(...names) {
  const values = new Set(names);
  return {
    add: (...items) => items.forEach((item) => values.add(item)),
    remove: (...items) => items.forEach((item) => values.delete(item)),
    contains: (item) => values.has(item)
  };
}
const clone = (value) => JSON.parse(JSON.stringify(value));
const payload = (markdown) => ({ type: "MARKDOWN", markdown, checked: false, metadata: null });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const authenticationScope = Object.freeze({ userId: "owner", generation: 1 });
  let row = { dataset: { blockId: "block-1", editRevision: "1" }, payload: payload("initial block"), classList: classes() };
  const requests = [];
  const rejections = [];
  const histories = [];
  const statuses = [];
  const recoveryFailures = [];
  const page = { id: "page-1", title: "initial title", blocks: [{ id: "block-1", ...payload("initial block") }] };
  const begin = (kind, value) => {
    const operation = { kind, value: clone(value), ...deferred() };
    requests.push(operation);
    return operation.promise;
  };
  const session = {
    isReady: true,
    setTitle: (value) => begin("title", value),
    upsertBlock: (value) => begin("block", value)
  };
  const context = vm.createContext({
    console,
    state: { user: { id: "owner" }, selectedPage: page, pages: [], allPages: [], collaborationSession: session },
    elements: { pageTitle: { value: page.title, classList: classes() } },
    document: { activeElement: null },
    window: { setTimeout: () => 1 },
    workspaceNavigationGeneration: 1,
    pageTitleEditAuthenticationScope: null,
    pageTitleDraftConflict: false,
    pageDraftSourceId: "tab-1",
    blockEditAuthenticationScopes: new Map(),
    collaborationBlockMutationPromises: new Map(),
    collaborationTitleMutationPromise: null,
    captureAuthenticatedSessionScope: () => authenticationScope,
    isCurrentAuthenticatedSessionScope: (scope) => scope === authenticationScope && context.state.user?.id === "owner",
    assertCurrentAuthenticatedSessionScope: (scope) => assert.equal(context.isCurrentAuthenticatedSessionScope(scope), true),
    requireWritablePage: () => true,
    canPersistSelectedPage: () => true,
    isCollaborativePage: () => true,
    findRenderedBlockRow: (id) => row?.dataset.blockId === id ? row : null,
    getBlockById: (id) => context.state.selectedPage?.blocks.find((block) => block.id === id),
    getPageSummaryLookup: (pages) => new Map(pages.map((value) => [value.id, value])),
    buildBlockPayload: (value) => clone(value.payload),
    jsonValuesMatch: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    normalizeParentBlockId: (id) => id || null,
    normalizePageTitle: (value) => value.trim() || "New document",
    updateRenderedBlockPreview: (target, value) => { target.preview = clone(value); },
    // Observe calls to the existing destructive UI-restore handler. Replacing
    // the editor with canonical data is represented by copying its payload.
    rejectLocalBlockMutation: (target, error) => {
      rejections.push({ target, error });
      if (error.code === "COLLABORATION_RECOVERY_WRITE_FAILED") {
        target.classList.add("is-dirty", "save-error");
        recoveryFailures.push(error);
      } else {
        target.payload = payload(context.getBlockById(target.dataset.blockId)?.markdown ?? "");
      }
    },
    handleDurableRecoveryStorageWriteError: (error) => recoveryFailures.push(error),
    updateInputValuePreservingSelection: (input, value) => { input.value = value; },
    getRejectedLocalMutationMessage: (error) => error.message,
    recordBlockEditorHistory: (_target, value) => histories.push({ kind: "block", value: value.markdown }),
    recordPageTitleEditorHistory: (value) => histories.push({ kind: "title", value }),
    renderPageHeader: () => {},
    updateCollaborationAwareness: () => {},
    syncBeforeUnloadProtection: () => {},
    setStatus: (value) => statuses.push(value),
    t: (key) => key
  });
  vm.runInContext([
    section("function isCurrentCollaborationMutationContext(", "function cancelScheduledBlockSave("),
    section("function markBlockDirty(", "function getBlockSaveQueue("),
    section("async function saveBlockRow(", "function scheduleBlockSave("),
    section("async function savePageTitleNow(", "function schedulePageTitleSave("),
    // Only the collaborative branch is needed; end at the first direct-mode statement.
    section("function schedulePageTitleSave(", "  const pageId = state.selectedPage.id;\n  const previousAuthenticationScope") + "}\n",
    "globalThis.subject = {saveBlockRow, savePageTitleNow, markBlockDirty, schedulePageTitleSave};"
  ].join("\n"), context);
  return {
    context, session, requests, rejections, histories, statuses, recoveryFailures,
    get row() { return row; },
    input(kind, value) {
      if (kind === "title") context.elements.pageTitle.value = value;
      else { row.payload = payload(value); row.classList.add("is-dirty"); }
    },
    value(kind) { return kind === "title" ? context.elements.pageTitle.value : row.payload.markdown; },
    direct(kind) { return kind === "title" ? context.subject.savePageTitleNow() : context.subject.saveBlockRow(row, { quiet: true }); },
    scheduled(kind) { return kind === "title" ? context.subject.schedulePageTitleSave() : context.subject.markBlockDirty(row); },
    pending(kind) { return kind === "title" ? context.collaborationTitleMutationPromise : context.collaborationBlockMutationPromises.get("block-1"); },
    rebuild() {
      const previous = row;
      row = { dataset: { ...previous.dataset }, payload: clone(previous.payload), classList: classes("is-dirty", "is-saving") };
      return previous;
    },
    removeRow() { row = null; },
    async resolve(index) {
      const operation = requests[index];
      operation.resolve(operation.kind === "block" ? clone(operation.value) : true);
      await tick();
    },
    async reject(index, error = new Error("local mutation failed")) {
      requests[index].reject(error);
      await tick();
    }
  };
}

for (const kind of ["title", "block"]) {
  test(`late direct ${kind} failure cannot restore over newer scheduled input`, async () => {
    const h = harness();
    h.input(kind, "A");
    const old = h.direct(kind);
    const oldOutcome = old.catch((error) => error);
    h.input(kind, "B");
    assert.equal(h.scheduled(kind), true);
    await h.reject(0);
    await oldOutcome;
    assert.equal(h.value(kind), "B", "newer visible user input must survive");
    assert.equal(h.rejections.length, 0, "obsolete failures cannot trigger editor restore");
    assert.equal(h.pending(kind), h.requests[1].promise, "newer mutation remains tracked");
    await h.resolve(1);
  });

  test(`direct ${kind} success cannot acknowledge a newer scheduled mutation`, async () => {
    const h = harness();
    h.input(kind, "A");
    const old = h.direct(kind);
    h.input(kind, "B");
    assert.equal(h.scheduled(kind), true);
    await h.resolve(0);
    await old;
    assert.equal(h.pending(kind), h.requests[1].promise);
    assert.equal(h.histories.length, 0, "obsolete direct completion cannot publish history");
    if (kind === "block") {
      assert.equal(h.row.classList.contains("is-dirty"), true);
      assert.equal(h.row.classList.contains("is-saving"), true);
      assert.equal(h.row.preview, undefined, "old content cannot replace the newer preview");
    }
    await h.resolve(1);
  });

  test(`a direct ${kind} mutation supersedes an older scheduled completion`, async () => {
    const h = harness();
    h.input(kind, "A");
    assert.equal(h.scheduled(kind), true);
    h.input(kind, "B");
    const latest = h.direct(kind);
    assert.equal(h.pending(kind), h.requests[1].promise, "direct and scheduled paths share ownership");
    await h.resolve(0);
    assert.equal(h.histories.length, 0);
    assert.equal(h.pending(kind), h.requests[1].promise);
    await h.resolve(1);
    await latest;
    assert.equal(Boolean(h.pending(kind)), false);
  });

  test(`same-payload ABA ${kind} input still belongs to the newest mutation`, async () => {
    const h = harness();
    h.input(kind, "A");
    const oldest = h.direct(kind);
    h.input(kind, "B"); h.scheduled(kind);
    h.input(kind, "A"); h.scheduled(kind);
    await h.resolve(0);
    await oldest;
    assert.equal(h.histories.length, 0, "text equality does not imply mutation ownership");
    assert.equal(h.pending(kind), h.requests[2].promise);
    await h.resolve(1); await h.resolve(2);
  });

  test(`normal direct ${kind} success still settles and releases ownership`, async () => {
    const h = harness(); h.input(kind, "current");
    const saving = h.direct(kind);
    await h.resolve(0);
    const result = await saving;
    assert.ok(result);
    assert.equal(h.value(kind), "current");
    assert.equal(Boolean(h.pending(kind)), false);
    assert.equal(h.histories.length, 1);
  });

  test(`current direct ${kind} failure still propagates`, async () => {
    const h = harness(); h.input(kind, "current");
    const saving = h.direct(kind);
    const failure = assert.rejects(saving, /local mutation failed/);
    await h.reject(0); await failure;
    assert.equal(Boolean(h.pending(kind)), false);
  });

  test(`current direct ${kind} recovery-storage failure preserves visible text`, async () => {
    const h = harness(); h.input(kind, "precious input");
    const saving = h.direct(kind);
    const error = Object.assign(new Error("storage failed"), { code: "COLLABORATION_RECOVERY_WRITE_FAILED" });
    const failure = assert.rejects(saving, { code: error.code });
    await h.reject(0, error); await failure;
    assert.equal(h.value(kind), "precious input");
    assert.equal(h.recoveryFailures.length, 1);
  });

  test(`replaced-session direct ${kind} completion cannot touch the replacement`, async () => {
    const h = harness(); h.input(kind, "old session input");
    const saving = h.direct(kind);
    h.context.state.collaborationSession = { isReady: true };
    await h.resolve(0);
    assert.equal(await saving, null);
    assert.equal(h.histories.length, 0);
  });
}

test("direct title failure cannot erase a newer unscheduled blank", async () => {
  const h = harness(); h.input("title", "A");
  const saving = h.direct("title"); const outcome = saving.catch((error) => error);
  h.input("title", "");
  await h.reject(0); await outcome;
  assert.equal(h.value("title"), "");
});

test("direct block completion follows an equivalent rebuilt live row", async () => {
  const h = harness(); h.input("block", "current");
  const saving = h.direct("block");
  const oldRow = h.rebuild();
  await h.resolve(0); await saving;
  assert.equal(h.row.classList.contains("is-dirty"), false);
  assert.equal(h.row.preview?.markdown, "current");
  assert.equal(oldRow.preview, undefined);
});

for (const removal of ["row", "model", "deleting"]) {
  test(`direct block failure cannot restore a ${removal}-removed editor`, async () => {
    const h = harness(); h.input("block", "A");
    const saving = h.direct("block"); const outcome = saving.catch((error) => error);
    if (removal === "row") h.removeRow();
    else if (removal === "model") h.context.state.selectedPage.blocks = [];
    else h.row.dataset.deleting = "true";
    await h.reject(0); await outcome;
    assert.equal(h.rejections.length, 0);
  });
}
