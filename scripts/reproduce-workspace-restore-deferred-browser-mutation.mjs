function runVulnerable({ intentGeneration, generationAtDispatch }) {
  // Before the fix, authentication middleware captured only the server generation
  // that existed when the delayed HTTP request finally arrived.
  const admittedGeneration = generationAtDispatch;
  const boundaryAllows = admittedGeneration === generationAtDispatch;
  return {
    intentGeneration,
    admittedGeneration,
    staleIntentAdoptedRestoredGeneration: intentGeneration !== admittedGeneration,
    mutationCommitted: boundaryAllows
  };
}

function runFixed({ intentGeneration, generationAtDispatch }) {
  // The browser now sends the generation attached to its originating user state.
  // Middleware carries it into the already-existing transaction boundary.
  const admittedGeneration = intentGeneration;
  const boundaryAllows = admittedGeneration === generationAtDispatch;
  return {
    intentGeneration,
    admittedGeneration,
    staleIntentAdoptedRestoredGeneration: false,
    mutationCommitted: boundaryAllows,
    rejectedAsWorkspaceRestored: !boundaryAllows
  };
}

const staleRace = { intentGeneration: 12, generationAtDispatch: 13 };
const sameGeneration = { intentGeneration: 13, generationAtDispatch: 13 };

process.stdout.write(JSON.stringify({
  vulnerable: runVulnerable(staleRace),
  fixed: runFixed(staleRace),
  sameGeneration: runFixed(sameGeneration)
}));
