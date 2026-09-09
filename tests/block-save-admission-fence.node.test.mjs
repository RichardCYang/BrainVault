import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function saveBlockRowSource() {
  const start = appSource.indexOf("async function saveBlockRow(");
  const end = appSource.indexOf("\nfunction scheduleBlockSave", start);
  assert.notEqual(start, -1, "saveBlockRow must exist");
  assert.notEqual(end, -1, "saveBlockRow source boundary must exist");
  return appSource.slice(start, end);
}

test("direct block saves fence the pre-queue durability admission window", () => {
  const source = saveBlockRowSource();
  const durabilityAwait = source.indexOf('await requireDirectRecoveryDurability("direct-block-recovery"');
  const taskCreation = source.indexOf("  const task = {", durabilityAwait);
  const pageCapture = source.indexOf("const pageId = state.selectedPage?.id;");
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
    "navigation must be revalidated before a save queue task is admitted"
  );
  assert.ok(
    pageFence > durabilityAwait && pageFence < taskCreation,
    "selected page identity must be revalidated before queue admission"
  );
  assert.ok(
    lockFence > durabilityAwait && lockFence < taskCreation,
    "non-flush saves must not enter after a page-edit transition lock starts"
  );
});

test("direct block save tasks stay bound to the initiating page", () => {
  const source = saveBlockRowSource();
  const taskStart = source.indexOf("  const task = {");
  const taskEnd = source.indexOf("  };", taskStart);
  const taskSource = source.slice(taskStart, taskEnd);

  assert.match(taskSource, /\r?\n    pageId,\r?\n/, "the task must use the captured page id");
  assert.doesNotMatch(
    taskSource,
    /pageId:\s*state\.selectedPage\.id/,
    "a resumed save must not bind an old block to a newly selected page"
  );
});

test("flush-owned saves remain admissible while the page-edit lock is held", () => {
  const source = saveBlockRowSource();
  assert.match(
    source,
    /\(!allowLocked && state\.pageEditLockDepth > 0\)/,
    "only ordinary saves should be fenced by a transition lock; flush-owned saves use allowLocked"
  );
});
