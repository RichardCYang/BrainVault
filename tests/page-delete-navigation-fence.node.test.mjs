import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appUrl = new URL("../public/app.js", import.meta.url);

test("page delete reconciliation is fenced to the initiating navigation generation", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const deleteStart = source.indexOf("async function deleteNavigationTarget");
  const renderStart = source.indexOf("\nfunction renderCollectionView", deleteStart);
  assert.ok(deleteStart >= 0 && renderStart > deleteStart);
  const deletion = source.slice(deleteStart, renderStart);

  assert.match(deletion, /const navigationGeneration = workspaceNavigationGeneration;/);
  assert.match(
    deletion,
    /selectedPageWasDeleted[\s\S]*isCurrentWorkspaceNavigation\(navigationGeneration\)[\s\S]*subtreeIds\.has\(state\.selectedPage\.id\)/
  );
  assert.match(
    deletion,
    /activeCollectionWasDeleted[\s\S]*isCurrentWorkspaceNavigation\(navigationGeneration\)[\s\S]*state\.activeCollectionId === target\.id/
  );
  assert.match(deletion, /await loadPages\([\s\S]*if \(!isCurrentWorkspaceNavigation\(navigationGeneration\)\) return;/);
  assert.match(
    deletion,
    /showCollection\(fallbackCollectionId, \{ skipFlush: true, navigationGeneration \}\)/
  );
});

test("standalone reproduction proves a completed delete cannot overwrite newer page navigation", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-delete-navigation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.newerNavigationLost, true);
  assert.equal(result.fixed.newerNavigationPreserved, true);
  assert.equal(result.fixed.selectedPageId, "page-b");
  assert.equal(result.fixed.workspaceView, "page");
});
