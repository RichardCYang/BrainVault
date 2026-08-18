function vulnerableMutationAfterMiddleware(authState, requestScope) {
  if (requestScope.authVersion < 1 || !requestScope.sessionId) throw new Error("bad request scope");
  authState.noteMutations += 1;
  return "committed";
}

function fixedMutationAtTransactionBoundary(authState, requestScope) {
  if (
    authState.authVersion !== requestScope.authVersion
    || !authState.activeSessions.has(requestScope.sessionId)
  ) {
    return "rejected";
  }
  authState.noteMutations += 1;
  return "committed";
}

function authVersionRotationScenario() {
  const requestScope = { authVersion: 7, sessionId: "session-a" };

  const vulnerable = { authVersion: 7, activeSessions: new Set(["session-a"]), noteMutations: 0 };
  vulnerable.authVersion = 8; // Password/MFA rotation commits after middleware authentication.
  const vulnerableOutcome = vulnerableMutationAfterMiddleware(vulnerable, requestScope);

  const fixed = { authVersion: 7, activeSessions: new Set(["session-a"]), noteMutations: 0 };
  fixed.authVersion = 8;
  const fixedOutcome = fixedMutationAtTransactionBoundary(fixed, requestScope);

  return {
    vulnerableOutcome,
    vulnerableMutations: vulnerable.noteMutations,
    fixedOutcome,
    fixedMutations: fixed.noteMutations
  };
}

function sessionRevocationScenario() {
  const requestScope = { authVersion: 11, sessionId: "session-b" };

  const vulnerable = { authVersion: 11, activeSessions: new Set(["session-b"]), noteMutations: 0 };
  vulnerable.activeSessions.delete("session-b"); // Device-session revocation races after middleware authentication.
  const vulnerableOutcome = vulnerableMutationAfterMiddleware(vulnerable, requestScope);

  const fixed = { authVersion: 11, activeSessions: new Set(["session-b"]), noteMutations: 0 };
  fixed.activeSessions.delete("session-b");
  const fixedOutcome = fixedMutationAtTransactionBoundary(fixed, requestScope);

  return {
    vulnerableOutcome,
    vulnerableMutations: vulnerable.noteMutations,
    fixedOutcome,
    fixedMutations: fixed.noteMutations
  };
}

const versionRotation = authVersionRotationScenario();
const sessionRevocation = sessionRevocationScenario();

if (
  versionRotation.vulnerableOutcome !== "committed"
  || versionRotation.vulnerableMutations !== 1
  || versionRotation.fixedOutcome !== "rejected"
  || versionRotation.fixedMutations !== 0
  || sessionRevocation.vulnerableOutcome !== "committed"
  || sessionRevocation.vulnerableMutations !== 1
  || sessionRevocation.fixedOutcome !== "rejected"
  || sessionRevocation.fixedMutations !== 0
) {
  throw new Error("Authentication-boundary race reproduction did not match expectations");
}

console.log(JSON.stringify({ versionRotation, sessionRevocation }, null, 2));
