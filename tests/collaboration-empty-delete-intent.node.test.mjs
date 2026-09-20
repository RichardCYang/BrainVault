import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  matchesCollaborativeBlockSnapshot,
  matchesCollaborativePromoteStructure
} from "../public/collaboration.js";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

function block(markdown = "") {
  return {
    id: "target",
    type: "MARKDOWN",
    markdown,
    checked: false,
    parentBlockId: null,
    sortOrder: 0,
    metadata: null
  };
}

test("collaborative empty-block deletion refuses a peer edit that arrives while the delete waits", () => {
  const expected = block("");
  const peerEdited = block("important collaborator edit");

  assert.equal(matchesCollaborativeBlockSnapshot(expected, expected), true);
  assert.equal(matchesCollaborativeBlockSnapshot(peerEdited, expected), false);
});

test("preserve-children deletion refuses a concurrent structural move around an unchanged target", () => {
  const intent = [
    { ...block(""), id: "before", sortOrder: 0 },
    { ...block(""), id: "target", sortOrder: 1 },
    { ...block("child"), id: "child", parentBlockId: "target", sortOrder: 0 },
    { ...block(""), id: "after", sortOrder: 2 }
  ];
  const current = intent.map((item) => ({ ...item }));
  const movedChild = current.find((item) => item.id === "child");
  movedChild.parentBlockId = null;
  movedChild.sortOrder = 3;

  const expectedStructure = intent
    .filter((item) => item.parentBlockId === null || item.parentBlockId === "target")
    .map(({ id, parentBlockId, sortOrder }) => ({ id, parentBlockId, sortOrder }));

  assert.equal(matchesCollaborativeBlockSnapshot(
    current.find((item) => item.id === "target"),
    intent.find((item) => item.id === "target")
  ), true, "the target-only fence does not see the peer structural edit");
  assert.equal(matchesCollaborativePromoteStructure(current, "target", expectedStructure), false);
});

test("empty-block delete captures intent before flush and requires that snapshot at Yjs commit", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const emptyDelete = section(app, "async function deleteEmptyBlock", "\nfunction focusPendingBlock");
  const snapshotIndex = emptyDelete.indexOf("const collaborativeDeleteSourceSnapshotAtStart");
  const lockIndex = emptyDelete.indexOf("return withPageEditLock(async () =>");
  assert.ok(snapshotIndex >= 0 && lockIndex > snapshotIndex, "delete intent snapshot must precede async flush/lock work");
  assert.match(emptyDelete, /expectedSourceBlock:\s*collaborativeDeleteSourceSnapshotAtStart/);
  assert.match(emptyDelete, /expectedPromoteStructure:\s*collaborativePromoteStructureAtStart/);
  assert.match(emptyDelete, /deletionResult\?\.deletedIds\?\.includes\(blockId\)/);
  assert.match(emptyDelete, /setStatus\(t\("errors\.BLOCK_EDIT_CONFLICT"\), true\)/);

  const collaboration = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const deletion = section(
    collaboration,
    "  async deleteBlock(blockId",
    "\n  async replaceBlockWithAttachmentPreservingChildren"
  );
  assert.match(deletion, /expectedSourceBlock = null/);
  const matchIndex = deletion.indexOf("matchesCollaborativeBlockSnapshot(target, expectedSourceBlock)");
  const deleteIndex = deletion.indexOf("blocks.delete(id)");
  assert.ok(matchIndex >= 0 && deleteIndex > matchIndex, "source snapshot must be checked before deleting any block");
});

test("explicit collaborative deletes without a source snapshot keep their existing behavior", () => {
  const collaboration = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const deletion = section(
    collaboration,
    "  async deleteBlock(blockId",
    "\n  async replaceBlockWithAttachmentPreservingChildren"
  );
  assert.match(
    deletion,
    /if \(expectedSourceBlock && !matchesCollaborativeBlockSnapshot\(target, expectedSourceBlock\)\)/,
    "the new fence must be opt-in so context-menu deletes remain explicit destructive actions"
  );
});

test("standalone reproduction demonstrates the fixed peer-edit race", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-collaborative-empty-delete-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.peerEditPreserved, false);
  assert.equal(result.vulnerable.deletedMarkdown, "important collaborator edit");
  assert.equal(result.fixed.peerEditPreserved, true);
  assert.equal(result.fixed.deleteApplied, false);
  assert.equal(result.structuralRace.targetOnlyFenceWouldDelete, true);
  assert.equal(result.structuralRace.structuralFenceAllowsDelete, false);
  assert.equal(result.structuralRace.peerMovePreserved, true);
});
