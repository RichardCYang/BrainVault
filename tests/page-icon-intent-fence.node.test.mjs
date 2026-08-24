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

test("page and collection icon writes revalidate picker and navigation intent through fetch preflight", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const navigationTarget = section(
    source,
    "function isPageIconNavigationTargetCurrent(",
    "async function saveEmojiSelection("
  );
  const save = section(
    source,
    "async function saveEmojiSelection(",
    "function handleEmojiPickerKeydown"
  );

  assert.match(navigationTarget, /target\?\.type !== "page"/);
  assert.match(navigationTarget, /isCurrentWorkspaceNavigation\(navigationGeneration\)/);
  assert.match(navigationTarget, /target\.isCollection === true/);
  assert.match(navigationTarget, /state\.workspaceView === "collection"/);
  assert.match(navigationTarget, /state\.activeCollectionId === target\.pageId/);
  assert.match(navigationTarget, /state\.workspaceView === "page"/);
  assert.match(navigationTarget, /state\.selectedPage\?\.id === target\.pageId/);

  assert.match(save, /navigationGeneration = undefined/);
  assert.match(save, /const pageNavigationGeneration = navigationGeneration === undefined/);
  assert.match(save, /target\.type === "page" \? workspaceNavigationGeneration : null/);
  assert.match(save, /const isPageIconIntentCurrent = \(\) =>/);
  assert.match(save, /isCurrentAuthenticatedSessionScope\(authenticationScope\)/);
  assert.match(save, /iconPickerOperationGuard\.isCurrent\(activeOperation, targetKey\)/);
  assert.match(save, /isPageIconNavigationTargetCurrent\(target, pageNavigationGeneration\)/);

  const queuedSave = section(
    save,
    "const savePageEmoji = async () =>",
    "if (state.selectedPage?.id === target.pageId) await withPageEditLock(savePageEmoji);"
  );
  assert.match(queuedSave, /if \(!isPageIconIntentCurrent\(\)\) return null;/);
  assert.match(queuedSave, /beforeFetch: isPageIconIntentCurrent/);
  assert.match(queuedSave, /data === skippedApiRequest/);
  assert.match(queuedSave, /if \(isPageIconIntentCurrent\(\)\) \{[\s\S]*?closeEmojiPicker/);
});

test("custom-icon preprocessing keeps the navigation generation from file-selection time", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const customFile = section(
    source,
    "async function applyCustomIconFile(file)",
    'elements.emojiPickerClose.addEventListener("click"'
  );

  const captureIndex = customFile.indexOf("const navigationGeneration =");
  const validateIndex = customFile.indexOf("await validateCustomIconFileContents(file)");
  const postValidateFence = customFile.indexOf("!isCustomIconNavigationCurrent()", validateIndex);
  const saveIndex = customFile.indexOf("await saveEmojiSelection(", postValidateFence);

  assert.ok(captureIndex >= 0 && validateIndex > captureIndex);
  assert.ok(postValidateFence > validateIndex && saveIndex > postValidateFence);
  assert.match(
    customFile,
    /pickerTarget\?\.type === "page"[\s\S]*?\? workspaceNavigationGeneration[\s\S]*?: null/
  );
  assert.match(
    customFile,
    /isPageIconNavigationTargetCurrent\(pickerTarget, navigationGeneration\)/
  );
  assert.match(
    customFile.slice(saveIndex),
    /\{ operation, authenticationScope, navigationGeneration \}/
  );
});

test("reproduction: closed picker or changed navigation cannot release an unsent page-icon write", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-icon-intent-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.queuedPickerClose.vulnerable.requestWouldStart, true);
  assert.equal(result.queuedPickerClose.fixed.requestWouldStart, false);
  assert.equal(result.queuedNavigation.vulnerable.requestWouldStart, true);
  assert.equal(result.queuedNavigation.fixed.requestWouldStart, false);
  assert.equal(result.fetchPreflight.vulnerable.requestReachedFetch, true);
  assert.equal(result.fetchPreflight.fixed.requestReachedFetch, false);
  assert.equal(result.customFilePreparation.vulnerable.saveWouldStart, true);
  assert.equal(result.customFilePreparation.fixed.saveWouldStart, false);
  assert.equal(result.collectionNavigation.vulnerable.requestWouldStart, true);
  assert.equal(result.collectionNavigation.fixed.requestWouldStart, false);
});
