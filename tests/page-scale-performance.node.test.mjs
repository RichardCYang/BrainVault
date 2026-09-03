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
  assert.match(enrichment, /WHERE pt\.page_id IN \(\$\{placeholders\}\)/);
  assert.match(enrichment, /if \(!compact\) \{[\s\S]*FROM users[\s\S]*WHERE id IN/);
});

test("workspace navigation opts into compact 500-item keyset batches", async () => {
  const app = await read("public/app.js");
  const fetcher = section(app, "async function fetchAllPageSummaries(", "async function fetchOwnedWorkspacePageIds(");

  assert.match(fetcher, /new URLSearchParams\(\{ limit: "500", compact: "true" \}\)/);
  assert.match(fetcher, /if \(cursor\) params\.set\("cursor", cursor\);/);
  assert.match(fetcher, /seenPageIds/);
  assert.match(fetcher, /seenCursors/);
  assert.match(fetcher, /return sortByRecent\(pages\);/);
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

test("title typing updates only the affected summary presentation instead of rerendering the full page tree", async () => {
  const app = await read("public/app.js");
  const presentation = section(app, "function syncPageTitleSummaryPresentation(", "function applyPageSummaryUpdate(");
  const updater = section(app, "function applyPageSummaryUpdate(", "function applyPageMetadataMutationResult(");
  assert.match(presentation, /state\.activeNavigationMenuTarget\?\.id === pageId/);
  assert.match(presentation, /state\.activeNavigationMenuTarget\.title = title/);
  assert.match(updater, /getPageSummaryLookup\(pages\)\.get\(pageId\)/);
  assert.match(updater, /updateKeys\.length === 1 && updateKeys\[0\] === "title"/);
  assert.match(updater, /syncPageTitleSummaryPresentation\(pageId, updates\.title\);\s*return;/);

  const allPage = { id: "page_1", title: "Old" };
  const selectedPage = { id: "page_1", title: "Old" };
  const counters = { sync: 0, tree: 0, home: 0, hierarchyInvalidations: 0, recentInvalidations: 0 };
  const sandbox = {
    state: { selectedPage, allPages: [allPage], pages: null },
    getPageSummaryLookup: (pages) => new Map(pages.map((page) => [page.id, page])),
    syncPageTitleSummaryPresentation: () => { counters.sync += 1; },
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
  assert.deepEqual(counters, { sync: 1, tree: 0, home: 0, hierarchyInvalidations: 0, recentInvalidations: 0 });

  vm.runInNewContext(`applyPageSummaryUpdate("page_1", { title: "Saved", updatedAt: "2026-09-03T00:00:00.000Z" });`, sandbox);
  assert.equal(allPage.title, "Saved");
  assert.deepEqual(counters, { sync: 1, tree: 1, home: 1, hierarchyInvalidations: 0, recentInvalidations: 1 });
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
  assert.match(nodeSource, /if \(expanded\) \{[\s\S]*renderDocumentNode\(child, groups, depth \+ 1\)[\s\S]*\} else \{[\s\S]*deferredNavigationChildren\.set/);
  assert.match(treeSource, /const pageListFragment = document\.createDocumentFragment\(\)/);
  assert.match(treeSource, /const collectionListFragment = document\.createDocumentFragment\(\)/);
  assert.match(treeSource, /elements\.pageList\.replaceChildren\(pageListFragment\)/);
  assert.match(treeSource, /elements\.collectionList\.replaceChildren\(collectionListFragment\)/);
  assert.doesNotMatch(treeSource, /elements\.pageList\.append\(/);
  assert.doesNotMatch(treeSource, /elements\.collectionList\.append\(/);
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
  assert.match(pageMove, /const pageLookup = new Map\(state\.allPages\.map/);
  assert.match(pageMove, /const labelByPageId = new Map\(\)/);
  assert.doesNotMatch(pageMove, /getPageMoveDestinationLabel\(left\)\.localeCompare/);

  const blockMove = section(app, "function getBlockMoveDestinationPages(", "function setBlockMoveMessage(");
  assert.match(blockMove, /const pageLookup = new Map\(state\.allPages\.map/);
  assert.match(blockMove, /const labelByPageId = new Map\(\)/);
  assert.doesNotMatch(blockMove, /getPagePathSegments\(left\)/);
});

