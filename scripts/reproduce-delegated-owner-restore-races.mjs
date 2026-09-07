function captureAdmission(state) {
  return Object.freeze({
    ownerId: state.ownerId,
    ownerWorkspaceGeneration: state.ownerWorkspaceGeneration,
    shareGeneration: state.shareGeneration
  });
}

function vulnerableAuthorize(admission, state) {
  return admission.ownerId === state.ownerId
    && admission.shareGeneration === state.shareGeneration;
}

function fixedAuthorize(admission, state) {
  return vulnerableAuthorize(admission, state)
    && admission.ownerWorkspaceGeneration === state.ownerWorkspaceGeneration;
}

function runMutation(kind, authorize) {
  const state = {
    ownerId: "user-owner",
    ownerWorkspaceGeneration: 12,
    shareGeneration: "stable-admin-grant",
    pageCreates: 0,
    comments: 0,
    collectionShareChanges: 0
  };
  const admission = captureAdmission(state);

  // Model the destructive restore boundary recognized by BrainVault's existing
  // permanent-delete hardening: stable object/grant identities may reappear,
  // but users.attachment_generation advances for the owner.
  state.ownerWorkspaceGeneration = 13;

  if (!authorize(admission, state)) {
    return {
      outcome: "rejected-owner-generation",
      pageCreates: state.pageCreates,
      comments: state.comments,
      collectionShareChanges: state.collectionShareChanges
    };
  }

  if (kind === "page-create") state.pageCreates += 1;
  if (kind === "comment-create") state.comments += 1;
  if (kind === "collection-share") state.collectionShareChanges += 1;
  return {
    outcome: "committed",
    pageCreates: state.pageCreates,
    comments: state.comments,
    collectionShareChanges: state.collectionShareChanges
  };
}

const kinds = ["page-create", "comment-create", "collection-share"];
const staleRestoreRace = Object.fromEntries(kinds.map((kind) => [
  kind,
  {
    vulnerable: runMutation(kind, vulnerableAuthorize),
    fixed: runMutation(kind, fixedAuthorize)
  }
]));

const sameGeneration = {
  ownerId: "user-owner",
  ownerWorkspaceGeneration: 22,
  shareGeneration: "admin-grant-current"
};
const admission = captureAdmission(sameGeneration);

process.stdout.write(JSON.stringify({
  staleRestoreRace,
  sameGenerationAdmission: {
    vulnerableAccepted: vulnerableAuthorize(admission, sameGeneration),
    fixedAccepted: fixedAuthorize(admission, sameGeneration)
  }
}));
