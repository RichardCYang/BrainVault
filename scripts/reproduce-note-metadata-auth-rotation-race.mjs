function createHarness() {
  let generation = 1;
  const commits = [];

  function captureScope() {
    return Object.freeze({ generation, targetKey: "user-1" });
  }

  function isCurrent(scope) {
    return Boolean(scope && scope.generation === generation && scope.targetKey === "user-1");
  }

  function rotateCredentials() {
    generation += 1;
  }

  function vulnerableDeferredMutation(kind) {
    // Vulnerable paths captured authentication only when they finally reached api().
    const lateScope = captureScope();
    if (isCurrent(lateScope)) commits.push(kind);
  }

  function fixedDeferredMutation(kind, initiatingScope) {
    if (!isCurrent(initiatingScope)) return false;
    commits.push(kind);
    return true;
  }

  return { captureScope, rotateCredentials, vulnerableDeferredMutation, fixedDeferredMutation, commits };
}

function runVulnerableScenario() {
  const harness = createHarness();
  // These user actions begin under generation 1, then pause for edit-lock draining
  // or local image decoding/validation before any network request is constructed.
  harness.captureScope();
  harness.captureScope();
  harness.captureScope();

  harness.rotateCredentials();

  harness.vulnerableDeferredMutation("page-icon");
  harness.vulnerableDeferredMutation("page-cover");
  harness.vulnerableDeferredMutation("custom-icon-upload");

  return {
    pageIconCrossesRotation: harness.commits.includes("page-icon"),
    pageCoverCrossesRotation: harness.commits.includes("page-cover"),
    customIconUploadCrossesRotation: harness.commits.includes("custom-icon-upload")
  };
}

function runFixedScenario() {
  const harness = createHarness();
  const iconScope = harness.captureScope();
  const coverScope = harness.captureScope();
  const uploadScope = harness.captureScope();

  harness.rotateCredentials();

  const accepted = [
    harness.fixedDeferredMutation("page-icon", iconScope),
    harness.fixedDeferredMutation("page-cover", coverScope),
    harness.fixedDeferredMutation("custom-icon-upload", uploadScope)
  ];

  return {
    pageIconCrossesRotation: harness.commits.includes("page-icon"),
    pageCoverCrossesRotation: harness.commits.includes("page-cover"),
    customIconUploadCrossesRotation: harness.commits.includes("custom-icon-upload"),
    rejectedStaleMutations: accepted.filter((value) => !value).length
  };
}

console.log(JSON.stringify({
  vulnerable: runVulnerableScenario(),
  fixed: runFixedScenario()
}));
