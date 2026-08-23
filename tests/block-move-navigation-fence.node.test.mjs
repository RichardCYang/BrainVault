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

test("block move stays bound to the initiating navigation through transition and request preflight waits", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const move = section(source, "async function moveBlockToPage", "\nasync function deleteBlockWithVersionCheck");
  assert.match(move, /navigationGeneration = null/);
  assert.match(move, /const isBlockMoveNavigationCurrent = \(\) =>/);

  const transitionIndex = move.indexOf('withPagePersistenceTransition(pageId, "block-move"');
  const submitIndex = move.indexOf("submitBlockMoveTask(", transitionIndex);
  assert.ok(transitionIndex >= 0 && submitIndex > transitionIndex);
  assert.match(move.slice(transitionIndex, submitIndex), /!isBlockMoveNavigationCurrent\(\)/);
  assert.match(move.slice(submitIndex, submitIndex + 220), /requestGuard:\s*isBlockMoveNavigationCurrent/);

  const submit = section(source, "async function submitBlockMoveTask", "\nasync function moveBlockToPage");
  assert.match(submit, /beforeFetch:\s*\(\) => \{/);
  assert.match(submit, /requestGuard\?\.\(\) === false/);
  assert.match(submit, /task\.attempted = true;/);

  const form = section(
    source,
    'elements.blockMoveForm.addEventListener("submit"',
    "\nelements.pageMoveClose.addEventListener"
  );
  assert.match(
    form,
    /moveBlockToPage\(blockId, targetPageId, \{[\s\S]*?authenticationScope,[\s\S]*?sourcePageId,[\s\S]*?navigationGeneration[\s\S]*?\}\)/
  );
});

test("block move cleanup stays scoped to the source page after a committed move", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const move = section(source, "async function moveBlockToPage", "\nasync function deleteBlockWithVersionCheck");
  assert.match(move, /const sourceDraftScope = getDraftScope\(pageId\);/);
  assert.match(
    move,
    /pageDraftStore\.removeBlocks\(\s*sourceDraftScope\.userId,\s*sourceDraftScope\.pageId,\s*movedIds,/s
  );
  assert.doesNotMatch(move, /const draftScope = getDraftScope\(\);/);
});

test("standalone reproduction covers stale pre-submit moves and post-submit wrong-scope cleanup", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-block-move-late-navigation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  for (const stage of ["transition", "request-preflight"]) {
    assert.equal(result.vulnerable[stage].staleMoveRequestSent, true);
    assert.equal(result.fixed[stage].staleMoveRequestSent, false);
    assert.equal(result.fixed[stage].newerNavigationPreserved, true);
  }

  assert.equal(result.vulnerable["post-submit-cleanup"].destinationDraftPreserved, false);
  assert.equal(result.fixed["post-submit-cleanup"].sourceDraftRemoved, true);
  assert.equal(result.fixed["post-submit-cleanup"].destinationDraftPreserved, true);
});
