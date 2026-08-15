import assert from "node:assert/strict";
import { createEditorHistory } from "../public/editor-history.js";

const pageId = "page-repro";
const key = "block:tree-view";
const baseline = { metadata: { treeView: { title: "A", note: "old" } } };
const noteEdited = { metadata: { treeView: { title: "A", note: "important new" } } };
const titleEdited = { metadata: { treeView: { title: "Renamed", note: "important new" } } };

function runScenario({ fieldAware }) {
  const history = createEditorHistory({ captureTimeout: 600 });
  history.seed(pageId, key, baseline);
  history.record({
    pageId,
    key,
    value: noteEdited,
    now: 1000,
    ...(fieldAware ? { captureGroup: `${key}:field:0` } : {})
  });
  history.record({
    pageId,
    key,
    value: titleEdited,
    now: 1200,
    ...(fieldAware ? { captureGroup: `${key}:field:1` } : {})
  });

  const undo = history.peek(pageId, "undo");
  const undoDepth = history.getState(pageId).undoDepth;
  history.commit(pageId, "undo");
  const restored = undo.before;
  const nextEdit = { metadata: { treeView: { title: "After undo", note: restored.metadata.treeView.note } } };
  history.record({
    pageId,
    key,
    value: nextEdit,
    now: 2000,
    coalesce: false
  });

  return {
    undoDepth,
    restoredNote: restored.metadata.treeView.note,
    restoredTitle: restored.metadata.treeView.title,
    redoDepthAfterNextEdit: history.getState(pageId).redoDepth
  };
}

const historicalCallShape = runScenario({ fieldAware: false });
const fixedCallShape = runScenario({ fieldAware: true });

assert.equal(historicalCallShape.undoDepth, 1);
assert.equal(historicalCallShape.restoredNote, "old");
assert.equal(historicalCallShape.redoDepthAfterNextEdit, 0);
assert.equal(fixedCallShape.undoDepth, 2);
assert.equal(fixedCallShape.restoredNote, "important new");
assert.equal(fixedCallShape.restoredTitle, "A");
assert.equal(fixedCallShape.redoDepthAfterNextEdit, 0);

console.log(JSON.stringify({ historicalCallShape, fixedCallShape }, null, 2));
