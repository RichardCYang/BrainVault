const result = {
  scenario: {
    pageId: "page_same_stable_id",
    capturedOwnerId: "owner_1",
    preRestoreWorkspaceGeneration: 12,
    postRestoreWorkspaceGeneration: 13,
    basePageContentVersionRequired: false
  },
  vulnerable: {},
  fixed: {}
};

// Model the old ordinary-block-create admission:
// it remembered only ownerId, so a restore that re-created the same page ID
// for the same owner remained indistinguishable to the final write.
result.vulnerable.ownerCheckPasses =
  result.scenario.capturedOwnerId === "owner_1";
result.vulnerable.outcome =
  result.vulnerable.ownerCheckPasses ? "stale-block-committed" : "rejected";

// Model the patched admission:
// the owner row is locked before the page and the current workspace generation
// must still match the generation captured before the transaction.
result.fixed.generationMatches =
  result.scenario.preRestoreWorkspaceGeneration ===
  result.scenario.postRestoreWorkspaceGeneration;
result.fixed.outcome =
  result.fixed.generationMatches ? "stale-block-committed" : "rejected-workspace-restored";

result.sameGenerationControl = {
  generationMatches: 12 === 12,
  outcome: 12 === 12 ? "block-create-admitted" : "rejected"
};

process.stdout.write(`${JSON.stringify(result)}\n`);
