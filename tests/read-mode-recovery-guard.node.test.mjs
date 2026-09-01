import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const collaboration = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8");

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `${startText} must exist`);
  assert.notEqual(end, -1, `${endText} must exist after ${startText}`);
  return source.slice(start, end).trim();
}

test("same-page local draft recovery switches to write mode before activation", async () => {
  const openPageSource = sliceBetween(client, "async function openPage", "async function boot");
  const pageModes = Object.freeze({ READ: "read", WRITE: "write" });
  const state = {
    selectedPage: { id: "page-1", title: "server", blocks: [{ id: "b1" }] },
    allPages: [{ id: "page-1" }],
    workspaceView: "page",
    pageMode: pageModes.READ,
    pageEditLockDepth: 0,
    pendingFocusBlockId: null,
    activeCollectionId: null
  };
  let modeAtDraftActivation = null;
  const context = {
    state,
    pageModes,
    recoveryStoragePersistence: { isPersistent: () => true },
    isRecoveryStorageWritable: () => true,
    workspaceNavigationGeneration: 0,
    isCurrentWorkspaceNavigation: () => true,
    withPageEditLock: async (action) => action(),
    isCollectionPage: () => false,
    showCollection: async () => {},
    setStatus: () => {},
    t: (key) => key,
    api: async () => ({
      page: { id: "page-1", title: "server", blocks: [{ id: "b1" }], collaboration: { enabled: false } }
    }),
    destroyPageCollaboration: async () => {},
    closeSharePageDialog: () => {},
    closeShareCollectionDialog: () => {},
    resetPageEditTracking: () => {},
    resetPageComments: () => {},
    loadPageComments: async () => {},
    isCollaborativePage: (page) => Boolean(page?.collaboration?.enabled),
    applyPersistedPageDraft: (page) => {
      page.title = "recovered-local";
      return { title: { value: "recovered-local" }, blocks: [], blockOrder: null };
    },
    applyPageSummaryUpdate: () => {},
    renderSelectedPage: () => {},
    startPageCollaboration: async () => {},
    activatePersistedPageDraft: () => {
      modeAtDraftActivation = state.pageMode;
      return true;
    }
  };
  vm.createContext(context);
  vm.runInContext(`${openPageSource}\nthis.openPage = openPage;`, context);

  await context.openPage("page-1");

  assert.equal(modeAtDraftActivation, pageModes.WRITE);
  assert.equal(state.pageMode, pageModes.WRITE);
  assert.equal(state.selectedPage.title, "recovered-local");
});

test("collaboration recovery changes visible mode before recovered Yjs state can apply", async () => {
  const startSource = sliceBetween(client, "async function startPageCollaboration", "function getCollaborationField");
  const restoreSource = sliceBetween(
    collaboration,
    "  restoreLocalRecovery(documentEpoch)",
    "  persistRecoveryState"
  );
  const callbackIndex = restoreSource.indexOf("this.onBeforeLocalRecoveryApply");
  const applyIndex = restoreSource.indexOf("this.Y.applyUpdate(this.doc, record.update, RECOVERY_ORIGIN)");
  assert.ok(callbackIndex >= 0 && applyIndex > callbackIndex, "recovery gate must run before Yjs applyUpdate");

  const pageModes = Object.freeze({ READ: "read", WRITE: "write" });
  const page = { id: "page-1", collaboration: { enabled: true } };
  const state = {
    selectedPage: page,
    user: { id: "user-1" },
    pageMode: pageModes.READ,
    pendingFocusBlockId: "b1",
    collaborationGeneration: 0,
    collaborationStatus: "offline",
    collaborationPresence: [],
    collaborationSession: null
  };
  let modeObservedByRecoveryGate = null;
  const fakeSession = { isReady: false, destroy: async () => {} };
  const context = {
    state,
    pageModes,
    pageDraftSourceId: "tab-1",
    collaborationRecoveryStore: {},
    recoveryStoragePersistence: { isPersistent: () => true },
    isRecoveryStorageWritable: () => true,
    isCollaborativePage: (candidate) => Boolean(candidate?.collaboration?.enabled),
    isPageReadOnly: () => state.pageMode !== pageModes.WRITE,
    syncPageModeUi: () => {},
    renderCollaborationChrome: () => {},
    applyCollaborationSnapshot: () => {},
    applyCollaborationMaterialization: () => {},
    handleCollaborationAccessChanged: () => {},
    setStatus: () => {},
    t: (key) => key,
    console,
    api: async () => ({}),
    createPageCollaboration: async (options) => {
      const allowed = options.onBeforeLocalRecoveryApply({ documentEpoch: "epoch-1", recordCount: 1 });
      modeObservedByRecoveryGate = state.pageMode;
      assert.equal(allowed, true);
      return fakeSession;
    }
  };
  vm.createContext(context);
  vm.runInContext(`${startSource}\nthis.startPageCollaboration = startPageCollaboration;`, context);

  await context.startPageCollaboration(page);

  assert.equal(modeObservedByRecoveryGate, pageModes.WRITE);
  assert.equal(state.pageMode, pageModes.WRITE);
  assert.equal(state.pendingFocusBlockId, null);
  assert.equal(state.collaborationSession, fakeSession);
});

test("pending block-order retries cannot persist while the page is read-only", async () => {
  const retrySource = sliceBetween(client, "async function retryPendingBlockOrder", "async function persistBlockOrder");
  const pageModes = Object.freeze({ READ: "read", WRITE: "write" });
  const state = {
    selectedPage: { id: "page-1" },
    workspaceView: "page",
    pageMode: pageModes.READ
  };
  const task = {
    pageId: "page-1",
    parentBlockId: null,
    previousIds: ["a", "b"],
    authenticationScope: { generation: 1 }
  };
  let submitCount = 0;
  const context = {
    state,
    pendingBlockOrderTask: task,
    blockOrderSaving: false,
    skippedApiRequest: Symbol("skipped-api-request"),
    canPersistSelectedPage: () => Boolean(
      state.selectedPage
      && state.workspaceView === "page"
      && state.pageMode === pageModes.WRITE
    ),
    syncPageModeUi: () => {},
    syncBeforeUnloadProtection: () => {},
    submitBlockOrderTaskWithReplay: async () => {
      submitCount += 1;
      return { blocks: [] };
    },
    acknowledgeBlockOrderDraft: () => {},
    renderSelectedPage: () => {},
    setStatus: () => {},
    t: (key) => key,
    isCurrentAuthenticatedSessionScope: () => true,
    assertCurrentAuthenticatedSessionScope: () => {},
    isDefinitiveApiError: () => false,
    reorderBlockSiblingsInState: () => {}
  };
  vm.createContext(context);
  vm.runInContext(`${retrySource}\nthis.retryPendingBlockOrder = retryPendingBlockOrder;`, context);

  await context.retryPendingBlockOrder();
  assert.equal(submitCount, 0);
  assert.equal(context.pendingBlockOrderTask, task);

  state.pageMode = pageModes.WRITE;
  await context.retryPendingBlockOrder();
  assert.equal(submitCount, 1);
  assert.equal(context.pendingBlockOrderTask, null);
});
