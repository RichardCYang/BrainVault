import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  getCollaborativeDeleteSubtreeSnapshot,
  matchesCollaborativeDeleteSubtreeSnapshot
} from "../public/collaboration.js";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

function block(id, markdown = "", parentBlockId = null, sortOrder = 0) {
  return {
    id,
    type: "MARKDOWN",
    markdown,
    checked: false,
    parentBlockId,
    sortOrder,
    metadata: null
  };
}

const intent = [
  block("target", "root", null, 0),
  block("child", "child", "target", 0),
  block("grandchild", "grandchild", "child", 0),
  block("sibling", "sibling", null, 1)
];

test("cascade-delete snapshot covers the exact target subtree", () => {
  const expected = getCollaborativeDeleteSubtreeSnapshot(intent, "target");
  assert.deepEqual(expected?.map((item) => item.id), ["target", "child", "grandchild"]);
  assert.equal(matchesCollaborativeDeleteSubtreeSnapshot(intent, "target", expected), true);

  const childEdited = intent.map((item) => (
    item.id === "child" ? { ...item, markdown: "peer edit" } : { ...item }
  ));
  assert.equal(matchesCollaborativeDeleteSubtreeSnapshot(childEdited, "target", expected), false);

  const childAdded = [...intent, block("new-child", "peer addition", "target", 1)];
  assert.equal(matchesCollaborativeDeleteSubtreeSnapshot(childAdded, "target", expected), false);

  const childMovedOut = intent.map((item) => (
    item.id === "child" ? { ...item, parentBlockId: null, sortOrder: 2 } : { ...item }
  ));
  assert.equal(matchesCollaborativeDeleteSubtreeSnapshot(childMovedOut, "target", expected), false);
});

test("explicit context-menu delete captures subtree and mode before confirmation", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const deletion = section(
    app,
    '    if (button.dataset.action === "delete-block") {',
    "\n    }\n  } catch (error)"
  );
  const modeIndex = deletion.indexOf("const collaborativeAtIntent = isCollaborativePage()");
  const subtreeIndex = deletion.indexOf("getCollaborativeDeleteSubtreeSnapshot(");
  const confirmIndex = deletion.indexOf('window.confirm(t("confirm.deleteBlock"))');
  const lockIndex = deletion.indexOf("await withPageEditLock(async () =>");
  assert.ok(modeIndex >= 0 && subtreeIndex > modeIndex);
  assert.ok(confirmIndex > subtreeIndex, "the destructive subtree snapshot must precede user confirmation waits");
  assert.ok(lockIndex > confirmIndex);
  assert.match(deletion, /expectedCollaborationMode:\s*collaborativeAtIntent/);
  assert.match(deletion, /expectedDeleteSubtree/);
  assert.match(deletion, /deletionResult\?\.deletedIds\?\.includes\(blockId\)/);
  assert.match(deletion, /errors\.BLOCK_EDIT_CONFLICT/);
});

test("delete helper rejects either collaboration-mode transition before choosing a persistence path", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const deletion = section(app, "async function deleteBlockWithVersionCheck", "\nfunction updateBlockInState");
  const modeFence = deletion.indexOf("isCollaborativePage() !== expectedCollaborationMode");
  const collaborativeBranch = deletion.indexOf("if (isCollaborativePage())");
  const directSnapshot = deletion.indexOf("const expectedVersions = getBlockVersionSnapshot");
  assert.ok(modeFence >= 0);
  assert.ok(collaborativeBranch > modeFence, "mode fence must run before choosing Yjs deletion");
  assert.ok(directSnapshot > collaborativeBranch, "mode fence must also precede direct version snapshots");
  assert.match(deletion, /expectedDeleteSubtree/);
  assert.match(deletion, /expectedDeleteSubtree,\n\s*expectedPromoteStructure/);
});

test("prepared Yjs document is checked against the cascade snapshot before any block is deleted", () => {
  const collaboration = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const deletion = section(
    collaboration,
    "  async deleteBlock(blockId",
    "\n  async replaceBlockWithAttachmentPreservingChildren"
  );
  const subtreeCheck = deletion.indexOf(
    "matchesCollaborativeDeleteSubtreeSnapshot(snapshot, blockId, expectedDeleteSubtree)"
  );
  const deleteIndex = deletion.indexOf("blocks.delete(id)");
  assert.ok(subtreeCheck >= 0);
  assert.ok(deleteIndex > subtreeCheck, "subtree must be revalidated before deleting any prepared Yjs block");
});

test("empty-block deletion also locks the collaboration mode captured at intent", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const deletion = section(app, "async function deleteEmptyBlock", "\nfunction focusPendingBlock");
  const modeCapture = deletion.indexOf("const collaborativeAtIntent = isCollaborativePage()");
  const lockIndex = deletion.indexOf("return withPageEditLock(async () =>");
  assert.ok(modeCapture >= 0 && lockIndex > modeCapture);
  assert.match(deletion, /expectedCollaborationMode:\s*collaborativeAtIntent/);
});

test("standalone reproduction demonstrates peer-descendant loss before the fix and preservation after it", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-collaborative-explicit-delete-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.peerEditPreserved, false);
  assert.deepEqual(result.vulnerable.deletedIds.sort(), ["child", "target"].sort());
  assert.equal(result.fixedPeerEdit.conflict, true);
  assert.equal(result.fixedPeerEdit.peerEditPreserved, true);
  assert.deepEqual(result.fixedPeerEdit.deletedIds, []);
  assert.equal(result.fixedPeerAddition.conflict, true);
  assert.equal(result.fixedPeerAddition.newChildPreserved, true);
  assert.equal(result.directToCollaborative.vulnerableWouldRouteToCollaborativeDelete, true);
  assert.equal(result.directToCollaborative.fixedAllowsDelete, false);
});
