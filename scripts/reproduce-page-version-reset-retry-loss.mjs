function vulnerableReset(history) {
  return [{ revision: 1, source: "RESET" }];
}

function fixedReset({ history, receipts, mutationId, pageId }) {
  const existing = receipts.get(mutationId);
  if (existing) {
    if (existing.pageId !== pageId) throw new Error("MUTATION_ID_REUSED");
    return { history, result: existing.result, replayed: true };
  }

  const result = { revision: 1, deletedCount: history.length };
  receipts.set(mutationId, { pageId, result });
  return {
    history: [{ revision: 1, source: "RESET" }],
    result,
    replayed: false
  };
}

const original = [
  { revision: 1, source: "BASELINE" },
  { revision: 2, source: "EDIT" },
  { revision: 3, source: "EDIT" }
];

let vulnerableHistory = vulnerableReset(original);
// The transaction committed, but the response was lost. A new edit arrives before the user retries.
vulnerableHistory.push({ revision: 2, source: "EDIT_AFTER_FIRST_RESET" });
vulnerableHistory = vulnerableReset(vulnerableHistory);

const receipts = new Map();
let fixedState = fixedReset({
  history: original,
  receipts,
  mutationId: "mut_reset_response_lost",
  pageId: "pag_a"
});
fixedState.history.push({ revision: 2, source: "EDIT_AFTER_FIRST_RESET" });
fixedState = fixedReset({
  history: fixedState.history,
  receipts,
  mutationId: "mut_reset_response_lost",
  pageId: "pag_a"
});

let collisionRejected = false;
try {
  fixedReset({
    history: [{ revision: 1, source: "BASELINE" }],
    receipts,
    mutationId: "mut_reset_response_lost",
    pageId: "pag_b"
  });
} catch (error) {
  collisionRejected = error?.message === "MUTATION_ID_REUSED";
}

const output = {
  vulnerable: {
    responseLossFollowedByRetryDeletedNewHistory:
      !vulnerableHistory.some((entry) => entry.source === "EDIT_AFTER_FIRST_RESET"),
    finalSources: vulnerableHistory.map((entry) => entry.source)
  },
  fixed: {
    replayReturnedOriginalResult: fixedState.replayed === true
      && fixedState.result.deletedCount === original.length,
    responseLossFollowedByRetryPreservedNewHistory:
      fixedState.history.some((entry) => entry.source === "EDIT_AFTER_FIRST_RESET"),
    finalSources: fixedState.history.map((entry) => entry.source),
    mutationCollisionRejected: collisionRejected
  }
};

console.log(JSON.stringify(output, null, 2));
