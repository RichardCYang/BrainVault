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

test("page-cover writes remain bound to the navigation that originated them through fetch preflight", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const persist = section(
    source,
    "async function persistPageCover(",
    "function readBlobAsDataUrl"
  );

  assert.match(persist, /navigationGeneration = workspaceNavigationGeneration/);
  assert.match(persist, /const isCoverIntentCurrent = \(\) =>/);
  assert.match(persist, /isCurrentWorkspaceNavigation\(navigationGeneration\)/);
  assert.match(persist, /state\.workspaceView === "page"/);
  assert.match(persist, /state\.selectedPage\?\.id === pageId/);
  assert.match(persist, /pageCoverOperationGuard\.isCurrent\(activeOperation, pageId\)/);
  assert.match(persist, /beforeFetch: isCoverIntentCurrent/);
  assert.match(persist, /data === skippedApiRequest/);
});

test("custom-cover image preparation retains the pre-processing navigation generation", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const handler = section(
    source,
    'elements.pageCoverCustomInput.addEventListener("change"',
    'elements.pageCoverRemoveButton.addEventListener("click"'
  );

  const captureIndex = handler.indexOf("const navigationGeneration = workspaceNavigationGeneration;");
  const prepareIndex = handler.indexOf("await prepareCustomCoverDataUrl(file);");
  const postPrepareFenceIndex = handler.indexOf(
    "!isCurrentWorkspaceNavigation(navigationGeneration)",
    prepareIndex
  );
  const persistIndex = handler.indexOf("await persistPageCover(", postPrepareFenceIndex);

  assert.ok(captureIndex >= 0 && prepareIndex > captureIndex);
  assert.ok(postPrepareFenceIndex > prepareIndex && persistIndex > postPrepareFenceIndex);
  assert.match(
    handler.slice(persistIndex),
    /\{ operation, authenticationScope, navigationGeneration \}/
  );
});

test("reproduction: navigation during cover preparation or API preflight no longer sends the stale write", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-cover-navigation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.preparationGap.vulnerable.requestWouldStart, true);
  assert.equal(result.preparationGap.fixed.requestWouldStart, false);
  assert.equal(result.fetchPreflightGap.vulnerable.requestReachedFetch, true);
  assert.equal(result.fetchPreflightGap.fixed.requestReachedFetch, false);
});
