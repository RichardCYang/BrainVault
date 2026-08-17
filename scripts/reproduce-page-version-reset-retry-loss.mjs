function vulnerableReset(history) {
  return [{ revision: 1, source: "RESET" }];
}

function fixedResetWithSnapshot({
  history,
  pageVersion,
  contentVersion,
  expectedVersion,
  expectedContentVersion,
  expectedRevision
}) {
  const currentRevision = history.reduce((max, entry) => Math.max(max, Number(entry.revision)), 0);
  if (
    pageVersion !== expectedVersion
    || contentVersion !== expectedContentVersion
    || currentRevision !== expectedRevision
  ) {
    return { history, conflict: true };
  }
  return { history: vulnerableReset(history), conflict: false };
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

function reproduceClientRefreshGap({ retainTaskUntilRefresh }) {
  const receipts = new Map();
  let history = [
    { revision: 1, source: "BASELINE" },
    { revision: 2, source: "EDIT_BEFORE_RESET" }
  ];
  const originalMutationId = "mut_refresh_gap";
  let pendingTask = { mutationId: originalMutationId };

  const firstReset = fixedReset({
    history,
    receipts,
    mutationId: pendingTask.mutationId,
    pageId: "pag_refresh"
  });
  history = firstReset.history;

  // The destructive request succeeded, but refreshing the version list failed.
  const refreshLoaded = false;
  if (!retainTaskUntilRefresh || refreshLoaded) pendingTask = null;

  history.push({ revision: 2, source: "EDIT_AFTER_REFRESH_FAILURE" });
  const retryMutationId = pendingTask?.mutationId ?? "mut_refresh_gap_retry";
  const retry = fixedReset({
    history,
    receipts,
    mutationId: retryMutationId,
    pageId: "pag_refresh"
  });

  return {
    reusedOriginalMutationId: retryMutationId === originalMutationId,
    replayedOriginalReset: retry.replayed === true,
    preservedLaterHistory: retry.history.some((entry) => entry.source === "EDIT_AFTER_REFRESH_FAILURE"),
    finalSources: retry.history.map((entry) => entry.source)
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

const vulnerableRefreshGap = reproduceClientRefreshGap({ retainTaskUntilRefresh: false });
const fixedRefreshGap = reproduceClientRefreshGap({ retainTaskUntilRefresh: true });

const observedSnapshot = {
  expectedVersion: 7,
  expectedContentVersion: 11,
  expectedRevision: 3
};
const concurrentHistory = [
  ...original,
  { revision: 4, source: "EDIT_AFTER_USER_CONFIRMED_RESET" }
];
const vulnerableConcurrentHistory = vulnerableReset(concurrentHistory);
const fixedConcurrent = fixedResetWithSnapshot({
  history: concurrentHistory,
  pageVersion: 7,
  contentVersion: 12,
  ...observedSnapshot
});

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
  },
  refreshGap: {
    vulnerable: vulnerableRefreshGap,
    fixed: fixedRefreshGap
  },
  concurrentEdit: {
    vulnerableDeletedUnseenHistory:
      !vulnerableConcurrentHistory.some((entry) => entry.source === "EDIT_AFTER_USER_CONFIRMED_RESET"),
    fixedRejectedStaleReset: fixedConcurrent.conflict === true,
    fixedPreservedUnseenHistory:
      fixedConcurrent.history.some((entry) => entry.source === "EDIT_AFTER_USER_CONFIRMED_RESET")
  }
};

console.log(JSON.stringify(output, null, 2));
