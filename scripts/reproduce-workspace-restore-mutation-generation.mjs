function commitCreate(state, admittedScope, { enforceWorkspaceGeneration }) {
  if (
    enforceWorkspaceGeneration
    && admittedScope.workspaceGeneration !== state.workspaceGeneration
  ) {
    return "rejected";
  }
  state.blocks += 1;
  state.pageContentVersion += 1;
  return "committed";
}

function runRestoreRace(enforceWorkspaceGeneration) {
  const state = {
    workspaceGeneration: 12,
    pageContentVersion: 40,
    blocks: 0
  };
  const admittedScope = {
    workspaceGeneration: state.workspaceGeneration,
    basePageContentVersion: state.pageContentVersion
  };

  // Another session restores a backup while this create request is still in flight.
  state.workspaceGeneration += 1;
  state.pageContentVersion = 9_000_000;

  const outcome = commitCreate(state, admittedScope, { enforceWorkspaceGeneration });
  return {
    outcome,
    staleBlocksCommitted: state.blocks,
    workspaceGeneration: state.workspaceGeneration
  };
}

function runSameGenerationConcurrentCreates() {
  const state = {
    workspaceGeneration: 21,
    pageContentVersion: 80,
    blocks: 0
  };
  const first = {
    workspaceGeneration: state.workspaceGeneration,
    basePageContentVersion: state.pageContentVersion
  };
  const second = {
    workspaceGeneration: state.workspaceGeneration,
    basePageContentVersion: state.pageContentVersion
  };

  const firstOutcome = commitCreate(state, first, { enforceWorkspaceGeneration: true });
  const secondOutcome = commitCreate(state, second, { enforceWorkspaceGeneration: true });
  return {
    firstOutcome,
    secondOutcome,
    blocks: state.blocks,
    pageContentVersion: state.pageContentVersion
  };
}

console.log(JSON.stringify({
  restoreRace: {
    vulnerable: runRestoreRace(false),
    fixed: runRestoreRace(true)
  },
  sameGenerationConcurrentCreates: runSameGenerationConcurrentCreates()
}, null, 2));
