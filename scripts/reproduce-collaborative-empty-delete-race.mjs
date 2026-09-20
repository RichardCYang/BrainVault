import {
  matchesCollaborativeBlockSnapshot,
  matchesCollaborativePromoteStructure
} from "../public/collaboration.js";

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

// 1. The user presses Backspace on an empty collaborative block.
const deleteIntentSnapshot = block("");
// 2. The destructive transition waits for queued collaboration persistence.
// 3. During that wait, a peer adds content to the same block.
const preparedDocumentTarget = block("important collaborator edit");

// Former behavior: deleteBlock rebuilt the plan from the newest prepared Yjs
// document but identified the target only by id, so the peer's content was deleted.
const vulnerable = {
  deleteApplied: preparedDocumentTarget.id === deleteIntentSnapshot.id,
  deletedMarkdown: preparedDocumentTarget.markdown,
  peerEditPreserved: false
};

// Fixed behavior: the destructive mutation compares the prepared/current target
// with the exact source snapshot captured when the empty-delete intent was made.
const sourceStillMatchesIntent = matchesCollaborativeBlockSnapshot(
  preparedDocumentTarget,
  deleteIntentSnapshot
);
const fixed = {
  deleteApplied: sourceStillMatchesIntent,
  peerEditPreserved: !sourceStillMatchesIntent,
  currentMarkdown: preparedDocumentTarget.markdown
};

// A second race exists when preserve-children deletion rewrites the structural
// scope around an unchanged empty target. A peer can move/reorder a child while
// the delete waits; checking only the target block would still allow the delete.
const structuralIntent = [
  { ...block(""), id: "before", sortOrder: 0 },
  { ...block(""), id: "target", sortOrder: 1 },
  { ...block("child"), id: "child", parentBlockId: "target", sortOrder: 0 },
  { ...block(""), id: "after", sortOrder: 2 }
];
const structuralAfterPeerMove = structuralIntent.map((item) => ({ ...item }));
const movedChild = structuralAfterPeerMove.find((item) => item.id === "child");
movedChild.parentBlockId = null;
movedChild.sortOrder = 3;

const expectedPromoteStructure = structuralIntent
  .filter((item) => item.parentBlockId === null || item.parentBlockId === "target")
  .map(({ id, parentBlockId, sortOrder }) => ({ id, parentBlockId, sortOrder }));
const targetOnlyFenceWouldDelete = matchesCollaborativeBlockSnapshot(
  structuralAfterPeerMove.find((item) => item.id === "target"),
  structuralIntent.find((item) => item.id === "target")
);
const structuralFenceAllowsDelete = matchesCollaborativePromoteStructure(
  structuralAfterPeerMove,
  "target",
  expectedPromoteStructure
);

process.stdout.write(`${JSON.stringify({
  vulnerable,
  fixed,
  structuralRace: {
    targetOnlyFenceWouldDelete,
    structuralFenceAllowsDelete,
    peerMovePreserved: !structuralFenceAllowsDelete
  }
}, null, 2)}\n`);
