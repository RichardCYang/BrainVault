import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start + 1) : source.length;
  assert.notEqual(end, -1, `${nextName} must exist after ${name}`);
  return source.slice(start, end);
}

test("undo/redo integration reuses durable block and title save paths", () => {
  assert.match(source, /import \{ createEditorHistory \} from "\.\/editor-history\.js";/);
  assert.match(source, /recordBlockEditorHistory\(row, historyPayload\);/);
  assert.match(source, /recordBlockEditorHistory\(row, payload\);/);
  assert.match(source, /recordPageTitleEditorHistory\(\);/);
  assert.match(source, /scheduleBlockSave\(replacement, \{ allowConflictPrompt: false \}\)/);
  assert.match(source, /schedulePageTitleSave\(\{ allowConflictPrompt: false \}\)/);
});

test("keyboard and beforeinput undo/redo commands are supported", () => {
  assert.match(source, /key === "z".*event\.shiftKey \? "redo" : "undo"/);
  assert.match(source, /key === "y".*return "redo"/);
  assert.match(source, /event\.inputType === "historyUndo"/);
  assert.match(source, /event\.inputType === "historyRedo"/);
  assert.match(source, /isEditorHistoryTarget\(target\)/);
});

test("block history coalesces only text edits from the same editor field", () => {
  const captureGroup = functionSource("getBlockEditorHistoryCaptureGroup", "recordBlockEditorHistory");
  const recordBlock = functionSource("recordBlockEditorHistory", "recordPageTitleEditorHistory");
  assert.match(captureGroup, /HTMLTextAreaElement/);
  assert.match(captureGroup, /HTMLInputElement/);
  assert.match(captureGroup, /row\.contains\(active\)/);
  assert.match(captureGroup, /`field:\$\{controlIndex\}`/);
  assert.match(recordBlock, /captureGroup: captureGroup === null \? null : `\$\{key\}:\$\{captureGroup\}`/);
  assert.match(recordBlock, /coalesce: captureGroup !== null/);
});

test("collaboration and stale-state guards prevent overwriting newer content", () => {
  assert.match(source, /source !== "local" && \(blocksChanged \|\| titleChanged\)/);
  assert.match(source, /pageEditorHistory\.clear\(state\.selectedPage\.id\)/);
  assert.match(source, /!jsonValuesMatch\(buildBlockPayload\(row\), expected\).*"stale"/s);
  assert.match(source, /row\.dataset\.draftConflict === "true" \|\| row\.dataset\.deleting === "true"/);
});

test("history is captured only after the existing durability boundary succeeds", () => {
  const markBlockDirty = functionSource("markBlockDirty", "getBlockSaveQueue");
  const collabUpsert = markBlockDirty.indexOf("session.upsertBlock({");
  const collabRecord = markBlockDirty.indexOf("recordBlockEditorHistory(row, historyPayload, current);");
  const draftPersist = markBlockDirty.indexOf("persistBlockDraft(row)");
  const draftRecord = markBlockDirty.indexOf("recordBlockEditorHistory(row, historyPayload);");
  assert.ok(collabUpsert !== -1 && collabRecord > collabUpsert);
  assert.ok(draftPersist !== -1 && draftRecord > draftPersist);

  const saveBlockRow = functionSource("saveBlockRow", "scheduleBlockSave");
  assert.ok(saveBlockRow.indexOf("recordBlockEditorHistory(row, payload, current);") > saveBlockRow.indexOf("session.upsertBlock({"));
  const finalDraftPersist = saveBlockRow.lastIndexOf("persistBlockDraft(row, payload)");
  const finalDraftRecord = saveBlockRow.lastIndexOf("recordBlockEditorHistory(row, payload);");
  assert.ok(finalDraftPersist !== -1 && finalDraftRecord > finalDraftPersist);

  const scheduleTitle = functionSource("schedulePageTitleSave", "normalizeRecoveredBlockPayload");
  assert.ok(scheduleTitle.lastIndexOf("recordPageTitleEditorHistory(previousTitle);") > scheduleTitle.indexOf("session.setTitle(title)"));
  assert.ok(scheduleTitle.lastIndexOf("recordPageTitleEditorHistory();") > scheduleTitle.indexOf("persistPageTitleDraft()"));
});
