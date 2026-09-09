function assessVulnerable(receipt, current) {
  if (receipt.requestHash !== current.requestHash) return "collision";
  if (receipt.actorGeneration !== current.actorGeneration) return "superseded";
  return current.pages.has(receipt.pageId) ? "replayed-restored-page" : "unavailable";
}

function assessFixed(receipt, current) {
  if (receipt.requestHash !== current.requestHash) return "collision";
  if (receipt.actorGeneration !== current.actorGeneration) return "superseded";
  if (receipt.workspaceOwnerId !== current.workspaceOwnerId) return "superseded";
  if (receipt.ownerGeneration !== current.ownerGeneration) return "superseded";
  return current.pages.has(receipt.pageId) ? "replayed-original-page" : "unavailable";
}

const receipt = {
  requestHash: "same-create-payload",
  actorGeneration: 7,
  workspaceOwnerId: "owner-b",
  ownerGeneration: 12,
  pageId: "pag-stable"
};

// The collaborator's session/workspace is unchanged, but the destination owner
// restores a backup that recreates the stable page id at a newer generation.
const afterOwnerRestore = {
  requestHash: "same-create-payload",
  actorGeneration: 7,
  workspaceOwnerId: "owner-b",
  ownerGeneration: 13,
  pages: new Set(["pag-stable"])
};

const sameGeneration = {
  requestHash: "same-create-payload",
  actorGeneration: 7,
  workspaceOwnerId: "owner-b",
  ownerGeneration: 12,
  pages: new Set(["pag-stable"])
};

process.stdout.write(JSON.stringify({
  ownerRestoreReplay: {
    vulnerable: assessVulnerable(receipt, afterOwnerRestore),
    fixed: assessFixed(receipt, afterOwnerRestore)
  },
  sameGenerationReplay: assessFixed(receipt, sameGeneration)
}));
