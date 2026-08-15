import test from "node:test";
import assert from "node:assert/strict";
import { createEditorHistory } from "../public/editor-history.js";

test("editor history coalesces typing and supports undo/redo", () => {
  const history = createEditorHistory({ captureTimeout: 500 });
  history.seed("page-1", "block:b1", { markdown: "a" });
  assert.equal(history.record({ pageId: "page-1", key: "block:b1", value: { markdown: "ab" }, now: 1000 }), true);
  assert.equal(history.record({ pageId: "page-1", key: "block:b1", value: { markdown: "abc" }, now: 1200 }), true);
  assert.deepEqual(history.getState("page-1"), {
    pageId: "page-1",
    undoDepth: 1,
    redoDepth: 0,
    retainedBytes: history.getState("page-1").retainedBytes
  });
  assert.deepEqual(history.peek("page-1", "undo").before, { markdown: "a" });
  assert.deepEqual(history.peek("page-1", "undo").after, { markdown: "abc" });
  assert.equal(history.commit("page-1", "undo"), true);
  assert.equal(history.getState("page-1").redoDepth, 1);
  assert.equal(history.commit("page-1", "redo"), true);
  assert.equal(history.getState("page-1").undoDepth, 1);
});

test("new edits after undo clear redo", () => {
  const history = createEditorHistory({ captureTimeout: 0 });
  history.seed("page-1", "title", "A");
  history.record({ pageId: "page-1", key: "title", value: "B", now: 1, coalesce: false });
  history.commit("page-1", "undo");
  assert.equal(history.getState("page-1").redoDepth, 1);
  history.record({ pageId: "page-1", key: "title", value: "C", now: 2, coalesce: false });
  assert.equal(history.getState("page-1").redoDepth, 0);
  assert.equal(history.peek("page-1", "undo").after, "C");
});

test("history is page-scoped and bounded", () => {
  const history = createEditorHistory({ maxEntries: 2, maxBytes: 4096, captureTimeout: 0 });
  history.seed("page-1", "title", "0");
  for (let index = 1; index <= 3; index += 1) {
    history.record({ pageId: "page-1", key: "title", value: String(index), now: index, coalesce: false });
  }
  assert.equal(history.getState("page-1").undoDepth, 2);
  history.setPage("page-2");
  assert.equal(history.getState("page-2").undoDepth, 0);
  history.setPage("page-1");
  assert.equal(history.getState("page-1").undoDepth, 0);

  const bounded = createEditorHistory({ maxBytes: 1024 });
  bounded.seed("page-1", "block:b1", { markdown: "small" });
  assert.equal(bounded.record({
    pageId: "page-1",
    key: "block:b1",
    value: { markdown: "x".repeat(5000) },
    coalesce: false
  }), false);
  assert.equal(bounded.getState("page-1").undoDepth, 0);
});

test("stale entries can be discarded without entering redo", () => {
  const history = createEditorHistory({ captureTimeout: 0 });
  history.seed("page-1", "block:b1", { markdown: "a" });
  history.record({ pageId: "page-1", key: "block:b1", value: { markdown: "b" }, coalesce: false });
  assert.equal(history.discard("page-1", "undo"), true);
  assert.equal(history.getState("page-1").undoDepth, 0);
  assert.equal(history.getState("page-1").redoDepth, 0);
});
