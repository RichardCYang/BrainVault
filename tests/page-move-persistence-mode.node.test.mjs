import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert.ok(start >= 0 && end > start, `missing source section: ${startNeedle}`);
  return source.slice(start, end);
}

test("reproduction: old page-move state leaves a selected descendant in the wrong persistence mode", () => {
  const selectedDescendant = {
    id: "child",
    collaboration: { enabled: false, participantCount: 1 }
  };
  const serverAfterMove = {
    id: "child",
    collaboration: { enabled: true, participantCount: 2 }
  };

  // The vulnerable move path merged only the moved root's parent metadata. A
  // selected descendant was never refreshed even though collection membership
  // changes can switch the whole subtree from direct writes to Yjs.
  const oldClientState = structuredClone(selectedDescendant);
  assert.equal(oldClientState.collaboration.enabled, false);
  assert.equal(serverAfterMove.collaboration.enabled, true);

  // The fixed path refreshes page summaries after the scope transition and
  // copies the authoritative collaboration payload onto the selected page.
  const fixedClientState = structuredClone(selectedDescendant);
  fixedClientState.collaboration = { ...serverAfterMove.collaboration };
  assert.equal(fixedClientState.collaboration.enabled, true);
});

test("collection-scope page moves drain browser writers and fence both recovery stores", () => {
  const move = section(
    client,
    "async function moveNavigationPageToParent(",
    "function findPendingPageDeleteTask"
  );

  assert.match(move, /const affectedPageIds = getPageSubtreeIds\(pageId\)/);
  assert.match(move, /const selectedPageAffected = Boolean\(selectedPageId && affectedPageIds\.has\(selectedPageId\)\)/);
  assert.match(move, /const collectionScopeChanged = sourceCollectionId !== destinationCollectionId/);
  assert.match(move, /withWorkspacePersistenceTransitionForOwner\(sourcePage\.ownerId, "page-move"/);
  assert.match(move, /assertNoPendingLocalPageDraftsForPages\([\s\S]*?affectedPageIds/);
  assert.match(move, /assertNoPendingLocalCollaborationRecoveryForPages\(affectedPageIds\)/);
  assert.match(move, /\{ flush: mustFlushSelectedPage \}/);
});

test("post-move reconciliation refreshes descendants and restarts a rotated collaboration lineage", () => {
  const refresh = section(
    client,
    "async function refreshPageMovePersistenceMode(",
    "async function moveNavigationPageToParent("
  );

  assert.match(refresh, /await loadPages\(elements\.searchInput\.value\.trim\(\), state\.activeTag\)/);
  assert.match(refresh, /state\.selectedPage\.collaboration = \{ \.\.\.summary\.collaboration \}/);
  assert.match(refresh, /if \(selectedPageWasCollaborative \|\| selectedPageIsCollaborative\)/);
  assert.match(refresh, /await destroyPageCollaboration\(\{ flush: false \}\)/);
  assert.match(refresh, /if \(selectedPageIsCollaborative\) await startPageCollaboration\(state\.selectedPage\)/);
  assert.match(
    refresh,
    /state\.pageMode = pageModes\.READ/,
    "if the authoritative post-commit mode cannot be refreshed, editing must fail closed"
  );
});

test("post-commit page-summary refresh failure leaves the affected selection read-only", async () => {
  const refresh = section(
    client,
    "async function refreshPageMovePersistenceMode(",
    "async function moveNavigationPageToParent("
  );
  const events = [];
  const sandbox = {
    state: {
      selectedPage: {
        id: "child",
        collaboration: { enabled: false, participantCount: 1 },
        access: { canEdit: true }
      },
      activeTag: "",
      pageMode: "WRITE"
    },
    elements: { searchInput: { value: "" } },
    pageModes: { READ: "READ" },
    isCurrentAuthenticatedSessionScope: () => true,
    isCurrentWorkspaceNavigation: () => true,
    loadPages: async () => {
      events.push("load");
      throw new Error("refresh failed");
    },
    getPageSummaryById: () => null,
    isCollaborativePage: (page) => Boolean(page?.collaboration?.enabled),
    destroyPageCollaboration: async () => {
      events.push("destroy");
      throw new Error("teardown failed");
    },
    renderSelectedPage: () => events.push("render"),
    startPageCollaboration: async () => events.push("start"),
    console: { error: () => events.push("teardown-error") },
    t: (key) => key,
    Set,
    Error,
    result: null
  };

  vm.runInNewContext(
    `${refresh}
result = refreshPageMovePersistenceMode(
  new Set(["root", "child"]),
  "child",
  false,
  { generation: 1 },
  7
);`,
    sandbox
  );
  await assert.rejects(sandbox.result, /refresh failed/);
  assert.equal(sandbox.state.pageMode, "READ");
  assert.deepEqual(events, ["load", "destroy", "teardown-error", "render"]);
});

test("failed post-move refresh does not alter an unrelated current selection", async () => {
  const refresh = section(
    client,
    "async function refreshPageMovePersistenceMode(",
    "async function moveNavigationPageToParent("
  );
  const events = [];
  const sandbox = {
    state: {
      selectedPage: {
        id: "other",
        collaboration: { enabled: false, participantCount: 1 },
        access: { canEdit: true }
      },
      activeTag: "",
      pageMode: "WRITE"
    },
    elements: { searchInput: { value: "" } },
    pageModes: { READ: "READ" },
    isCurrentAuthenticatedSessionScope: () => true,
    isCurrentWorkspaceNavigation: () => true,
    loadPages: async () => {
      events.push("load");
      throw new Error("refresh failed");
    },
    getPageSummaryById: () => null,
    isCollaborativePage: (page) => Boolean(page?.collaboration?.enabled),
    destroyPageCollaboration: async () => events.push("destroy"),
    renderSelectedPage: () => events.push("render"),
    startPageCollaboration: async () => events.push("start"),
    console,
    t: (key) => key,
    Set,
    Error,
    result: null
  };

  vm.runInNewContext(
    `${refresh}
result = refreshPageMovePersistenceMode(
  new Set(["root", "child"]),
  "child",
  false,
  { generation: 1 },
  7
);`,
    sandbox
  );
  await assert.rejects(sandbox.result, /refresh failed/);
  assert.equal(sandbox.state.pageMode, "WRITE");
  assert.deepEqual(events, ["load"]);
});

test("runtime reconciliation switches the selected descendant onto the authoritative post-move mode", async () => {
  const refresh = section(
    client,
    "async function refreshPageMovePersistenceMode(",
    "async function moveNavigationPageToParent("
  );
  const events = [];
  const summary = {
    id: "child",
    collaboration: { enabled: true, participantCount: 2 },
    access: { canEdit: true }
  };
  const sandbox = {
    state: {
      selectedPage: {
        id: "child",
        collaboration: { enabled: false, participantCount: 1 },
        access: { canEdit: true }
      },
      activeTag: "",
      pageMode: "WRITE"
    },
    elements: { searchInput: { value: "" } },
    pageModes: { READ: "READ" },
    isCurrentAuthenticatedSessionScope: () => true,
    isCurrentWorkspaceNavigation: () => true,
    loadPages: async () => events.push("load"),
    getPageSummaryById: () => summary,
    isCollaborativePage: (page) => Boolean(page?.collaboration?.enabled),
    destroyPageCollaboration: async () => events.push("destroy"),
    renderSelectedPage: () => events.push("render"),
    startPageCollaboration: async () => events.push("start"),
    t: (key) => key,
    Set,
    Error,
    result: null
  };

  vm.runInNewContext(
    `${refresh}
result = refreshPageMovePersistenceMode(
  new Set(["root", "child"]),
  "child",
  false,
  { generation: 1 },
  7
);`,
    sandbox
  );
  assert.equal(await sandbox.result, true);
  assert.equal(sandbox.state.selectedPage.collaboration.enabled, true);
  assert.deepEqual(events, ["load", "destroy", "render", "start"]);
});

test("runtime reconciliation tears down an old Yjs lineage when the moved subtree becomes private", async () => {
  const refresh = section(
    client,
    "async function refreshPageMovePersistenceMode(",
    "async function moveNavigationPageToParent("
  );
  const events = [];
  const summary = {
    id: "child",
    collaboration: { enabled: false, participantCount: 1 },
    access: { canEdit: true }
  };
  const sandbox = {
    state: {
      selectedPage: {
        id: "child",
        collaboration: { enabled: true, participantCount: 2 },
        access: { canEdit: true }
      },
      activeTag: "",
      pageMode: "WRITE"
    },
    elements: { searchInput: { value: "" } },
    pageModes: { READ: "READ" },
    isCurrentAuthenticatedSessionScope: () => true,
    isCurrentWorkspaceNavigation: () => true,
    loadPages: async () => events.push("load"),
    getPageSummaryById: () => summary,
    isCollaborativePage: (page) => Boolean(page?.collaboration?.enabled),
    destroyPageCollaboration: async () => events.push("destroy"),
    renderSelectedPage: () => events.push("render"),
    startPageCollaboration: async () => events.push("start"),
    t: (key) => key,
    Set,
    Error,
    result: null
  };

  vm.runInNewContext(
    `${refresh}
result = refreshPageMovePersistenceMode(
  new Set(["root", "child"]),
  "child",
  true,
  { generation: 1 },
  7
);`,
    sandbox
  );
  assert.equal(await sandbox.result, true);
  assert.equal(sandbox.state.selectedPage.collaboration.enabled, false);
  assert.deepEqual(events, ["load", "destroy", "render"]);
});
