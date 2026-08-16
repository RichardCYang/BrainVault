import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

function section(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("direct title autosave never materializes a focused transient blank as Untitled", () => {
  const saveNow = section("async function savePageTitleNow(", "function schedulePageTitleSave(");
  assert.match(saveNow, /if \(!elements\.pageTitle\.value\.trim\(\)\) return null;/);

  const schedule = section("function schedulePageTitleSave(", "function normalizeRecoveredBlockPayload(");
  const blankGuard = schedule.indexOf("if (!elements.pageTitle.value.trim()) {");
  const normalization = schedule.indexOf("const title = normalizePageTitle(elements.pageTitle.value);");
  const draftPersist = schedule.indexOf("if (!persistPageTitleDraft())");
  assert.ok(blankGuard >= 0 && blankGuard < normalization, "blank guard must precede title normalization");
  assert.ok(blankGuard < draftPersist, "blank guard must precede durable title draft creation");
  assert.match(schedule, /pageDraftStore\.removeTitle\(scope\.userId, scope\.pageId, draftSourceId\)/);
  assert.match(schedule, /window\.clearTimeout\(pageTitleSaveTimer\);\s*pageTitleSaveTimer = null;/);

  const flush = section("async function flushPendingPageEdits(", "function applyMaterializedHtmlCaches(");
  assert.match(flush, /const titleHasCommitValue = Boolean\(elements\.pageTitle\.value\.trim\(\)\);/);
  assert.match(flush, /titleHasCommitValue && \(titleWasPending \|\| pageTitleSavedRevision < pageTitleEditRevision\)/);

  const blur = section('elements.pageTitle.addEventListener("blur"', 'elements.pageTitle.addEventListener("focus"');
  assert.match(blur, /elements\.pageTitle\.value = t\("newDocumentTitle"\);/);
  assert.match(blur, /!isCollaborativePage\(\) && !schedulePageTitleSave\(\)/);

  // Execute the production scheduler itself with a minimal direct-mode harness.
  // Undefined collaborators in non-selected branches are intentionally left alone;
  // any accidental normalization/persistence in the blank branch is recorded below.
  const schedulerFactory = new Function(`
    let pageTitleEditRevision = 7;
    let pageTitleSaveTimer = 123;
    let pageTitleDraftConflict = false;
    let pageTitleDraftSourceId = "tab-a";
    const pageDraftSourceId = "tab-a";
    const state = { selectedPage: { id: "page-1", title: "Quarterly Launch Notes" }, pages: [], allPages: [] };
    const elements = { pageTitle: { value: "" } };
    const events = [];
    const window = {
      clearTimeout(id) { events.push(["clearTimeout", id]); },
      setTimeout() { events.push(["setTimeout"]); return 999; }
    };
    const pageDraftStore = {
      removeTitle(userId, pageId, sourceId) {
        events.push(["removeTitle", userId, pageId, sourceId]);
        return true;
      }
    };
    function requireWritablePage() { return true; }
    function isCollaborativePage() { return false; }
    function getDraftScope() { return { userId: "user-1", pageId: "page-1" }; }
    function checkDraftStoreWrite(value) { return value; }
    function updateInputValuePreservingSelection() { events.push(["revert"]); }
    function syncBeforeUnloadProtection() { events.push(["sync"]); }
    function recordPageTitleEditorHistory() { events.push(["history"]); }
    function normalizePageTitle() { events.push(["normalize"]); return "Untitled"; }
    function persistPageTitleDraft() { events.push(["persistDraft"]); return true; }
    function applyPageSummaryUpdate() { events.push(["applySummary"]); }
    function renderPageHeader() { events.push(["renderHeader"]); }
    function promotePageTitleDraftConflict() { events.push(["promoteConflict"]); return false; }
    async function savePageTitleNow() { events.push(["saveNow"]); }
    function setStatus() {}
    ${schedule}
    return {
      run: () => schedulePageTitleSave(),
      snapshot: () => ({ pageTitleEditRevision, pageTitleSaveTimer, events })
    };
  `);
  const scheduler = schedulerFactory();
  assert.equal(scheduler.run(), true);
  const schedulerState = scheduler.snapshot();
  assert.equal(schedulerState.pageTitleEditRevision, 8);
  assert.equal(schedulerState.pageTitleSaveTimer, null);
  assert.deepEqual(
    schedulerState.events.filter(([name]) => ["normalize", "persistDraft", "applySummary", "setTimeout", "saveNow"].includes(name)),
    []
  );
  assert.deepEqual(
    schedulerState.events.find(([name]) => name === "removeTitle"),
    ["removeTitle", "user-1", "page-1", "tab-a"]
  );
});

test("toggle markdown round-trips valid titles longer than the UI input limit without truncation", () => {
  const helpers = section("function parseToggleMarkdown(", "function getToggleMarkdownFromRow(");
  assert.doesNotMatch(helpers, /slice\(0, toggleTitleMaxLength\)/);

  const factory = new Function(`${helpers}; return { parseToggleMarkdown, serializeToggleMarkdown };`);
  const { parseToggleMarkdown, serializeToggleMarkdown } = factory();
  const original = `${"X".repeat(350)}\nBODY`;
  const parsed = parseToggleMarkdown(original);
  const roundTrip = serializeToggleMarkdown(parsed.title, parsed.body);

  assert.equal(parsed.title.length, 350);
  assert.equal(roundTrip, original);
});
