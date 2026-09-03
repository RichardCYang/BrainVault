import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const normalize = (value) => value.replace(/\r\n/g, "\n");
const read = async (relativePath) => normalize(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert.ok(start >= 0, `missing source marker: ${startNeedle}`);
  assert.ok(end > start, `missing end marker: ${endNeedle}`);
  return source.slice(start, end);
}

function loadHierarchyFunctions(source) {
  const functions = section(source, "function isCollectionPage(page)", "function getPagePathSegments(");
  const sandbox = {
    state: { allPages: [], navigationPageOrder: new Map() },
    defaultCollectionKey: "__default__",
    sortByNavigationOrder: (items) => [...items],
    allPagesHierarchyCacheSource: null,
    allPagesHierarchyCacheValue: null,
    allPagesRecentTreeCacheSource: null,
    allPagesRecentTreeCacheValue: null,
    pageSummaryLookupCache: new WeakMap(),
    result: null
  };
  vm.runInNewContext(
    `${functions}\nresult = { state, createPageHierarchyIndex, getCollectionRootId, getDefaultCollectionPages, getCollectionPageCount, getCollectionPages };`,
    sandbox
  );
  return sandbox.result;
}


function referencePageSubtreeIds(pageId, pages) {
  const ids = new Set([pageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const page of pages) {
      if (!page.parentPageId || !ids.has(page.parentPageId) || ids.has(page.id)) continue;
      ids.add(page.id);
      changed = true;
    }
  }
  return ids;
}
function referenceCollectionRootId(pageId, pages) {
  if (!pageId) return null;
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const visited = new Set();
  let page = pagesById.get(pageId);
  while (page && !visited.has(page.id)) {
    if (page?.isCollection === true) return page.id;
    visited.add(page.id);
    page = page.parentPageId ? pagesById.get(page.parentPageId) : null;
  }
  return null;
}

