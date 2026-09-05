function simulateCollaboratorPageCreate({
  admittedGrantGeneration,
  currentGrantGeneration,
  fixed,
  replay = false,
  parentExists = true
}) {
  if (replay) {
    return { outcome: "replayed", createdPages: 0 };
  }
  if (!parentExists) {
    return { outcome: "invalid-parent", createdPages: 0 };
  }
  if (fixed && admittedGrantGeneration !== currentGrantGeneration) {
    return { outcome: "rejected-access-generation", createdPages: 0 };
  }
  return { outcome: "committed", createdPages: 1 };
}

function simulatePostCommitCleanup({ archived, moved, fixed }) {
  const disconnected = [];
  if (archived) disconnected.push("root-archived-room");
  if (fixed) {
    if (moved) disconnected.push("descendant-old-collection-room");
  } else if (!archived && moved) {
    disconnected.push("descendant-old-collection-room");
  }
  return disconnected;
}

const staleCreate = {
  admittedGrantGeneration: "cshare_before_restore",
  currentGrantGeneration: "cshare_after_restore"
};

const sameGenerationCreate = {
  admittedGrantGeneration: "cshare_current",
  currentGrantGeneration: "cshare_current"
};

const result = {
  staleCollaboratorPageCreate: {
    vulnerable: simulateCollaboratorPageCreate({ ...staleCreate, fixed: false }),
    fixed: simulateCollaboratorPageCreate({ ...staleCreate, fixed: true })
  },
  sameGenerationCollaboratorPageCreate: simulateCollaboratorPageCreate({
    ...sameGenerationCreate,
    fixed: true
  }),
  replayAfterParentRemoval: simulateCollaboratorPageCreate({
    ...sameGenerationCreate,
    fixed: true,
    replay: true,
    parentExists: false
  }),
  combinedArchiveAndMoveCleanup: {
    vulnerable: simulatePostCommitCleanup({ archived: true, moved: true, fixed: false }),
    fixed: simulatePostCommitCleanup({ archived: true, moved: true, fixed: true })
  }
};

process.stdout.write(`${JSON.stringify(result)}\n`);
