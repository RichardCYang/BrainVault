import { matchesCollaborativeBlockSnapshot } from "../public/collaboration.js";

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

process.stdout.write(`${JSON.stringify({ vulnerable, fixed }, null, 2)}\n`);
