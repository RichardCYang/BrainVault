const request = {
  authVersion: 7,
  sessionId: "ses-old"
};

function vulnerableRestore() {
  const account = { authVersion: 7 };
  const sessions = new Map([[request.sessionId, { authVersion: 7, revoked: false }]]);

  // Request passed middleware and begins expensive ZIP validation/staging.
  const admitted = account.authVersion === request.authVersion
    && sessions.get(request.sessionId)?.revoked === false;

  // Before the durable restore transaction, the same session is explicitly revoked.
  sessions.get(request.sessionId).revoked = true;

  // Vulnerable implementation carries only userId into the restore engine,
  // so no credential/session predicate is checked before replacing page rows.
  const destructiveImportRan = admitted;
  return { admitted, destructiveImportRan };
}

function fixedRestore() {
  const account = { authVersion: 7 };
  const sessions = new Map([[request.sessionId, { authVersion: 7, revoked: false }]]);

  const admitted = account.authVersion === request.authVersion
    && sessions.get(request.sessionId)?.revoked === false;

  sessions.get(request.sessionId).revoked = true;

  const session = sessions.get(request.sessionId);
  const durableAuthValid = account.authVersion === request.authVersion
    && session?.authVersion === request.authVersion
    && session.revoked === false;

  const destructiveImportRan = admitted && durableAuthValid;
  return { admitted, durableAuthValid, destructiveImportRan };
}

console.log(JSON.stringify({
  vulnerable: vulnerableRestore(),
  fixed: fixedRestore()
}));
