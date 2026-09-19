import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// These are deterministic production-function tests, not browser/IndexedDB or
// database integration tests. Model flush/refresh settlement independently so
// an old recovery callback can be resumed on either side of an editor change.
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
const tick = () => new Promise((resolve) => setImmediate(resolve));
const clone = (value) => JSON.parse(JSON.stringify(value));
const payload = (markdown) => ({ type: "MARKDOWN", markdown, checked: false, metadata: null });

class Element {
  constructor(value = "", dataset = {}) {
    this.value = value;
    this.payload = payload(value);
    this.dataset = { ...dataset };
    this.isConnected = true;
    this.attributes = new Map();
    const values = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => values.add(name)),
      remove: (...names) => names.forEach((name) => values.delete(name)),
      contains: (name) => values.has(name)
    };
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
}

function harness() {
  let row;
  const durability = [], refreshes = [], failures = [], statuses = [], renders = [];
  const timers = new Set([1]);
  let pauseRefresh = false;
  let failRefresh = false;
  const context = vm.createContext({
    console, Error, HTMLElement: Element,
    state: {
      authenticated: true, user: { id: "owner", workspaceGeneration: 1 },
      workspaceView: "page",
      selectedPage: { id: "page-1", title: "canonical title", blocks: [{ id: "block-1", ...payload("canonical block") }] }
    },
    elements: { pageTitle: new Element("title A") },
    authenticationSessionGeneration: 1,
    workspaceNavigationGeneration: 1,
    pageTitleEditRevision: 1,
    pageTitleSavedRevision: 0,
    pageTitleDraftSourceId: "tab-1",
    pageDraftSourceId: "tab-1",
    pageTitleDraftExpectedVersion: 1,
    pageTitleLastDurableValue: "durable title",
    blockSaveTimers: new Map([["block-1", 1]]),
    blockSaveRows: new Map(),
    pageDraftStore: { loadPage: () => null },
    recoveryStorage: {
      flush() {
        const operation = deferred();
        durability.push(operation);
        return operation.promise;
      },
      refresh() {
        const operation = deferred();
        refreshes.push(operation);
        if (failRefresh) operation.reject(new Error("refresh failed"));
        else if (!pauseRefresh) operation.resolve();
        return operation.promise;
      }
    },
    getAccountAvatarTargetKey: (user) => user?.id ?? null,
    isCurrentWorkspaceNavigation: (generation) => generation === context.workspaceNavigationGeneration,
    isCollaborativePage: () => Boolean(context.state.selectedPage?.collaboration?.enabled),
    getDraftScope: (pageId) => ({ userId: context.state.user.id, pageId }),
    getPositiveVersion: (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null,
    getBlockById: (id) => context.state.selectedPage?.blocks.find((block) => block.id === id),
    findRenderedBlockRow: (id) => row?.dataset.blockId === id ? row : null,
    buildBlockPayload: (element) => clone(element.payload),
    jsonValuesMatch: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    handleDurableRecoveryStorageWriteError: (error) => failures.push(error),
    preserveInputAfterRecoveryAdmissionFailure: () => assert.fail("visible admission uses preserveInput=false"),
    syncBeforeUnloadProtection: () => {},
    setStatus: (value) => statuses.push(value),
    t: (key) => key,
    updateInputValuePreservingSelection: (element, value) => { element.value = value; },
    applyPageSummaryUpdate: (id, changes) => {
      if (context.state.selectedPage?.id === id) Object.assign(context.state.selectedPage, changes);
    },
    window: { clearTimeout: (id) => timers.delete(id) },
    captureCollaborationEditorFocus: () => null,
    getBlockRenderDraft: () => null,
    renderBlock: (block) => { renders.push({ kind: "block", id: block.id }); return makeRow(block.markdown); },
    renderSelectedPage: () => {
      renders.push({ kind: "page", id: context.state.selectedPage.id });
      context.elements.pageTitle.value = context.state.selectedPage.title;
    },
    syncBlockReadOnlyState: () => {},
    requestAnimationFrame: (callback) => callback(),
    restoreCollaborationEditorFocus: () => {},
    hydrateMathExpressions: () => {},
    renderCollaborationPresence: () => {}
  });
  function makeRow(value, dataset = { blockId: "block-1", editRevision: "1", draftSourceId: "tab-1" }) {
    const element = new Element(value, dataset);
    element.replaceWith = (replacement) => {
      element.isConnected = false;
      if (row === element) row = replacement;
    };
    return element;
  }
  row = makeRow("block A");
  vm.runInContext([
    section("function getUserWorkspaceGeneration(", "function assertCurrentAuthenticatedSessionScope("),
    section("async function requireDirectRecoveryDurability(", "function persistPageTitleDraftValue("),
    section("function cancelScheduledBlockSave(", "function rejectLocalBlockMutation("),
    "globalThis.subject = {beginDirectRecoveryVisibilityAdmission, scheduleDirectTitleRecoveryAdmission, scheduleDirectBlockRecoveryAdmission};"
  ].join("\n"), context);

  return {
    context, durability, refreshes, failures, statuses, renders, timers,
    get row() { return row; },
    element(kind) { return kind === "title" ? context.elements.pageTitle : row; },
    start(kind) {
      const element = this.element(kind);
      const sequence = context.subject.beginDirectRecoveryVisibilityAdmission(element);
      if (kind === "title") context.subject.scheduleDirectTitleRecoveryAdmission(sequence, context.state.selectedPage.id);
      else context.subject.scheduleDirectBlockRecoveryAdmission(element, sequence);
      return sequence;
    },
    edit(kind, value = "newer B") {
      const element = this.element(kind);
      element.value = value;
      element.payload = payload(value);
      if (kind === "title") context.pageTitleEditRevision += 1;
      else element.dataset.editRevision = String(Number(element.dataset.editRevision) + 1);
    },
    rebuild(kind, value = "replacement B") {
      const old = this.element(kind);
      old.isConnected = false;
      if (kind === "title") {
        context.elements.pageTitle = new Element(value);
        context.pageTitleEditRevision = 1;
      } else row = makeRow(value);
      return old;
    },
    resetTitle(value = "replacement B") {
      delete context.elements.pageTitle.dataset.recoveryAdmissionSequence;
      context.elements.pageTitle.value = value;
      context.pageTitleEditRevision = 1;
    },
    pauseRefresh() { pauseRefresh = true; },
    failRefresh() { failRefresh = true; },
    async settle(index, outcome) {
      if (outcome === "success") durability[index].resolve();
      else durability[index].reject(new Error("old recovery transaction failed"));
      await tick();
    }
  };
}

for (const kind of ["title", "block"]) {
  test(`current ${kind} recovery success releases its own visibility fence`, async () => {
    const h = harness();
    h.start(kind);
    assert.equal(h.element(kind).classList.contains("recovery-admission-pending"), true);
    await h.settle(0, "success");
    assert.equal(h.element(kind).classList.contains("recovery-admission-pending"), false);
    assert.equal(h.element(kind).attributes.has("aria-busy"), false);
    assert.equal(h.failures.length, 0);
    if (kind === "title") assert.equal(h.context.pageTitleLastDurableValue, "title A");
  });

  for (const refreshFailure of [false, true]) {
    test(`current ${kind} recovery failure retains rollback behavior (refresh failure=${refreshFailure})`, async () => {
      const h = harness();
      if (refreshFailure) h.failRefresh();
      h.start(kind);
      await h.settle(0, "failure");
      assert.equal(h.failures.length, 1, "storage failure must still fail closed");
      assert.equal(h.refreshes.length, 1);
      assert.equal(h.element(kind).classList.contains("recovery-admission-pending"), false);
      assert.equal(h.element(kind).value, kind === "title" ? "durable title" : "canonical block");
      assert.equal(h.statuses.length, 1);
    });
  }

  for (const outcome of ["success", "failure"]) {
    for (const boundary of ["new-edit", "rebuild", "authentication", "workspace-restore", "same-page-navigation", "collaboration-mode", "source-change"]) {
      test(`obsolete ${kind} ${outcome} cannot affect ${boundary} recovery`, async () => {
        const h = harness();
        h.start(kind);
        if (boundary === "new-edit") h.edit(kind);
        else if (boundary === "rebuild") h.rebuild(kind);
        else {
          if (boundary === "authentication") {
            h.context.authenticationSessionGeneration += 1;
            h.context.state.user = { id: "other-user", workspaceGeneration: 1 };
          }
          if (boundary === "workspace-restore") h.context.state.user.workspaceGeneration += 1;
          if (boundary === "same-page-navigation") h.context.workspaceNavigationGeneration += 1;
          if (boundary === "collaboration-mode") h.context.state.selectedPage.collaboration = { enabled: true };
          if (boundary === "source-change") {
            if (kind === "title") h.context.pageTitleDraftSourceId = "other-source";
            else h.row.dataset.draftSourceId = "other-source";
          }
          // Reuse the sequence number deliberately: page/row reconstruction can
          // restart it at 1, so the number alone is not an ownership identity.
          if (kind === "title") h.resetTitle();
          else {
            h.row.value = "replacement B";
            h.row.payload = payload("replacement B");
            delete h.row.dataset.recoveryAdmissionSequence;
          }
        }
        const current = h.element(kind);
        // Install the new pending fence without creating a second callback. The
        // test must not rely on the new writer resolving or rejecting first.
        h.context.subject.beginDirectRecoveryVisibilityAdmission(current);
        const expected = current.value;
        await h.settle(0, outcome);
        assert.equal(h.element(kind), current, "old failure cannot replace the new editor");
        assert.equal(current.value, expected, "new visible input must survive");
        assert.equal(current.classList.contains("recovery-admission-pending"), true, "old success cannot certify the newer write");
        assert.equal(h.refreshes.length, 0, "obsolete callback must not initiate recovery refresh");
        assert.equal(h.renders.length, 0);
        assert.equal(h.statuses.length, 0);
        if (kind === "block") assert.equal(h.timers.has(1), true, "new autosave must not be cancelled");
        if (kind === "title") assert.equal(h.context.pageTitleLastDurableValue, "durable title");
      });
    }
  }

  for (const boundary of ["rebuild", "authentication", "same-page-navigation", "collaboration-mode"]) {
    test(`${kind} failure revalidates ownership after a delayed recovery refresh (${boundary})`, async () => {
      const h = harness();
      h.pauseRefresh();
      h.start(kind);
      await h.settle(0, "failure");
      assert.equal(h.refreshes.length, 1, "refresh starts while the admission is still current");
      if (boundary === "rebuild") h.rebuild(kind);
      else {
        if (boundary === "authentication") h.context.authenticationSessionGeneration += 1;
        if (boundary === "same-page-navigation") h.context.workspaceNavigationGeneration += 1;
        if (boundary === "collaboration-mode") h.context.state.selectedPage.collaboration = { enabled: true };
        if (kind === "title") h.resetTitle();
        else { h.row.value = "replacement B"; h.row.payload = payload("replacement B"); delete h.row.dataset.recoveryAdmissionSequence; }
      }
      const current = h.element(kind);
      h.context.subject.beginDirectRecoveryVisibilityAdmission(current);
      h.refreshes[0].resolve();
      await tick();
      assert.equal(h.element(kind), current);
      assert.equal(current.value, "replacement B");
      assert.equal(current.classList.contains("recovery-admission-pending"), true);
      assert.equal(h.renders.length, 0);
      assert.equal(h.statuses.length, 0);
    });
  }
}

for (const outcome of ["success", "failure"]) {
  for (const boundary of ["deleting", "removed-from-model"]) {
    test(`old block ${outcome} cannot settle an editor that is ${boundary}`, async () => {
      const h = harness();
      h.start("block");
      if (boundary === "deleting") h.row.dataset.deleting = "true";
      else h.context.state.selectedPage.blocks = [];
      await h.settle(0, outcome);
      assert.equal(h.row.classList.contains("recovery-admission-pending"), true);
      assert.equal(h.renders.length, 0);
      assert.equal(h.refreshes.length, 0);
      assert.equal(h.timers.has(1), true);
    });
  }
}

test("a detached old block failure cannot rerender and erase another page's in-progress title", async () => {
  const h = harness();
  h.start("block");
  h.row.isConnected = false;
  h.context.workspaceNavigationGeneration += 1;
  h.context.state.selectedPage = { id: "page-2", title: "page 2 canonical", blocks: [] };
  h.context.elements.pageTitle.value = "page 2 UNSAVED";
  await h.settle(0, "failure");
  assert.equal(h.context.elements.pageTitle.value, "page 2 UNSAVED");
  assert.equal(h.renders.length, 0);
});

test("a current blank title remains a blank durable value", async () => {
  const h = harness();
  h.context.elements.pageTitle.value = "";
  h.start("title");
  await h.settle(0, "success");
  assert.equal(h.context.pageTitleLastDurableValue, "");
  assert.equal(h.context.elements.pageTitle.value, "");
});

test("title recovery failure still selects the current source's durable draft", async () => {
  const h = harness();
  h.context.pageDraftStore.loadPage = (user, page, source) => {
    assert.deepEqual([user, page, source], ["owner", "page-1", "tab-1"]);
    return { title: { value: "durable recovered draft", revision: 7, expectedVersion: 9 } };
  };
  h.start("title");
  await h.settle(0, "failure");
  assert.equal(h.context.elements.pageTitle.value, "durable recovered draft");
  assert.equal(h.context.pageTitleEditRevision, 7);
  assert.equal(h.context.pageTitleDraftExpectedVersion, 9);
});
