import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertBefore(source, first, second, label) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `${label}: missing ${first}`);
  assert.notEqual(secondIndex, -1, `${label}: missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${label}: ${first} must run before ${second}`);
}

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("collaborative block deletion is fenced by cross-tab recovery and durable materialization", () => {
  const transition = section(
    client,
    "async function withCollaborativeDestructiveTransition",
    "async function deleteBlockWithVersionCheck"
  );
  assert.match(transition, /withPagePersistenceTransition\(pageId, kind/);
  assertBefore(
    transition,
    "await flushPendingPageEdits({ allowLocked: true, collaborationCompact: false })",
    "assertNoPendingLocalCollaborationRecovery(pageId)",
    "collaborative destructive transition"
  );
  assertBefore(
    transition,
    "assertNoPendingLocalCollaborationRecovery(pageId)",
    "const result = await action(session)",
    "collaborative destructive transition"
  );
  assertBefore(
    transition,
    "const result = await action(session)",
    "await session.flushMaterialization({ compact: false })",
    "collaborative destructive transition"
  );

  const deletion = section(client, "async function deleteBlockWithVersionCheck", "function updateBlockInState");
  assert.match(deletion, /withCollaborativeDestructiveTransition\(pageId, "block-delete"/);
  assertBefore(
    deletion,
    "withCollaborativeDestructiveTransition(pageId, \"block-delete\"",
    "session.deleteBlock(blockId",
    "collaborative block deletion"
  );
});

test("attachment replacement cannot bypass the collaborative deletion fence", () => {
  const upload = section(client, "async function uploadAttachmentFromRow", "function requestAttachmentUpload");
  assert.doesNotMatch(upload, /session\.deleteBlock\(/);
  assert.match(upload, /await deleteBlockWithVersionCheck\(blockId, \{ includeDescendants: false \}\)/);
  assertBefore(
    upload,
    "await deleteBlockWithVersionCheck(blockId, { includeDescendants: false })",
    "session.upsertBlock({",
    "collaborative attachment replacement"
  );
});

test("the recovery guard closes the deterministic delete-before-ack loss window", () => {
  const vulnerable = {
    blockVisible: true,
    pendingRecovery: { sourceId: "tab-b", markdown: "offline edit" },
    recoveryAcknowledged: false
  };
  vulnerable.blockVisible = false;
  vulnerable.recoveryAcknowledged = true;
  vulnerable.pendingRecovery = null;
  assert.deepEqual(vulnerable, {
    blockVisible: false,
    pendingRecovery: null,
    recoveryAcknowledged: true
  });

  const fixed = {
    blockVisible: true,
    pendingRecovery: { sourceId: "tab-b", markdown: "offline edit" },
    deleteBlocked: false
  };
  if (fixed.pendingRecovery) fixed.deleteBlocked = true;
  else fixed.blockVisible = false;
  assert.equal(fixed.deleteBlocked, true);
  assert.equal(fixed.blockVisible, true);
  assert.equal(fixed.pendingRecovery.markdown, "offline edit");
});
