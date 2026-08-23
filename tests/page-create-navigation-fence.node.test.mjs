import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appUrl = new URL("../public/app.js", import.meta.url);

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert.ok(start >= 0 && end > start, `missing source section: ${startNeedle}`);
  return source.slice(start, end);
}

test("navigation-menu subpage creation is fenced before POST and before stale response application", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const action = section(source, "async function createNavigationSubpage()", "function canMoveNavigationPage");
  const submit = section(source, "async function submitWorkspacePageCreate(", "async function createWorkspacePage(");
  const create = section(source, "async function createWorkspacePage(", "async function createCollection()");

  assert.match(action, /const navigationGeneration = workspaceNavigationGeneration;/);
  assert.match(action, /navigationGeneration\s*\n\s*}/);

  assert.match(submit, /\{ requestGuard = null \} = \{\}/);
  assert.match(submit, /if \(requestGuard\?\.\(\) === false\) return skippedApiRequest;/);
  assert.match(submit, /beforeFetch:\s*\(\) => \{/);
  assert.match(submit, /requestGuard\?\.\(\) === false/);
  assert.match(submit, /task\.attempted = true;/);
  assert.match(submit, /data === skippedApiRequest/);

  assert.match(create, /navigationGeneration = null/);
  assert.match(create, /const isCreateIntentCurrent = \(\) =>/);
  assert.match(create, /requestGuard: isCreateIntentCurrent/);
  assert.match(create, /data === skippedApiRequest/);

  const firstWait = create.indexOf("await assertWorkspacePersistenceUnlocked();");
  const firstFence = create.indexOf("!isCreateIntentCurrent()", firstWait);
  const flush = create.indexOf("await flushPendingPageEdits();", firstFence);
  const secondFence = create.indexOf("!isCreateIntentCurrent()", flush);
  const submitIndex = create.indexOf("submitWorkspacePageCreate(", secondFence);
  assert.ok(
    firstWait >= 0
      && firstFence > firstWait
      && flush > firstFence
      && secondFence > flush
      && submitIndex > secondFence
  );

  const summaryFetch = create.indexOf("const pages = await fetchAllPageSummaries();");
  const summaryFence = create.indexOf("!isCreateIntentCurrent()", summaryFetch);
  const stateApply = create.indexOf("state.pages = pages;", summaryFence);
  const open = create.indexOf("await openPage(data.page.id", stateApply);
  assert.ok(summaryFetch > submitIndex && summaryFence > summaryFetch && stateApply > summaryFence && open > stateApply);
});

test("reproduction: stale add-subpage intent is canceled before send and cannot override a newer page", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-create-navigation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.beforeSubmit.vulnerable.requestSent, true);
  assert.equal(result.beforeSubmit.vulnerable.requestParentPageId, "page-a");
  assert.equal(result.beforeSubmit.fixed.requestSent, false);
  assert.equal(result.beforeSubmit.fixed.selectedPageId, "page-b");

  assert.equal(result.inFlight.vulnerable.staleResponseOverrodeNewerNavigation, true);
  assert.equal(result.inFlight.fixed.staleResponseOverrodeNewerNavigation, false);
  assert.equal(result.inFlight.fixed.committedParentPageId, "page-a");
  assert.equal(result.inFlight.fixed.selectedPageId, "page-b");
});
