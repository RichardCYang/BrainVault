// Deterministic model of the stale-auth collaboration delete race.
//
// The real browser path waits for save/collaboration durability before applying
// a destructive Yjs mutation. Credential rotation can happen during that wait.
// The vulnerable ordering selected the collaboration branch before checking the
// captured authentication generation, while the server only rechecked a stale
// socket periodically. The remediated paths fence both boundaries.

async function vulnerableClientDelete() {
  let authGeneration = 1;
  const capturedGeneration = authGeneration;
  let deletePersisted = false;

  // The destructive transition waits before invoking the mutation callback.
  await Promise.resolve();
  authGeneration += 1;

  // Vulnerable behavior: collaborative branch bypassed the generation check.
  void capturedGeneration;
  deletePersisted = true;
  return deletePersisted;
}

async function fixedClientDelete() {
  let authGeneration = 1;
  const capturedGeneration = authGeneration;
  let deletePersisted = false;

  await Promise.resolve();
  authGeneration += 1;

  if (capturedGeneration !== authGeneration) return deletePersisted;
  deletePersisted = true;
  return deletePersisted;
}

function vulnerableServerWrite({ socketAuthVersion, currentAuthVersion, sessionActive }) {
  // Vulnerable behavior: the durable write relied on a periodic credential
  // recheck and only revalidated page access on the state-changing frame.
  void socketAuthVersion;
  void currentAuthVersion;
  void sessionActive;
  return true;
}

function fixedServerWrite({ socketAuthVersion, currentAuthVersion, sessionActive }) {
  return socketAuthVersion === currentAuthVersion && sessionActive;
}

const staleCredential = {
  socketAuthVersion: 7,
  currentAuthVersion: 8,
  sessionActive: false
};

const result = {
  vulnerable: {
    collaborativeDeleteCrossesAuthRotation: await vulnerableClientDelete(),
    staleSocketWritePersistsBeforePeriodicRecheck: vulnerableServerWrite(staleCredential)
  },
  fixed: {
    clientFenceRejectsStaleDelete: !(await fixedClientDelete()),
    serverWriteRejectsRevokedCredential: !fixedServerWrite(staleCredential)
  }
};

console.log(JSON.stringify(result, null, 2));
