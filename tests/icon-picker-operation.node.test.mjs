import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createIconPickerOperationGuard,
  getIconPickerTargetKey
} from "../public/icon-picker-operation.js";

test("icon-picker targets have stable page-scoped keys", () => {
  assert.equal(getIconPickerTargetKey({ type: "page", pageId: "page-one" }), "page:page-one");
  assert.equal(getIconPickerTargetKey({ type: "defaultCollection" }), "default-collection");
  assert.equal(
    getIconPickerTargetKey({ type: "accordionItem", pageId: "page-one", blockId: "block-one", itemId: "item-one" }),
    "accordion:page-one:block-one:item-one"
  );
  assert.equal(getIconPickerTargetKey({ type: "page", pageId: "" }), null);
  assert.equal(getIconPickerTargetKey(null), null);
});

test("icon-picker operations reject closed, replaced, and cross-page intent", () => {
  const guard = createIconPickerOperationGuard();
  const pageOne = getIconPickerTargetKey({ type: "page", pageId: "page-one" });
  const pageTwo = getIconPickerTargetKey({ type: "page", pageId: "page-two" });

  const firstRead = guard.begin(pageOne);
  assert.equal(guard.isCurrent(firstRead, pageOne), true);
  assert.equal(guard.isCurrent(firstRead, pageTwo), false);

  const replacementRead = guard.begin(pageOne);
  assert.equal(guard.isCurrent(firstRead, pageOne), false);
  assert.equal(guard.isCurrent(replacementRead, pageOne), true);

  guard.invalidate();
  assert.equal(guard.isCurrent(replacementRead, pageOne), false);
  assert.equal(guard.isCurrent(guard.begin(null), null), false);
});

test("custom icon file reads and save completion UI remain scoped to the originating picker", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

  const openPicker = app.slice(app.indexOf("function openEmojiPicker"), app.indexOf("function closeEmojiPicker"));
  assert.match(openPicker, /iconPickerOperationGuard\.invalidate\(\);/);
  assert.doesNotMatch(openPicker, /state\.emojiSaving\s*=\s*false/);
  assert.match(openPicker, /toggleAttribute\("aria-busy", state\.emojiSaving\)/);

  const closePicker = app.slice(app.indexOf("function closeEmojiPicker"), app.indexOf("function openPageEmojiPicker"));
  assert.match(closePicker, /iconPickerOperationGuard\.invalidate\(\);/);

  const setTab = app.slice(app.indexOf("function setIconPickerTab"), app.indexOf("function normalizeCustomIconUrl"));
  assert.match(setTab, /state\.activeIconPickerTab !== tabName[\s\S]*?iconPickerOperationGuard\.invalidate\(\)/);

  const saveSelection = app.slice(app.indexOf("async function saveEmojiSelection"), app.indexOf("function handleEmojiPickerKeydown"));
  assert.match(saveSelection, /operation \?\? iconPickerOperationGuard\.begin\(targetKey\)/);
  assert.match(saveSelection, /iconPickerOperationGuard\.isCurrent\(activeOperation, targetKey\)/);
  assert.match(saveSelection, /if \(iconPickerOperationGuard\.isCurrent\(activeOperation, targetKey\)\) \{[\s\S]*?closeEmojiPicker/);
  assert.match(saveSelection, /state\.activeIconPickerTab === "custom"[\s\S]*?iconPickerOperationGuard\.isCurrent\(activeOperation, getIconPickerTargetKey\(state\.emojiPickerTarget\)\)/);

  const customFile = app.slice(app.indexOf("async function applyCustomIconFile"), app.indexOf('elements.emojiPickerClose.addEventListener'));
  assert.match(customFile, /const authenticationScope = captureAuthenticatedSessionScope\(\);/);
  assert.match(customFile, /const operation = iconPickerOperationGuard\.begin\(targetKey\);[\s\S]*?await validateCustomIconFileContents\(file\)[\s\S]*?await uploadCustomIconFile\(file, \{ authenticationScope \}\);/);
  assert.match(customFile, /!isCurrentAuthenticatedSessionScope\(authenticationScope\)[\s\S]*?!iconPickerOperationGuard\.isCurrent\(operation, getIconPickerTargetKey\(state\.emojiPickerTarget\)\)[\s\S]*?return;/);
  assert.match(customFile, /saveEmojiSelection\(value, \{ operation, authenticationScope \}\)/);
});

test("standalone reproduction demonstrates stale custom-icon file application", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-icon-picker-operation-scope.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.crossPageWriteTarget, "page:page-two");
  assert.equal(result.fixed.crossPageWriteAccepted, false);
  assert.equal(result.vulnerable.supersededReadAccepted, true);
  assert.equal(result.fixed.supersededReadAccepted, false);
  assert.equal(result.fixed.closedPickerCompletionCanCloseReplacementPicker, false);
});
