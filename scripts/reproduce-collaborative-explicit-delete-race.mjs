// Deterministic model of the explicit collaborative cascade-delete race.
// This does not mutate a real workspace.
import {
  getCollaborativeDeleteSubtreeSnapshot,
  matchesCollaborativeDeleteSubtreeSnapshot
} from "../public/collaboration.js";

function block(id, markdown, parentBlockId = null, sortOrder = 0) {
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

function vulnerableCascadeDelete(snapshot, blockId) {
  const remaining = snapshot.map((item) => ({ ...item }));
  const ids = new Set([blockId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of remaining) {
      if (ids.has(item.id)) continue;
      if (item.parentBlockId && ids.has(item.parentBlockId)) {
        ids.add(item.id);
        changed = true;
      }
    }
  }
  return {
    deletedIds: [...ids],
    remaining: remaining.filter((item) => !ids.has(item.id))
  };
}

function fixedCascadeDelete(snapshot, blockId, expectedSubtree) {
  if (!matchesCollaborativeDeleteSubtreeSnapshot(snapshot, blockId, expectedSubtree)) {
    return { deletedIds: [], remaining: snapshot, conflict: true };
  }
  return { ...vulnerableCascadeDelete(snapshot, blockId), conflict: false };
}

const intent = [
  block("target", "delete me", null, 0),
  block("child", "original child", "target", 0),
  block("sibling", "keep me", null, 1)
];
const expectedSubtree = getCollaborativeDeleteSubtreeSnapshot(intent, "target");
const peerEdited = intent.map((item) => (
  item.id === "child" ? { ...item, markdown: "important collaborator edit" } : { ...item }
));
const peerAdded = [
  ...intent.map((item) => ({ ...item })),
  block("new-child", "new collaborator content", "target", 1)
];

const vulnerable = vulnerableCascadeDelete(peerEdited, "target");
const fixedEdit = fixedCascadeDelete(peerEdited, "target", expectedSubtree);
const fixedAddition = fixedCascadeDelete(peerAdded, "target", expectedSubtree);

const directToCollaborative = {
  modeAtIntent: false,
  modeAtCommit: true,
  vulnerableWouldRouteToCollaborativeDelete: true,
  fixedAllowsDelete: false
};

console.log(JSON.stringify({
  steps: [
    "User opens the block context menu on a shared page and chooses Delete.",
    "The client records the target subtree, then the destructive operation waits behind queued page work.",
    "A collaborator edits an existing child or adds a new descendant before the queued delete commits.",
    "The former cascade delete recomputes descendants from the prepared current document and deletes the newer peer content.",
    "The fixed delete compares the prepared Yjs subtree with the intent snapshot and fails closed on any content or structure change."
  ],
  vulnerable: {
    deletedIds: vulnerable.deletedIds,
    peerEditPreserved: vulnerable.remaining.some((item) => item.markdown === "important collaborator edit")
  },
  fixedPeerEdit: {
    deletedIds: fixedEdit.deletedIds,
    conflict: fixedEdit.conflict,
    peerEditPreserved: fixedEdit.remaining.some((item) => item.markdown === "important collaborator edit")
  },
  fixedPeerAddition: {
    deletedIds: fixedAddition.deletedIds,
    conflict: fixedAddition.conflict,
    newChildPreserved: fixedAddition.remaining.some((item) => item.id === "new-child")
  },
  directToCollaborative
}, null, 2));
