function createHarness() {
  let generation = 1;
  const accountKey = "user-1";
  const commits = [];

  function captureScope() {
    return Object.freeze({ generation, targetKey: accountKey });
  }

  function isCurrent(scope) {
    return Boolean(
      scope
        && scope.generation === generation
        && scope.targetKey === accountKey
    );
  }

  function rotateCredentials() {
    generation += 1;
  }

  function vulnerableDelayedWrite(kind) {
    // The vulnerable callback captured auth only when it finally reached api().
    const apiScope = captureScope();
    if (isCurrent(apiScope)) commits.push(kind);
  }

  function fixedDelayedWrite(kind, initiatingScope) {
    // The fixed path carries the scope from the edit/queue/reorder that originated
    // the write. It refuses to let that work adopt the replacement credential.
    if (!isCurrent(initiatingScope)) return false;
    commits.push(kind);
    return true;
  }

  return {
    captureScope,
    rotateCredentials,
    vulnerableDelayedWrite,
    fixedDelayedWrite,
    commits
  };
}

function runVulnerableScenario() {
  const harness = createHarness();
  // Three operations are initiated under generation 1, then delayed by debounce,
  // a busy save queue, or recovery/retry durability work.
  harness.captureScope();
  harness.captureScope();
  harness.captureScope();

  harness.rotateCredentials();

  harness.vulnerableDelayedWrite("title");
  harness.vulnerableDelayedWrite("block");
  harness.vulnerableDelayedWrite("reorder");

  return {
    delayedTitleCrossesRotation: harness.commits.includes("title"),
    queuedBlockSaveCrossesRotation: harness.commits.includes("block"),
    reorderRetryCrossesRotation: harness.commits.includes("reorder")
  };
}

function runFixedScenario() {
  const harness = createHarness();
  const titleScope = harness.captureScope();
  const blockScope = harness.captureScope();
  const reorderScope = harness.captureScope();

  harness.rotateCredentials();

  const results = [
    harness.fixedDelayedWrite("title", titleScope),
    harness.fixedDelayedWrite("block", blockScope),
    harness.fixedDelayedWrite("reorder", reorderScope)
  ];

  return {
    delayedTitleCrossesRotation: harness.commits.includes("title"),
    queuedBlockSaveCrossesRotation: harness.commits.includes("block"),
    reorderRetryCrossesRotation: harness.commits.includes("reorder"),
    rejectedStaleWrites: results.filter((accepted) => !accepted).length
  };
}

console.log(JSON.stringify({
  vulnerable: runVulnerableScenario(),
  fixed: runFixedScenario()
}));