test("large page-list requests use bounded batch enrichment instead of per-page access/tag queries", async () => {
  const route = await read("src/routes/page.routes.ts");
  const listRoute = section(route, 'pageRouter.get("/",', 'pageRouter.post("/",');
  const enrichment = section(route, "async function buildPageListSummaries(", "async function replaceTags(");

  assert.match(route, /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)/);
  assert.match(listRoute, /const countProjection = query\.compact/);
  assert.match(listRoute, /buildPageListSummaries\(client, pageRows, user\.id/);
  assert.doesNotMatch(listRoute, /for \(const row of pageRows\)[\s\S]*getPageAccess/);
  assert.doesNotMatch(listRoute, /for \(const row of pageRows\)[\s\S]*getPageTags/);

  assert.match(enrichment, /WHERE pcm\.page_id IN \(\$\{placeholders\}\)/);
  assert.match(enrichment, /COUNT\(DISTINCT effective_shares\.user_id\)/);
  assert.match(enrichment, /if \(!omitTags\) \{[\s\S]*WHERE pt\.page_id IN \(\$\{placeholders\}\)/);
  assert.match(enrichment, /if \(!compact\) \{[\s\S]*FROM users[\s\S]*WHERE id IN/);
});

test("workspace navigation opts into compact 500-item keyset batches", async () => {
  const app = await read("public/app.js");
  const fetcher = section(app, "async function fetchAllPageSummaries(", "async function fetchOwnedWorkspacePageIds(");

  assert.match(fetcher, /new URLSearchParams\(\{ limit: "500", compact: "true", navigation: "true" \}\)/);
  assert.match(fetcher, /if \(cursor\) params\.set\("cursor", cursor\);/);
  assert.match(fetcher, /seenPageIds/);
  assert.match(fetcher, /seenCursors/);
  assert.match(fetcher, /return sortByRecent\(pages\);/);
});

test("selected-page rerenders update navigation selection without rebuilding or rescanning the workspace tree", async () => {
  const app = await read("public/app.js");
  const selectorSync = section(app, "function setPageNavigationEntryActive(", "function flattenBlocks(");
  const selectedRenderer = section(app, "function renderSelectedPage(", "function normalizePageTitle(");

  assert.match(selectorSync, /navigationPageRenderEntries\.get\(activePageId\)/);
  assert.match(selectorSync, /navigationCollectionRenderEntries\.get\(activeCollectionId\)/);
  assert.match(selectorSync, /aria-current/);
  assert.doesNotMatch(selectorSync, /querySelectorAll\(/);
  assert.doesNotMatch(selectorSync, /renderDocumentTree\(/);

  assert.match(selectedRenderer, /syncWorkspaceNavigationSelection\(\)/);
  assert.match(selectedRenderer, /if \(isCollection\)[\s\S]*renderCollectionView\(\);[\s\S]*return;/);
  assert.match(selectedRenderer, /if \(!hasPage\)[\s\S]*if \(isHome\) renderHome\(\);[\s\S]*return;/);
  assert.doesNotMatch(selectedRenderer, /renderPages\(\)/);
  assert.doesNotMatch(selectedRenderer, /renderDocumentTree\(\)/);
});

test("navigation selection sync preserves active and aria-current semantics across views", async () => {
  const app = await read("public/app.js");
  const selectorSync = section(app, "function setPageNavigationEntryActive(", "function flattenBlocks(");

  class MockClassList {
    constructor(...names) { this.names = new Set(names); }
    add(name) { this.names.add(name); }
    remove(name) { this.names.delete(name); }
    contains(name) { return this.names.has(name); }
    toggle(name, force) {
      if (force === undefined) force = !this.names.has(name);
      if (force) this.names.add(name);
      else this.names.delete(name);
      return force;
    }
  }
  class MockElement {
    constructor(classes = []) {
      this.classList = new MockClassList(...classes);
      this.attributes = new Map();
      this.row = null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    closest(selector) { return selector === ".collection-title-row" ? this.row : null; }
  }

  const page1 = new MockElement(["document-item", "active"]);
  const page1Row = new MockElement(["document-item-row", "active"]);
  page1.setAttribute("aria-current", "page");
  const page2 = new MockElement(["document-item"]);
  const page2Row = new MockElement(["document-item-row"]);

  const collection1 = new MockElement(["collection-title-button", "active"]);
  const collection1Row = new MockElement(["collection-title-row", "active"]);
  collection1.setAttribute("aria-current", "page");
  const collection2 = new MockElement(["collection-title-button"]);
  const collection2Row = new MockElement(["collection-title-row"]);

  const defaultCollectionButton = new MockElement(["collection-title-button"]);
  const defaultCollectionRow = new MockElement(["collection-title-row"]);
  defaultCollectionButton.row = defaultCollectionRow;

  const state = { workspaceView: "page", selectedPage: { id: "page_2" }, activeCollectionId: null };
  const sandbox = {
    state,
    elements: { defaultCollectionButton },
    defaultCollectionKey: "__default_collection__",
    navigationPageRenderEntries: new Map([
      ["page_1", { button: page1, row: page1Row }],
      ["page_2", { button: page2, row: page2Row }]
    ]),
    navigationCollectionRenderEntries: new Map([
      ["collection_1", { button: collection1, row: collection1Row }],
      ["collection_2", { button: collection2, row: collection2Row }]
    ]),
    syncedNavigationPageId: "page_1",
    syncedNavigationCollectionId: "collection_1"
  };
  vm.runInNewContext(selectorSync, sandbox);

  sandbox.syncWorkspaceNavigationSelection();
  assert.equal(page1.classList.contains("active"), false);
  assert.equal(page1Row.classList.contains("active"), false);
  assert.equal(page1.getAttribute("aria-current"), null);
  assert.equal(page2.classList.contains("active"), true);
  assert.equal(page2Row.classList.contains("active"), true);
  assert.equal(page2.getAttribute("aria-current"), "page");
  assert.equal(collection1.classList.contains("active"), false);

  state.workspaceView = "collection";
  state.selectedPage = null;
  state.activeCollectionId = "collection_2";
  sandbox.syncWorkspaceNavigationSelection();
  assert.equal(page2.classList.contains("active"), false);
  assert.equal(page2.getAttribute("aria-current"), null);
  assert.equal(collection2.classList.contains("active"), true);
  assert.equal(collection2Row.classList.contains("active"), true);
  assert.equal(collection2.getAttribute("aria-current"), "page");
  assert.equal(defaultCollectionButton.classList.contains("active"), false);

  state.activeCollectionId = "__default_collection__";
  sandbox.syncWorkspaceNavigationSelection();
  assert.equal(collection2.classList.contains("active"), false);
  assert.equal(collection2.getAttribute("aria-current"), null);
  assert.equal(defaultCollectionButton.classList.contains("active"), true);
  assert.equal(defaultCollectionRow.classList.contains("active"), true);
  assert.equal(defaultCollectionButton.getAttribute("aria-current"), "page");
});

test("hierarchy index preserves collection semantics while avoiding repeated full-array scans", async () => {
  const app = await read("public/app.js");
  const hierarchySource = section(app, "function createPageHierarchyIndex(", "function getPagePathSegments(");
  assert.doesNotMatch(hierarchySource, /new Map\(pages\.map/);
  assert.match(hierarchySource, /Path compression/);

  const {
    createPageHierarchyIndex,
    getDefaultCollectionPages,
    getCollectionPageCount,
    getCollectionPages
  } = loadHierarchyFunctions(app);

  const fixtures = [
    { id: "col_a", isCollection: true, parentPageId: null },
    { id: "a_1", isCollection: false, parentPageId: "col_a" },
    { id: "a_2", isCollection: false, parentPageId: "a_1" },
    { id: "root", isCollection: false, parentPageId: null },
    { id: "orphan", isCollection: false, parentPageId: "missing" },
    { id: "cycle_1", isCollection: false, parentPageId: "cycle_2" },
    { id: "cycle_2", isCollection: false, parentPageId: "cycle_1" },
    { id: "col_b", isCollection: true, parentPageId: null },
    { id: "b_1", isCollection: false, parentPageId: "col_b" }
  ];

  const index = createPageHierarchyIndex(fixtures);
  for (const page of fixtures) {
    assert.equal(index.getCollectionRootId(page.id), referenceCollectionRootId(page.id, fixtures));
  }
  assert.deepEqual(
    Array.from(getDefaultCollectionPages(fixtures), (page) => page.id),
    ["root", "orphan", "cycle_1", "cycle_2"]
  );
  assert.equal(getCollectionPageCount("col_a", fixtures), 2);
  assert.deepEqual(Array.from(getCollectionPages("col_a", fixtures), (page) => page.id), ["a_1", "a_2"]);

  const largePages = [];
  const collectionCount = 40;
  for (let index = 0; index < collectionCount; index += 1) {
    largePages.push({ id: `col_${index}`, isCollection: true, parentPageId: null });
  }
  for (let index = collectionCount; index < 20_000; index += 1) {
    largePages.push({
      id: `page_${index}`,
      isCollection: false,
      parentPageId: `col_${index % collectionCount}`
    });
  }

  let iteratedPages = 0;
  const trackedPages = new Proxy(largePages, {
    get(target, property, receiver) {
      if (property !== Symbol.iterator) return Reflect.get(target, property, receiver);
      return function* trackedIterator() {
        for (const page of target) {
          iteratedPages += 1;
          yield page;
        }
      };
    }
  });

  const largeIndex = createPageHierarchyIndex(trackedPages);
  assert.equal(iteratedPages, largePages.length, "building the hierarchy should scan the page array once");
  for (const page of largePages) assert.ok(largeIndex.getCollectionRootId(page.id));
  assert.equal(
    iteratedPages,
    largePages.length,
    "repeated root lookups should use the index instead of rescanning the page array"
  );

  const cached = loadHierarchyFunctions(app);
  let cachedIterations = 0;
  const cachedPages = new Proxy(largePages, {
    get(target, property, receiver) {
      if (property !== Symbol.iterator) return Reflect.get(target, property, receiver);
      return function* trackedIterator() {
        for (const page of target) {
          cachedIterations += 1;
          yield page;
        }
      };
    }
  });
  cached.state.allPages = cachedPages;
  const firstCachedIndex = cached.createPageHierarchyIndex();
  const secondCachedIndex = cached.createPageHierarchyIndex();
  assert.equal(firstCachedIndex, secondCachedIndex, "unchanged allPages should reuse the hierarchy index");
  assert.equal(cachedIterations, largePages.length, "repeated workspace hierarchy consumers should scan allPages once");
});

test("home recent-document selection keeps exact valid-timestamp ordering without sorting the whole workspace", async () => {
  const app = await read("public/app.js");
  const recentSource = section(app, "function sortByRecent(", "function sortByNavigationOrder(");
  assert.match(recentSource, /function takeMostRecent\(items, limit\)/);
  assert.doesNotMatch(recentSource, /function takeMostRecent[\s\S]*?\.sort\(/);

  const sandbox = { result: null };
  vm.runInNewContext(`${recentSource}\nresult = { sortByRecent, takeMostRecent };`, sandbox);
  const { sortByRecent, takeMostRecent } = sandbox.result;
  const pages = Array.from({ length: 20_000 }, (_, index) => ({
    id: `page_${index}`,
    updatedAt: new Date(Date.UTC(2026, 0, 1) + ((index * 7919) % 50_000) * 1000).toISOString()
  }));
  assert.deepEqual(
    Array.from(takeMostRecent(pages, 8), (page) => page.id),
    Array.from(sortByRecent(pages).slice(0, 8), (page) => page.id)
  );
});

test("page header path lookup reuses the workspace page index instead of rebuilding a full map", async () => {
  const app = await read("public/app.js");
  const pathSource = section(app, "function getPagePathSegments(", "function renderPagePath(");

  assert.match(pathSource, /getPageSummaryLookup\(state\.allPages\)/);
  assert.doesNotMatch(pathSource, /new Map\(state\.allPages\.map/);

  const lookupSource = section(app, "function getPageSummaryLookup(", "function getCollectionRootId(");
  assert.match(lookupSource, /function getPageSummaryById\(pageId\)/);
  assert.match(lookupSource, /getPageSummaryLookup\(state\.allPages\)\.get\(pageId\)/);
  assert.doesNotMatch(app, /state\.allPages\.find\(\(page\) => page\.id ===/);
  assert.doesNotMatch(app, /state\.allPages\.find\(\(candidate\) => candidate\.id ===/);

  const indexedPages = new Map([
    ["collection", { id: "collection", title: "Collection", icon: "📁", isCollection: true, parentPageId: null }],
    ["parent", { id: "parent", title: "Parent", icon: "📄", isCollection: false, parentPageId: "collection" }],
    ["page", { id: "page", title: "Stored title", icon: "📄", isCollection: false, parentPageId: "parent" }]
  ]);
  const selectedPage = { ...indexedPages.get("page"), title: "Draft title" };
  const sandbox = {
    state: { selectedPage, allPages: new Proxy([], { get() { throw new Error("allPages should not be scanned"); } }) },
    getPageSummaryLookup: () => indexedPages,
    isCollectionPage: (page) => page?.isCollection === true,
    t: () => "Untitled",
    defaultCollectionKey: "__default__",
    getDefaultCollectionName: () => "Default",
    getDefaultCollectionEmoji: () => "📁",
    result: null
  };
  vm.runInNewContext(`${pathSource}\nresult = getPagePathSegments(state.selectedPage);`, sandbox);
  assert.deepEqual(
    Array.from(sandbox.result, (segment) => `${segment.id}:${segment.title}`),
    ["collection:Collection", "parent:Parent", "page:Draft title"]
  );
});

test("title typing and save update only cached presentation nodes instead of rescanning or rebuilding the full page tree", async () => {
  const app = await read("public/app.js");
  const presentation = section(app, "function syncPageTitleSummaryPresentation(", "function repositionRenderedNavigationItem(");
  const updater = section(app, "function applyPageSummaryUpdate(", "function applyPageMetadataMutationResult(");
  assert.match(presentation, /navigationPageRenderEntries\.get\(pageId\)/);
  assert.match(presentation, /navigationCollectionRenderEntries\.get\(pageId\)/);
  assert.match(presentation, /subpageIndexTitleElements\.get\(pageId\)/);
  assert.match(presentation, /homeDocumentTitleElements\.get\(pageId\)/);
  assert.match(presentation, /homeDocumentMenuButtons\.get\(pageId\)/);
  assert.doesNotMatch(presentation, /querySelectorAll\(/);
  assert.match(presentation, /state\.activeNavigationMenuTarget\?\.id === pageId/);
  assert.match(presentation, /state\.activeNavigationMenuTarget\.title = title/);
  assert.match(updater, /getPageSummaryLookup\(pages\)\.get\(pageId\)/);
  assert.match(updater, /updateKeys\.length === 1 && updateKeys\[0\] === "title"/);
  assert.match(updater, /canIncrementallyRefreshRecentMetadata/);
  assert.match(updater, /repositionRenderedNavigationItem\(pageId\)/);

  const allPage = { id: "page_1", title: "Old" };
  const selectedPage = { id: "page_1", title: "Old" };
  const counters = {
    sync: 0,
    reposition: 0,
    tree: 0,
    home: 0,
    hierarchyInvalidations: 0,
    recentInvalidations: 0
  };
  const sandbox = {
    state: { selectedPage, allPages: [allPage], pages: null },
    getPageSummaryLookup: (pages) => new Map(pages.map((page) => [page.id, page])),
    syncPageTitleSummaryPresentation: () => { counters.sync += 1; },
    repositionRenderedNavigationItem: () => { counters.reposition += 1; },
    invalidateAllPagesHierarchyCache: () => { counters.hierarchyInvalidations += 1; },
    invalidateAllPagesRecentTreeCache: () => { counters.recentInvalidations += 1; },
    renderDocumentTree: () => { counters.tree += 1; },
    renderHome: () => { counters.home += 1; },
    counters,
    result: null
  };
  sandbox.state.pages = sandbox.state.allPages;
  vm.runInNewContext(`${updater}\napplyPageSummaryUpdate("page_1", { title: "Typing" });`, sandbox);
  assert.equal(allPage.title, "Typing");
  assert.equal(selectedPage.title, "Typing");
  assert.deepEqual(counters, {
    sync: 1,
    reposition: 0,
    tree: 0,
    home: 0,
    hierarchyInvalidations: 0,
    recentInvalidations: 0
  });

  vm.runInNewContext(`applyPageSummaryUpdate("page_1", { title: "Saved", version: 2, updatedAt: "2026-09-03T00:00:00.000Z" });`, sandbox);
  assert.equal(allPage.title, "Saved");
  assert.deepEqual(counters, {
    sync: 2,
    reposition: 1,
    tree: 0,
    home: 1,
    hierarchyInvalidations: 0,
    recentInvalidations: 1
  });
});

test("incremental recent-order refresh moves only the affected rendered node and preserves explicit order", async () => {
  const app = await read("public/app.js");
  const comparatorSource = section(app, "function compareNavigationOrder(", "function sortByNavigationOrder(");
  const repositionSource = section(app, "function repositionRenderedNavigationItem(", "function applyPageSummaryUpdate(");

  class MockNode {
    constructor(id) {
      this.dataset = { navigationOrderId: id };
      this.parentElement = null;
    }
    after(node) { this.parentElement.moveAfter(node, this); }
  }
  class MockContainer {
    constructor(nodes) {
      this.children = nodes;
      for (const node of nodes) node.parentElement = this;
    }
    detach(node) {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
    }
    insertBefore(node, before) {
      this.detach(node);
      const index = this.children.indexOf(before);
      this.children.splice(index, 0, node);
      node.parentElement = this;
    }
    moveAfter(node, after) {
      this.detach(node);
      const index = this.children.indexOf(after);
      this.children.splice(index + 1, 0, node);
      node.parentElement = this;
    }
  }

  const pages = new Map([
    ["page_1", { id: "page_1", updatedAt: "2026-09-01T00:00:00.000Z" }],
    ["page_2", { id: "page_2", updatedAt: "2026-09-03T00:00:00.000Z" }],
    ["page_3", { id: "page_3", updatedAt: "2026-09-02T00:00:00.000Z" }]
  ]);
  const nodes = new Map([...pages.keys()].map((id) => [id, new MockNode(id)]));
  const container = new MockContainer([nodes.get("page_2"), nodes.get("page_3"), nodes.get("page_1")]);
  const sandbox = {
    state: { navigationPageOrder: new Map() },
    navigationPageRenderEntries: new Map([...nodes].map(([id, wrapper]) => [id, { wrapper }])),
    navigationCollectionRenderEntries: new Map(),
    getPageSummaryById: (id) => pages.get(id) ?? null
  };
  vm.runInNewContext(`${comparatorSource}\n${repositionSource}`, sandbox);

  pages.get("page_1").updatedAt = "2026-09-04T00:00:00.000Z";
  sandbox.repositionRenderedNavigationItem("page_1");
  assert.deepEqual(container.children.map((node) => node.dataset.navigationOrderId), ["page_1", "page_2", "page_3"]);

  sandbox.state.navigationPageOrder = new Map([["page_2", 0], ["page_3", 1], ["page_1", 2]]);
  container.children = [nodes.get("page_2"), nodes.get("page_3"), nodes.get("page_1")];
  for (const node of container.children) node.parentElement = container;
  pages.get("page_1").updatedAt = "2026-09-05T00:00:00.000Z";
  sandbox.repositionRenderedNavigationItem("page_1");
  assert.deepEqual(container.children.map((node) => node.dataset.navigationOrderId), ["page_2", "page_3", "page_1"]);
});

test("incremental title presentation preserves labels, menus, toggle accessibility, and collection-view title", async () => {
  const app = await read("public/app.js");
  const source = section(app, "function syncNavigationMenuButtonTitle(", "function repositionRenderedNavigationItem(");

  const makeNode = () => ({
    textContent: "",
    dataset: {},
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; }
  });
  const pageLabel = makeNode();
  const toggleButton = makeNode();
  toggleButton.setAttribute("aria-expanded", "true");
  const pageMenu = makeNode();
  const collectionLabel = makeNode();
  const collectionMenu = makeNode();
  const subpageTitle = makeNode();
  const homeTitle = makeNode();
  const homeMenu = makeNode();
  homeMenu.dataset.navigationMenuKind = "collection";
  const navigationContextMenu = makeNode();
  const collectionViewTitle = makeNode();
  const state = {
    activeNavigationMenuTarget: { id: "page_1", kind: "collection", title: "Old" },
    workspaceView: "collection",
    activeCollectionId: "page_1"
  };
  const sandbox = {
    state,
    navigationPageRenderEntries: new Map([["page_1", {
      label: pageLabel,
      toggleButton,
      menuButton: pageMenu
    }]]),
    navigationCollectionRenderEntries: new Map([["page_1", {
      titleLabel: collectionLabel,
      menuButton: collectionMenu
    }]]),
    subpageIndexTitleElements: new Map([["page_1", subpageTitle]]),
    homeDocumentTitleElements: new Map([["page_1", homeTitle]]),
    homeDocumentMenuButtons: new Map([["page_1", homeMenu]]),
    elements: { navigationContextMenu, collectionViewTitle },
    t: (key, values = {}) => `${key}:${values.title ?? ""}`
  };
  vm.runInNewContext(source, sandbox);
  sandbox.syncPageTitleSummaryPresentation("page_1", "Renamed");

  assert.equal(pageLabel.textContent, "Renamed");
  assert.equal(collectionLabel.textContent, "Renamed");
  assert.equal(subpageTitle.textContent, "Renamed");
  assert.equal(homeTitle.textContent, "Renamed");
  assert.equal(toggleButton.dataset.pageChildrenToggleTitle, "Renamed");
  assert.equal(toggleButton.getAttribute("aria-label"), "navigation.collapseSubpages:Renamed");
  assert.equal(pageMenu.dataset.navigationMenuTitle, "Renamed");
  assert.equal(collectionMenu.dataset.navigationMenuTitle, "Renamed");
  assert.equal(homeMenu.dataset.navigationMenuTitle, "Renamed");
  assert.equal(state.activeNavigationMenuTarget.title, "Renamed");
  assert.equal(navigationContextMenu.getAttribute("aria-label"), "navigationMenu.collectionAria:Renamed");
  assert.equal(collectionViewTitle.textContent, "Renamed");
});

test("collaborative title and content-version propagation avoid workspace-wide summary scans", async () => {
  const app = await read("public/app.js");
  const snapshotSource = section(app, "function applyCollaborationSnapshot(", "function applyCollaborationMaterialization(");
  const versionSource = section(app, "function applyPageContentVersion(", "function applyAuthoritativePageContentVersion(");
  const titleSaveSource = section(app, "async function savePageTitleNow(", "function normalizeRecoveredBlockPayload(");

  assert.match(snapshotSource, /getPageSummaryLookup\(pages\)\.get\(state\.selectedPage\.id\)/);
  assert.match(snapshotSource, /syncPageTitleSummaryPresentation\(state\.selectedPage\.id, nextTitle\)/);
  assert.doesNotMatch(snapshotSource, /renderDocumentTree\(\)/);
  assert.doesNotMatch(snapshotSource, /renderHome\(\)/);

  assert.match(versionSource, /getPageSummaryLookup\(pages\)\.get\(pageId\)/);
  assert.doesNotMatch(versionSource, /for \(const page of pages\)/);

  assert.match(titleSaveSource, /getPageSummaryLookup\(pages\)\.get\(pageId\)/);
  assert.doesNotMatch(titleSaveSource, /pages\.find\(\(item\) => item\.id === pageId\)/);
});

test("sidebar rendering batches live DOM replacement and defers already-collapsed descendant creation", async () => {
  const app = await read("public/app.js");
  const toggleSource = section(app, "function setNavigationSubpagesExpanded(", "function renderDocumentNode(");
  const nodeSource = section(app, "function renderDocumentNode(", "function renderCollectionSection(");
  const treeSource = section(app, "function renderDocumentTree(", "function getNavigationDragNode(");

  assert.match(toggleSource, /if \(expanded && group\) materializeDeferredNavigationChildren\(group\)/);
  assert.match(toggleSource, /deferredNavigationChildren\.delete\(group\)/);
  assert.match(nodeSource, /if \(expanded\) \{[\s\S]*renderDocumentNode\(child, groups, depth \+ 1, refreshOrder\)[\s\S]*\} else \{[\s\S]*deferredNavigationChildren\.set/);
  assert.match(treeSource, /const pageListFragment = document\.createDocumentFragment\(\)/);
  assert.match(treeSource, /const collectionListFragment = document\.createDocumentFragment\(\)/);
  assert.match(treeSource, /elements\.pageList\.replaceChildren\(pageListFragment\)/);
  assert.match(treeSource, /elements\.collectionList\.replaceChildren\(collectionListFragment\)/);
  assert.doesNotMatch(treeSource, /elements\.pageList\.append\(/);
  assert.doesNotMatch(treeSource, /elements\.collectionList\.append\(/);
});

test("subpage index renders large descendant trees in one iterative pass without recursive depth risk", async () => {
  const app = await read("public/app.js");
  const source = section(app, "function renderSubpageIndexItem(", "function renderParentOptions(");

  assert.doesNotMatch(source, /countDescendants/);
  assert.doesNotMatch(source, /renderSubpageIndexItem\(child/);
  assert.match(source, /const pending = children/);
  assert.match(source, /while \(pending\.length\)/);
  assert.match(source, /const fragment = document\.createDocumentFragment\(\)/);
  assert.match(source, /elements\.subpageIndexList\.replaceChildren\(fragment\)/);

  class MockClassList {
    constructor() { this.names = new Set(); }
    add(name) { this.names.add(name); }
    remove(name) { this.names.delete(name); }
  }
  class MockNode {
    constructor(tag = "node") {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.style = { values: new Map(), setProperty: (name, value) => this.style.values.set(name, value) };
      this.classList = new MockClassList();
      this.textContent = "";
      this.attributes = new Map();
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    replaceChildren(...nodes) { this.children = nodes.flatMap((node) => node?.isFragment ? node.children : [node]); }
  }
  const documentMock = {
    createElement: (tag) => new MockNode(tag),
    createDocumentFragment: () => Object.assign(new MockNode("fragment"), { isFragment: true })
  };
  const list = new MockNode("list");
  const subpageIndex = new MockNode("section");
  const subpageIndexCount = new MockNode("count");
  const groups = new Map();
  const descendantTotal = 20_000;
  for (let index = 0; index < descendantTotal; index += 1) {
    const parentId = index === 0 ? "root" : `page_${index - 1}`;
    groups.set(parentId, [{ id: `page_${index}`, title: `Page ${index}`, icon: "📄" }]);
  }

  const sandbox = {
    state: { selectedPage: { id: "root" }, workspaceView: "page", allPages: [] },
    document: documentMock,
    elements: { subpageIndexList: list, subpageIndex, subpageIndexCount },
    subpageIndexTitleElements: new Map(),
    buildPageTree: () => groups,
    renderIconValue: () => {},
    t: () => "Untitled",
    formatNumber: (value) => String(value)
  };
  vm.runInNewContext(source, sandbox);
  sandbox.renderSubpageIndex(sandbox.state.selectedPage);

  assert.equal(list.children.length, descendantTotal);
  assert.equal(subpageIndexCount.textContent, String(descendantTotal));
  assert.equal(sandbox.subpageIndexTitleElements.size, descendantTotal);
  assert.equal(list.children[0].dataset.subpageIndexPageId, "page_0");
  assert.equal(list.children.at(-1).dataset.subpageIndexPageId, `page_${descendantTotal - 1}`);
  assert.equal(list.children.at(-1).style.values.get("--subpage-depth"), String(descendantTotal - 1));
});

test("large subtree and move-dialog helpers avoid repeated full-page scans", async () => {
  const app = await read("public/app.js");
  const subtreeSource = section(app, "function getPageSubtreeIds(", "function getPageActionsMenuItems(");
  assert.match(subtreeSource, /const childrenByParentId = new Map\(\)/);
  assert.doesNotMatch(subtreeSource, /while \(changed\)/);

  const sandbox = { result: null };
  vm.runInNewContext(`${subtreeSource}\nresult = { getPageSubtreeIds };`, sandbox);
  const { getPageSubtreeIds } = sandbox.result;

  const fixtures = [
    { id: "root", parentPageId: null },
    { id: "a", parentPageId: "root" },
    { id: "b", parentPageId: "a" },
    { id: "c", parentPageId: "root" },
    { id: "orphan", parentPageId: "missing" },
    { id: "cycle_a", parentPageId: "cycle_b" },
    { id: "cycle_b", parentPageId: "cycle_a" }
  ];
  for (const pageId of ["root", "a", "orphan", "cycle_a", "missing"]) {
    assert.deepEqual(
      Array.from(getPageSubtreeIds(pageId, fixtures)).sort(),
      Array.from(referencePageSubtreeIds(pageId, fixtures)).sort()
    );
  }

  const largePages = Array.from({ length: 20_000 }, (_, index) => ({
    id: `page_${index}`,
    parentPageId: index === 0 ? null : `page_${Math.floor((index - 1) / 2)}`
  }));
  let iteratedPages = 0;
  const trackedPages = new Proxy(largePages, {
    get(target, property, receiver) {
      if (property !== Symbol.iterator) return Reflect.get(target, property, receiver);
      return function* trackedIterator() {
        for (const page of target) {
          iteratedPages += 1;
          yield page;
        }
      };
    }
  });
  assert.equal(getPageSubtreeIds("page_0", trackedPages).size, largePages.length);
  assert.equal(iteratedPages, largePages.length, "subtree discovery should scan the page array once");

  const pageMove = section(app, "function getPageMoveDestinationPages(", "function setPageMoveMessage(");
  assert.match(pageMove, /const pageLookup = getPageSummaryLookup\(state\.allPages\)/);
  assert.match(pageMove, /const labelByPageId = new Map\(\)/);
  assert.doesNotMatch(pageMove, /getPageMoveDestinationLabel\(left\)\.localeCompare/);

  const blockMove = section(app, "function getBlockMoveDestinationPages(", "function setBlockMoveMessage(");
  assert.match(blockMove, /const pageLookup = getPageSummaryLookup\(state\.allPages\)/);
  assert.match(blockMove, /const labelByPageId = new Map\(\)/);
  assert.doesNotMatch(blockMove, /getPagePathSegments\(left\)/);
});

