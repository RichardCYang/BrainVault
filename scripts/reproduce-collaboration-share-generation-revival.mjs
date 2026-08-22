const oldGrant = "share_old_generation";
const replacementGrant = "share_new_generation";
const otherCollaboratorGrant = "share_other_generation";
const documentEpoch = "doc_epoch_stays_live";

const oldSocket = {
  userId: "collaborator-a",
  shareGeneration: oldGrant,
  documentEpoch,
  open: true
};

const currentShares = new Map([
  ["collaborator-a", oldGrant],
  ["collaborator-b", otherCollaboratorGrant]
]);

// Owner revokes collaborator A while B remains, so the Yjs document epoch does not rotate.
currentShares.delete("collaborator-a");

// Before legacy post-COMMIT cleanup acquires the page lock, A is re-added under a new grant.
currentShares.set("collaborator-a", replacementGrant);

// Vulnerable cleanup only asks whether any current share exists; it therefore leaves the old socket open.
const vulnerableCleanupSeesAnyShare = currentShares.has(oldSocket.userId);
const vulnerableSocketStillOpen = oldSocket.open && vulnerableCleanupSeesAnyShare;

// Vulnerable WebSocket authorization checks current access + document epoch, but not grant lineage.
const vulnerableWriteAccepted =
  vulnerableSocketStillOpen
  && currentShares.has(oldSocket.userId)
  && oldSocket.documentEpoch === documentEpoch;

// Fixed cleanup targets the generation that was actually revoked.
const fixedTargetedDisconnect =
  oldSocket.shareGeneration === oldGrant;
const fixedOldSocketOpen = oldSocket.open && !fixedTargetedDisconnect;

// Even if a stale socket survives on another server instance, every frame and durable write
// must prove that its ticket generation equals the current share generation.
const fixedOldGrantAccepted =
  currentShares.get(oldSocket.userId) === oldSocket.shareGeneration;
const fixedReplacementGrantAccepted =
  currentShares.get(oldSocket.userId) === replacementGrant;

const result = {
  scenario: "revoked collaborator is re-added while another collaborator keeps the same Yjs document epoch",
  vulnerable: {
    cleanupMistakesReplacementForOldGrant: vulnerableCleanupSeesAnyShare,
    revokedSocketSurvives: vulnerableSocketStillOpen,
    staleWriteAccepted: vulnerableWriteAccepted
  },
  fixed: {
    revokedGenerationDisconnected: fixedTargetedDisconnect,
    revokedSocketSurvivesLocally: fixedOldSocketOpen,
    oldGrantAcceptedAfterReAdd: fixedOldGrantAccepted,
    replacementGrantAccepted: fixedReplacementGrantAccepted,
    documentEpochUnchanged: oldSocket.documentEpoch === documentEpoch
  },
  verified:
    vulnerableWriteAccepted === true
    && fixedTargetedDisconnect === true
    && fixedOldGrantAccepted === false
    && fixedReplacementGrantAccepted === true
};

console.log(JSON.stringify(result, null, 2));
if (!result.verified) process.exitCode = 1;
