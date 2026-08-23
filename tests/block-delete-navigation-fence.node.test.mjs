import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appUrl = new URL("../public/app.js", import.meta.url);

test("block delete reconciliation is fenced to the initiating page and navigation", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");

  const refreshStart = source.indexOf("async function refreshSelectedPageAfterBlockDeletion");
  const deleteEmptyStart = source.indexOf("async function deleteEmptyBlock", refreshStart);
  assert.ok(refreshStart >= 0 && deleteEmptyStart > refreshStart);
  const refresh = source.slice(refreshStart, deleteEmptyStart);

  assert.match(refresh, /navigationGeneration = workspaceNavigationGeneration/);
  assert.match(
    refresh,
    /!isCurrentWorkspaceNavigation\(navigationGeneration\) \|\| state\.selectedPage\?\.id !== pageId/
  );
  assert.match(
    refresh,
    /reconciliationNavigationGeneration = await openPage\(pageId, \{ skipFlush: true \}\)/
  );
  assert.match(
    refresh,
    /!isCurrentWorkspaceNavigation\(reconciliationNavigationGeneration\)[\s\S]*state\.selectedPage\?\.id !== pageId/
  );

  const emptyDeleteEnd = source.indexOf("\nfunction focusPendingBlock", deleteEmptyStart);
  const emptyDelete = source.slice(deleteEmptyStart, emptyDeleteEnd);
  assert.match(emptyDelete, /const pageId = state\.selectedPage\?\.id;/);
  assert.match(emptyDelete, /const navigationGeneration = workspaceNavigationGeneration;/);
  assert.match(emptyDelete, /assertNoPendingLocalBlockDrafts\(pageId, \[blockId\]/);
  assert.doesNotMatch(
    emptyDelete,
    /refreshSelectedPageAfterBlockDeletion\(state\.selectedPage\.id/
  );
  assert.match(
    emptyDelete,
    /refreshSelectedPageAfterBlockDeletion\(pageId,[\s\S]*navigationGeneration/
  );
});

test("openPage exposes its request generation for fenced follow-up reconciliation", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const openStart = source.indexOf("async function openPage");
  const bootStart = source.indexOf("async function boot", openStart);
  const openPage = source.slice(openStart, bootStart);

  assert.match(openPage, /const navigationGeneration = \+\+workspaceNavigationGeneration;/);
  assert.match(openPage, /await withPageEditLock\(/);
  assert.match(openPage, /return navigationGeneration;/);
});

test("standalone reproduction proves navigation during delete cannot create a starter on another page", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-block-delete-navigation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.wrongPageStarterCreated, true);
  assert.equal(result.fixed.newerNavigationPreserved, true);
  assert.equal(result.fixed.wrongPageStarterPrevented, true);
  assert.deepEqual(result.fixed.pageBBlocks, []);
});
