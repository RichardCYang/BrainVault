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

test("direct title autosave preserves a focused blank durably without materializing Untitled", () => {
  const saveNow = section("async function savePageTitleNow(", "function schedulePageTitleSave(");
  assert.match(saveNow, /if \(!elements\.pageTitle\.value\.trim\(\)\) return null;/);

  const schedule = section("function schedulePageTitleSave(", "function normalizeRecoveredBlockPayload(");
  const blankGuard = schedule.indexOf("if (!elements.pageTitle.value.trim()) {");
  const normalization = schedule.indexOf("const title = normalizePageTitle(elements.pageTitle.value);");
  assert.ok(blankGuard >= 0 && blankGuard < normalization, "blank guard must precede title normalization");
  assert.match(schedule, /persistPageTitleDraftValue\(""\)/);
  assert.doesNotMatch(schedule, /pageDraftStore\.removeTitle\(/);
  assert.match(schedule, /scheduleDirectTitleRecoveryAdmission\(recoveryAdmissionSequence, pageId\)/);
  assert.match(schedule, /window\.clearTimeout\(pageTitleSaveTimer\);\s*pageTitleSaveTimer = null;/);

  const flush = section("async function flushPendingPageEdits(", "function applyMaterializedHtmlCaches(");
  assert.match(flush, /const titleHasCommitValue = Boolean\(elements\.pageTitle\.value\.trim\(\)\);/);
  assert.match(flush, /titleHasCommitValue && \(titleWasPending \|\| pageTitleSavedRevision < pageTitleEditRevision\)/);

  const blur = section('elements.pageTitle.addEventListener("blur"', 'elements.pageTitle.addEventListener("focus"');
  assert.match(blur, /elements\.pageTitle\.value = t\("newDocumentTitle"\);/);
  assert.match(blur, /!isCollaborativePage\(\) && !schedulePageTitleSave\(\)/);
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
