function captureAdmission(state) {
  return Object.freeze({
    pageId: state.pageId,
    ownerId: state.ownerId,
    ownerWorkspaceGeneration: state.ownerWorkspaceGeneration,
    collectionId: state.collectionId,
    administratorShareGeneration: state.administratorShareGeneration,
    expectedPageVersion: state.pageVersion,
    expectedDirectShareGeneration: state.directShareGeneration
  });
}

function existingChecksAuthorize(kind, admission, state) {
  const samePageAndGrant = admission.pageId === state.pageId
    && admission.ownerId === state.ownerId
    && admission.collectionId === state.collectionId
    && admission.administratorShareGeneration === state.administratorShareGeneration;
  if (!samePageAndGrant) return false;

  if (kind === "page-share-delete") {
    return admission.expectedDirectShareGeneration === state.directShareGeneration;
  }
  return admission.expectedPageVersion === state.pageVersion;
}

function fixedAuthorize(kind, admission, state) {
  return existingChecksAuthorize(kind, admission, state)
    && admission.ownerWorkspaceGeneration === state.ownerWorkspaceGeneration;
}

function initialState() {
  return {
    pageId: "page-stable-id",
    ownerId: "user-owner",
    ownerWorkspaceGeneration: 12,
    collectionId: "collection-stable-id",
    administratorShareGeneration: "stable-admin-grant",
    directShareGeneration: "stable-direct-grant",
    pageVersion: 7,
    pageUpdates: 0,
    pageArchives: 0,
    tagReplacements: 0,
    directShareRemovals: 0
  };
}

function applyMutation(kind, state) {
  if (kind === "page-update") state.pageUpdates += 1;
  if (kind === "page-archive") state.pageArchives += 1;
  if (kind === "page-tags") state.tagReplacements += 1;
  if (kind === "page-share-delete") state.directShareRemovals += 1;
}

function result(kind, authorize, restoreOwnerGeneration) {
  const state = initialState();
  const admission = captureAdmission(state);

  if (restoreOwnerGeneration) {
    // A backup restore can recreate the same page ID, edit version, collection
    // membership, administrator grant generation, and direct-share generation.
    // The owner's workspace generation is the authoritative lineage boundary.
    state.ownerWorkspaceGeneration += 1;
  }

  if (!authorize(kind, admission, state)) {
    return {
      outcome: "rejected-owner-generation",
      pageUpdates: state.pageUpdates,
      pageArchives: state.pageArchives,
      tagReplacements: state.tagReplacements,
      directShareRemovals: state.directShareRemovals
    };
  }

  applyMutation(kind, state);
  return {
    outcome: "committed",
    pageUpdates: state.pageUpdates,
    pageArchives: state.pageArchives,
    tagReplacements: state.tagReplacements,
    directShareRemovals: state.directShareRemovals
  };
}

const kinds = ["page-update", "page-archive", "page-tags", "page-share-delete"];
const staleRestoreRace = Object.fromEntries(kinds.map((kind) => [
  kind,
  {
    vulnerable: result(kind, existingChecksAuthorize, true),
    fixed: result(kind, fixedAuthorize, true)
  }
]));

const sameGenerationAdmission = Object.fromEntries(kinds.map((kind) => [
  kind,
  fixedAuthorize(kind, captureAdmission(initialState()), initialState())
]));

process.stdout.write(JSON.stringify({ staleRestoreRace, sameGenerationAdmission }));
