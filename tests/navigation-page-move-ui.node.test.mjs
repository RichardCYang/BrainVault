import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("sidebar page menu exposes the move action and an accessible destination dialog", () => {
  assert.match(index, /id="navigation-move-page-button"[^>]*data-action="move-navigation-page"/s);
  assert.match(index, /id="page-move-dialog"[\s\S]*?aria-labelledby="page-move-title"[\s\S]*?aria-describedby="page-move-description"/);
  assert.match(index, /id="page-move-page-select"[^>]*required/);
  assert.match(client, /openPageMoveDialog\(target\.id, returnFocus\)/);
  assert.match(client, /elements\.pageMoveDialog\.showModal\(\)/);
});

test("production destination-filter function excludes unsafe parents and keeps authorized collection destinations", () => {
  const productionFunctions = extractBetween(
    client,
    "function canMoveNavigationPage(page)",
    "function getPageMoveDestinationLabel(page)"
  );

  const pages = [
    { id: "source", ownerId: "owner", parentPageId: "current", title: "Source" },
    { id: "child", ownerId: "owner", parentPageId: "source", title: "Child" },
    { id: "grandchild", ownerId: "owner", parentPageId: "child", title: "Grandchild" },
    { id: "current", ownerId: "owner", parentPageId: null, title: "Current parent" },
    { id: "valid-a", ownerId: "owner", parentPageId: null, title: "A valid" },
    { id: "valid-b", ownerId: "owner", parentPageId: "valid-a", title: "B valid" },
    { id: "collection", ownerId: "owner", parentPageId: null, title: "Collection", isCollection: true },
    { id: "archived", ownerId: "owner", parentPageId: null, title: "Archived", isArchived: true },
    { id: "foreign", ownerId: "someone-else", parentPageId: null, title: "Foreign" }
  ];
  const subtree = new Set(["source", "child", "grandchild"]);
  const sandbox = {
    state: { allPages: pages },
    getPageSummaryLookup: (items) => new Map(items.map((page) => [page.id, page])),
    getPageSubtreeIds: () => subtree,
    isCollectionPage: (page) => Boolean(page?.isCollection),
    canManagePage: (page) => page?.ownerId === "owner",
    getPageMoveDestinationLabel: (page) => page.title,
    getLocale: () => "en",
    result: null
  };

  vm.runInNewContext(`${productionFunctions}\nresult = getPageMoveDestinationPages(state.allPages[0]).map((page) => page.id);`, sandbox);
  assert.deepEqual(Array.from(sandbox.result), ["valid-a", "valid-b", "collection"]);
});

test("page move submits only parent metadata and keeps retry reconciliation idempotent", () => {
  const submitMove = extractBetween(
    client,
    "async function submitPageMoveMutation(",
    "function applyPageMoveMutationResult(committedPage)"
  );
  assert.match(submitMove, /method:\s*"PATCH"/);
  assert.match(submitMove, /body:\s*\{\s*parentPageId:\s*targetPageId,\s*expectedVersion,\s*mutationId:\s*task\.mutationId\s*\}/s);
  assert.match(submitMove, /submitWithFreshMutationIdOnReuse\(task/);
  assert.match(submitMove, /reconciled\?\.page\?\.parentPageId === targetPageId/);
  assert.doesNotMatch(submitMove, /blocks\s*:/i);
  assert.doesNotMatch(submitMove, /title\s*:/i);
  assert.doesNotMatch(submitMove, /content\s*:/i);
});

test("moving the currently edited page flushes it before the hierarchy mutation", () => {
  const moveFlow = extractBetween(
    client,
    "async function moveNavigationPageToParent(",
    "function findPendingPageDeleteTask"
  );
  assert.match(moveFlow, /await assertWorkspacePersistenceUnlocked\(\)/);
  assert.match(moveFlow, /const sourceIsSelected = state\.selectedPage\?\.id === pageId/);
  assert.match(moveFlow, /if \(sourceIsSelected && hasUnresolvedDraftConflicts\(\)\)/);
  assert.match(moveFlow, /\{ flush: sourceIsSelected \}/);
  assert.match(moveFlow, /setNavigationSubpagesExpanded\(targetPageId, true\)/);
});

test("requested Korean action and lossless explanation are present", () => {
  assert.match(i18n, /movePage:\s*"다른 페이지로 이동하기"/);
  assert.match(i18n, /title:\s*"다른 페이지로 이동하기"/);
  assert.match(i18n, /submit:\s*"페이지 이동"/);
  assert.match(i18n, /이 페이지와 모든 하위 페이지를 내용, 블록, 첨부파일, 태그, 공유 데이터, 구조화 데이터를 변경하지 않고/);
});
