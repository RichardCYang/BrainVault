// Models a request admitted before its exact device session is revoked.
// Dependency-free by design: this demonstrates the security boundary semantics directly.

function vulnerableFlow() {
  const state = { authVersion: 7, sessionActive: true, credentialChanged: false, replacementSessionIssued: false };
  const admitted = { authVersion: state.authVersion, sessionId: "session-a" };

  // Another authenticated device revokes session-a while this request is stalled.
  state.sessionActive = false;

  // Historical account-security routes rechecked only the account-wide auth version.
  if (state.authVersion !== admitted.authVersion) return state;
  state.credentialChanged = true;
  state.authVersion += 1;
  state.replacementSessionIssued = true;
  return state;
}

function fixedFlow() {
  const state = { authVersion: 7, sessionActive: true, credentialChanged: false, replacementSessionIssued: false };
  const admitted = { authVersion: state.authVersion, sessionId: "session-a" };

  state.sessionActive = false;

  // The durable boundary checks both the account auth version and the exact device session.
  if (state.authVersion !== admitted.authVersion || !state.sessionActive) return state;
  state.credentialChanged = true;
  state.authVersion += 1;
  state.replacementSessionIssued = true;
  return state;
}

console.log(JSON.stringify({ vulnerable: vulnerableFlow(), fixed: fixedFlow() }, null, 2));
