import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const normalize = (value) => value.replace(/\r\n/g, "\n");

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert.ok(start >= 0, `missing source marker: ${startNeedle}`);
  assert.ok(end > start, `missing end marker: ${endNeedle}`);
  return source.slice(start, end);
}

function loadBuildPageTree(appSource) {
  const source = section(appSource, "function buildPageTree(", "\nfunction flattenPageTree(");
  const sandbox = {
    state: { allPages: [], navigationPageOrder: new Map() },
    rootParentKey: "__root__",
    allPagesRecentTreeCacheSource: null,
    allPagesRecentTreeCacheValue: null,
    sortByNavigationOrder: (items) => [...items],
    sortByRecent: (items) => [...items],
    result: null
  };
  vm.runInNewContext(`${source}\nresult = buildPageTree;`, sandbox);
  return sandbox.result;
}

test("custom collection subsets expose direct children through the synthetic tree root", async () => {
  const app = normalize(await readFile(new URL("../public/app.js", import.meta.url), "utf8"));
  const buildPageTree = loadBuildPageTree(app);
  const collectionId = "collection_1";
  const pages = [
    { id: "note_direct", parentPageId: collectionId, updatedAt: "2026-09-03T00:00:00.000Z" },
    { id: "note_nested", parentPageId: "note_direct", updatedAt: "2026-09-02T00:00:00.000Z" }
  ];

  // getCollectionPages and renderDocumentTree both omit the collection root
  // before passing this subset to buildPageTree. The direct child must therefore
  // be promoted to rootParentKey while its nested hierarchy remains intact.
  const groups = buildPageTree(pages, { useNavigationOrder: true });
  assert.equal(groups.has(collectionId), false);
  assert.equal((groups.get("__root__") ?? []).map((page) => page.id).join(","), "note_direct");
  assert.equal((groups.get("note_direct") ?? []).map((page) => page.id).join(","), "note_nested");
});

test("sidebar and collection view read collection subsets from rootParentKey", async () => {
  const app = normalize(await readFile(new URL("../public/app.js", import.meta.url), "utf8"));
  const sidebar = section(app, "function renderCollectionSection(", "\nfunction renderDocumentTree(");
  const collectionView = section(app, "function renderCollectionView()", "\nfunction inspectLocalPageDraftRecords(");

  assert.match(sidebar, /buildPageTree\(pages, \{ useNavigationOrder: true \}\)[\s\S]*groups\.get\(rootParentKey\)/);
  assert.doesNotMatch(sidebar, /groups\.get\(collection\.id\)/);
  assert.match(collectionView, /const roots = groups\.get\(rootParentKey\) \?\? \[\];/);
  assert.doesNotMatch(collectionView, /groups\.get\(collection\?\.id/);
});
