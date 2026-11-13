import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEditorHistory } from "../public/editor-history.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function functionSource(name, nextName) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start + 1) : source.length;
  assert.notEqual(end, -1, `${nextName} must exist after ${name}`);
  return source.slice(start, end);
}

test("structural steps share the undo stack with text steps", () => {
  const history = createEditorHistory({ captureTimeout: 0 });
  history.seed("page-1", "block:a", { markdown: "" });
  history.record({ pageId: "page-1", key: "block:a", value: { markdown: "hello" }, coalesce: false });
  const id = history.push({ pageId: "page-1", meta: { kind: "structure", op: "split" } });
  assert.equal(typeof id, "number");
  assert.equal(history.getState("page-1").undoDepth, 2);

  const top = history.peek("page-1", "undo");
  assert.equal(top.structural, true);
  assert.equal(top.id, id);
  assert.equal(history.commit("page-1", "undo", { id, meta: { kind: "structure", op: "split", note: "updated" } }), true);
  assert.equal(history.peek("page-1", "redo").meta.note, "updated");
  // The text step below is untouched and still next.
  assert.deepEqual(history.peek("page-1", "undo").after, { markdown: "hello" });
});

test("a structural step completed after newer edits is dropped, not replayed out of order", () => {
  const history = createEditorHistory({ captureTimeout: 0 });
  const id = history.push({ pageId: "page-1", meta: { op: "move" } });
  history.seed("page-1", "block:a", { markdown: "" });
  history.record({ pageId: "page-1", key: "block:a", value: { markdown: "typed meanwhile" }, coalesce: false });
  assert.equal(history.commit("page-1", "undo", { id }), true);
  const state = history.getState("page-1");
  assert.equal(state.undoDepth, 1);
  assert.equal(state.redoDepth, 0);
  assert.deepEqual(history.peek("page-1", "undo").after, { markdown: "typed meanwhile" });
});

test("pushing a structural step clears redo like any new edit", () => {
  const history = createEditorHistory({ captureTimeout: 0 });
  history.seed("page-1", "title", "A");
  history.record({ pageId: "page-1", key: "title", value: "B", coalesce: false });
  history.commit("page-1", "undo");
  assert.equal(history.getState("page-1").redoDepth, 1);
  history.push({ pageId: "page-1", meta: { op: "create" } });
  assert.equal(history.getState("page-1").redoDepth, 0);
});

test("rebase moves a baseline without adding a step", () => {
  const history = createEditorHistory({ captureTimeout: 0 });
  history.seed("page-1", "block:a", { markdown: "one two" });
  history.rebase("page-1", "block:a", { markdown: "one" });
  assert.equal(history.getState("page-1").undoDepth, 0);
  history.record({ pageId: "page-1", key: "block:a", value: { markdown: "one!" }, coalesce: false });
  assert.deepEqual(history.peek("page-1", "undo").before, { markdown: "one" });
});

test("forget drops only the fields a collaborator changed", () => {
  const history = createEditorHistory({ captureTimeout: 0 });
  history.seed("page-1", "block:a", { markdown: "" });
  history.seed("page-1", "block:b", { markdown: "" });
  history.record({ pageId: "page-1", key: "block:a", value: { markdown: "mine" }, coalesce: false });
  history.record({ pageId: "page-1", key: "block:b", value: { markdown: "also mine" }, coalesce: false });
  history.push({ pageId: "page-1", meta: { op: "move" } });

  assert.equal(history.forget("page-1", ["block:a"]), 1);
  assert.equal(history.getState("page-1").undoDepth, 2);
  history.discard("page-1", "undo");
  assert.equal(history.peek("page-1", "undo").key, "block:b");

  // The forgotten field starts over from the next value it is seen with, so
  // a later local step cannot reach back across the peer's change.
  history.record({ pageId: "page-1", key: "block:a", value: { markdown: "peer text" } });
  history.record({ pageId: "page-1", key: "block:a", value: { markdown: "peer text, then mine" }, coalesce: false });
  assert.deepEqual(history.peek("page-1", "undo").before, { markdown: "peer text" });
});

test("remove deletes one step by id from either stack", () => {
  const history = createEditorHistory({ captureTimeout: 0 });
  const first = history.push({ pageId: "page-1", meta: { op: "delete" } });
  const second = history.push({ pageId: "page-1", meta: { op: "move" } });
  assert.equal(history.remove("page-1", first), true);
  assert.equal(history.getState("page-1").undoDepth, 1);
  assert.equal(history.peek("page-1", "undo").id, second);
  assert.equal(history.remove("page-1", first), false);
});

test("editor commands record one structural step each", () => {
  const settle = functionSource("settleBlockSplit", "recordBlockSplitEditorHistory");
  assert.match(settle, /recordBlockSplitEditorHistory\(sourceId, createdId\)/);
  assert.match(functionSource("splitBlockAtCaret", "runBlockSplit"), /withBlockEditorHistorySuppressed\(\(\) => runBlockSplit\(/);
  const merge = functionSource("mergeBlockIntoPrevious", "mergeBlockRowsIntoPrevious");
  assert.match(merge, /withBlockEditorHistorySuppressed\(\(\) => mergeBlockRowsIntoPrevious\(row, target\)\)/);
  assert.match(merge, /op: "merge"/);
  assert.match(functionSource("deleteEmptyBlockWithHistory", "focusPendingBlock"), /op: "delete"/);
  assert.match(functionSource("finishBlockDrag", "getBlockStepMoveAvailability"), /op: "move"/);
  assert.match(source, /recordStructuralEditorHistory\(\{ op: "create", blockId: inserted\.block\.id, snapshot: null \}\)/);
});

test("replaying a structural step never records new steps and validates the page first", () => {
  const record = functionSource("recordStructuralEditorHistory", "getEditorHistoryBlockText");
  assert.match(record, /structuralEditorHistoryReplayDepth > 0/);
  const join = functionSource("joinBlocksForEditorHistory", "separateBlocksForEditorHistory");
  assert.match(join, /upper\.value !== meta\.head \|\| lower\.value !== meta\.tail\) return \{ status: "stale" \}/);
  assert.match(join, /getBlockMergeTarget\(lower\.row\) !== upper\.row/);
  const remove = functionSource("removeBlockForEditorHistory", "restoreBlockForEditorHistory");
  assert.match(remove, /snapshot\.markdown !== meta\.snapshot\.markdown/);
  const runner = functionSource("runStructuralEditorHistoryEntry", "normalizeParentBlockId");
  assert.match(runner, /structuralEditorHistoryReplayDepth \+= 1/);
  assert.match(runner, /pageEditorHistory\.discard\(pageId, direction, \{ id: entry\.id \}\)/);
});

test("the delete notice and Ctrl/Cmd+Z share one step", () => {
  const notice = functionSource("restoreDeletedBlockFromNotice", "handleListBlockEnter");
  assert.match(notice, /findRenderedBlockRow\(resolveEditorHistoryBlockId\(blockId\)\)\) return/);
  assert.match(notice, /pageEditorHistory\.remove\(snapshot\.pageId, historyEntryId\)/);
});
