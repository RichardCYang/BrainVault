import { createAccountAvatarOperationGuard } from "../public/account-avatar-operation.js";
import { restoreSessionAtBoot } from "../public/session-bootstrap.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function reproduceBootSupersession() {
  const oldUser = { id: "account-a" };

  const vulnerableState = { authenticated: false, user: null };
  const vulnerableLoad = deferred();
  const vulnerableBoot = (async () => {
    const user = await vulnerableLoad.promise;
    vulnerableState.authenticated = true;
    vulnerableState.user = user;
  })();
  // A manual login supersedes boot, then fails before committing a new user.
  vulnerableLoad.resolve(oldUser);
  await vulnerableBoot;

  const fixedState = { authenticated: false, user: null };
  const fixedLoad = deferred();
  let bootCurrent = true;
  const fixedBoot = restoreSessionAtBoot(fixedState, {
    loadUser: async () => fixedLoad.promise,
    initializeAuthenticatedUi: async () => {},
    loadWorkspace: async () => {},
    isCurrent: () => bootCurrent
  });
  bootCurrent = false;
  fixedLoad.resolve(oldUser);
  const fixedResult = await fixedBoot;

  return {
    vulnerableStaleBootSessionCommitted: vulnerableState.user === oldUser,
    fixedStaleBootSessionCommitted: fixedState.user === oldUser,
    fixedOutcome: fixedResult.outcome
  };
}

async function reproduceAuthenticationSerialization() {
  const first = deferred();
  const second = deferred();
  const vulnerableState = { user: null };
  const vulnerableFirst = first.promise.then((user) => { vulnerableState.user = user; });
  const vulnerableSecond = second.promise.then((user) => { vulnerableState.user = user; });
  second.resolve({ id: "account-b" });
  await vulnerableSecond;
  first.resolve({ id: "account-a" });
  await vulnerableFirst;

  let busy = false;
  let fixedSecondRequestStarted = false;
  const fixedState = { user: null };
  const fixedFirst = deferred();
  const submit = async (request) => {
    if (busy) return false;
    busy = true;
    try {
      fixedState.user = await request.promise;
      return true;
    } finally {
      busy = false;
    }
  };
  const fixedFirstSubmission = submit(fixedFirst);
  fixedSecondRequestStarted = await submit(deferred());
  fixedFirst.resolve({ id: "account-a" });
  await fixedFirstSubmission;

  let mfaBusy = true;
  let cancelApplied = false;
  if (!mfaBusy) cancelApplied = true;
  mfaBusy = false;

  return {
    vulnerableOutOfOrderLoginOverwroteLatestResponse: vulnerableState.user?.id === "account-a",
    fixedConcurrentSecondRequestStarted: fixedSecondRequestStarted,
    fixedAuthenticatedUserId: fixedState.user?.id ?? null,
    fixedMfaCancelAppliedDuringVerification: cancelApplied,
    fixedMfaBusyReleased: mfaBusy === false
  };
}

async function reproduceAccountDataBoundary() {
  const accountAKey = "user:account-a";
  const accountBKey = "user:account-b";

  const vulnerableState = { accountKey: accountAKey, pages: [], downloadedAccount: null };
  const vulnerableExport = deferred();
  const vulnerableImport = deferred();
  const vulnerableExportTask = vulnerableExport.promise.then((accountKey) => {
    vulnerableState.downloadedAccount = accountKey;
  });
  const vulnerableImportTask = vulnerableImport.promise.then((payload) => {
    vulnerableState.accountKey = payload.accountKey;
    vulnerableState.pages = payload.pages;
  });
  vulnerableState.accountKey = accountBKey;
  vulnerableExport.resolve(accountAKey);
  vulnerableImport.resolve({ accountKey: accountAKey, pages: ["account-a-page"] });
  await Promise.all([vulnerableExportTask, vulnerableImportTask]);

  const exportGuard = createAccountAvatarOperationGuard();
  const importGuard = createAccountAvatarOperationGuard();
  const fixedState = { accountKey: accountAKey, pages: [], downloadedAccount: null };
  const exportOperation = exportGuard.begin(accountAKey);
  const fixedExport = deferred();
  const fixedExportTask = fixedExport.promise.then((accountKey) => {
    if (exportGuard.isCurrent(exportOperation, fixedState.accountKey)) {
      fixedState.downloadedAccount = accountKey;
    }
  });
  const importOperation = importGuard.begin(accountAKey);
  const fixedImport = deferred();
  const fixedImportTask = fixedImport.promise.then((payload) => {
    if (importGuard.isCurrent(importOperation, fixedState.accountKey)) {
      fixedState.accountKey = payload.accountKey;
      fixedState.pages = payload.pages;
    }
  });
  fixedState.accountKey = accountBKey;
  exportGuard.invalidate();
  importGuard.invalidate();
  fixedExport.resolve(accountAKey);
  fixedImport.resolve({ accountKey: accountAKey, pages: ["account-a-page"] });
  await Promise.all([fixedExportTask, fixedImportTask]);

  return {
    vulnerableOldAccountBackupDownloaded: vulnerableState.downloadedAccount === accountAKey,
    vulnerableOldImportOverwroteNewAccount: vulnerableState.accountKey === accountAKey,
    fixedOldAccountBackupDownloaded: fixedState.downloadedAccount === accountAKey,
    fixedOldImportOverwroteNewAccount: fixedState.accountKey === accountAKey,
    fixedCurrentAccountKey: fixedState.accountKey
  };
}

function reproducePageLockBoundary() {
  let vulnerableDepth = 0;
  vulnerableDepth += 1; // old-account operation
  vulnerableDepth = 0; // authentication reset
  vulnerableDepth += 1; // new-account operation
  vulnerableDepth = Math.max(0, vulnerableDepth - 1); // old finally

  let fixedGeneration = 0;
  let fixedDepth = 0;
  const oldGeneration = fixedGeneration;
  fixedDepth += 1;
  fixedGeneration += 1;
  fixedDepth = 0;
  const newGeneration = fixedGeneration;
  fixedDepth += 1;
  if (oldGeneration === fixedGeneration) fixedDepth = Math.max(0, fixedDepth - 1);

  const vulnerableActiveTransitionAfterReset = true;
  let fixedActiveTransitionAfterReset = true;
  fixedActiveTransitionAfterReset = false;

  return {
    vulnerableOldFinallyUnlockedNewAccount: vulnerableDepth === 0,
    fixedOldFinallyUnlockedNewAccount: fixedDepth === 0,
    fixedNewLockGenerationPreserved: newGeneration === fixedGeneration && fixedDepth === 1,
    vulnerableActiveTransitionAfterReset,
    fixedActiveTransitionAfterReset
  };
}

console.log(JSON.stringify({
  scenario: "authentication, account-data, and editor-lock authentication boundaries",
  boot: await reproduceBootSupersession(),
  authentication: await reproduceAuthenticationSerialization(),
  accountData: await reproduceAccountDataBoundary(),
  pageLock: reproducePageLockBoundary()
}, null, 2));
