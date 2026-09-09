import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function savePageTitleNowSource() {
  const start = appSource.indexOf("async function savePageTitleNow(");
  const end = appSource.indexOf("\nfunction schedulePageTitleSave", start);
  assert.notEqual(start, -1, "savePageTitleNow must exist");
  assert.notEqual(end, -1, "savePageTitleNow source boundary must exist");
  return appSource.slice(start, end);
}

test("direct title saves fence the pre-queue durability admission window", () => {
  const source = savePageTitleNowSource();
  const durabilityAwait = source.indexOf('await requireDirectRecoveryDurability("direct-title-recovery"');
  const taskCreation = source.indexOf("  const task = {", durabilityAwait);
  const pageCapture = source.indexOf("const pageId = state.selectedPage.id;");
  const navigationCapture = source.indexOf("const navigationGeneration = workspaceNavigationGeneration;");
  const navigationFence = source.indexOf("!isCurrentWorkspaceNavigation(navigationGeneration)", durabilityAwait);
  const pageFence = source.indexOf("state.selectedPage?.id !== pageId", durabilityAwait);
  const lockFence = source.indexOf("(!allowLocked && state.pageEditLockDepth > 0)", durabilityAwait);

  assert.ok(pageCapture >= 0 && pageCapture < durabilityAwait, "page identity must be captured before durability can yield");
  assert.ok(
    navigationCapture >= 0 && navigationCapture < durabilityAwait,
    "navigation generation must be captured before durability can yield"
  );
  assert.ok(
    navigationFence > durabilityAwait && navigationFence < taskCreation,
    "navigation must be revalidated before a title save task is admitted"
  );
  assert.ok(
    pageFence > durabilityAwait && pageFence < taskCreation,
    "selected page identity must be revalidated before title queue admission"
  );
  assert.ok(
    lockFence > durabilityAwait && lockFence < taskCreation,
    "ordinary title saves must not enter after a page-edit transition lock starts"
  );
});

test("flush-owned title saves remain admissible while the page-edit lock is held", () => {
  const source = savePageTitleNowSource();
  assert.match(
    source,
    /\(!allowLocked && state\.pageEditLockDepth > 0\)/,
    "only ordinary title saves should be fenced by a transition lock; flush-owned saves use allowLocked"
  );
});
