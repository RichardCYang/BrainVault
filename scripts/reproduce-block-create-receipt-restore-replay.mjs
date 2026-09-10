const originalReceipt = Object.freeze({
  actorId: "collaborator_1",
  mutationId: "mut_lost_response",
  pageId: "page_stable",
  blockId: "blk_stable",
  requestHash: "same_request_hash",
  workspaceGeneration: 7,
  workspaceOwnerId: "owner_1",
  ownerWorkspaceGeneration: 11
});

function vulnerableReplay(receipt, current) {
  if (
    receipt.pageId !== current.pageId
    || receipt.requestHash !== current.requestHash
  ) return "collision";
  return current.blockIds.has(receipt.blockId)
    ? "replayed-restored-block"
    : "replay-unavailable";
}

function fixedReplay(receipt, current) {
  if (
    receipt.pageId !== current.pageId
    || receipt.requestHash !== current.requestHash
  ) return "collision";
  if (
    receipt.workspaceGeneration !== current.workspaceGeneration
    || receipt.workspaceOwnerId !== current.workspaceOwnerId
    || receipt.ownerWorkspaceGeneration !== current.ownerWorkspaceGeneration
  ) return "superseded";
  return current.blockIds.has(receipt.blockId)
    ? "replayed-original-block"
    : "replay-unavailable";
}

const sameGeneration = {
  pageId: "page_stable",
  requestHash: "same_request_hash",
  blockIds: new Set(["blk_stable"]),
  workspaceGeneration: 7,
  workspaceOwnerId: "owner_1",
  ownerWorkspaceGeneration: 11
};

const ownerRestored = {
  ...sameGeneration,
  blockIds: new Set(["blk_stable"]),
  // The collaborator's own generation remains valid, while the destination
  // owner independently restores a backup that recreates stable IDs.
  ownerWorkspaceGeneration: 12
};

const actorRestored = {
  ...sameGeneration,
  workspaceGeneration: 8
};

process.stdout.write(JSON.stringify({
  reproduction: {
    lostResponseReceiptSurvivesPageRecreation: true,
    restoredPageAndBlockIdsAreStable: true,
    actorSessionCanRemainCurrentWhenDestinationOwnerRestores: true
  },
  ownerRestoreReplay: {
    vulnerable: vulnerableReplay(originalReceipt, ownerRestored),
    fixed: fixedReplay(originalReceipt, ownerRestored)
  },
  actorRestoreReplay: {
    vulnerable: vulnerableReplay(originalReceipt, actorRestored),
    fixed: fixedReplay(originalReceipt, actorRestored)
  },
  sameGenerationReplay: fixedReplay(originalReceipt, sameGeneration)
}, null, 2));
