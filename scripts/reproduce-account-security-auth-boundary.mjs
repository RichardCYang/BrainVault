import { createAccountAvatarOperationGuard } from "../public/account-avatar-operation.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function reproduceVulnerable() {
  const state = {
    accountId: "account-a",
    settingsOpen: true,
    loginHistory: [{ ipAddress: "203.0.113.10" }],
    mfaStatus: { totpEnabled: true, passkeys: [{ id: "passkey-a", name: "Account A laptop" }] },
    totpSecret: null
  };

  const oldHistory = deferred();
  const oldMfa = deferred();
  const oldTotpSetup = deferred();
  const newHistory = deferred();
  const newMfa = deferred();

  const applyHistory = async (request) => {
    state.loginHistory = await request.promise;
  };
  const applyMfa = async (request) => {
    state.mfaStatus = await request.promise;
  };
  const applyTotpSetup = async (request) => {
    state.totpSecret = (await request.promise).secret;
  };

  const oldOperations = [
    applyHistory(oldHistory),
    applyMfa(oldMfa),
    applyTotpSetup(oldTotpSetup)
  ];

  state.settingsOpen = false;
  state.accountId = "account-b";
  state.settingsOpen = true;
  const retainedPasskeyVisibleToNewAccount = state.mfaStatus.passkeys[0]?.name === "Account A laptop";
  const retainedLoginAttemptVisibleToNewAccount = state.loginHistory[0]?.ipAddress === "203.0.113.10";

  const newOperations = [applyHistory(newHistory), applyMfa(newMfa)];
  newHistory.resolve([{ ipAddress: "198.51.100.20" }]);
  newMfa.resolve({ totpEnabled: false, passkeys: [{ id: "passkey-b", name: "Account B phone" }] });
  await Promise.all(newOperations);

  oldHistory.resolve([{ ipAddress: "203.0.113.99" }]);
  oldMfa.resolve({ totpEnabled: true, passkeys: [{ id: "passkey-a2", name: "Account A security key" }] });
  oldTotpSetup.resolve({ secret: "ACCOUNT-A-TOTP-SECRET" });
  await Promise.all(oldOperations);

  return {
    retainedPasskeyVisibleToNewAccount,
    retainedLoginAttemptVisibleToNewAccount,
    staleMfaResponseOverwroteNewAccount: state.mfaStatus.passkeys[0]?.name === "Account A security key",
    staleLoginHistoryOverwroteNewAccount: state.loginHistory[0]?.ipAddress === "203.0.113.99",
    staleTotpSecretVisibleToNewAccount: state.totpSecret === "ACCOUNT-A-TOTP-SECRET"
  };
}

async function reproduceFixed() {
  const historyGuard = createAccountAvatarOperationGuard();
  const mfaGuard = createAccountAvatarOperationGuard();
  const totpGuard = createAccountAvatarOperationGuard();
  const state = {
    accountId: "account-a",
    settingsOpen: true,
    loginHistory: [{ ipAddress: "203.0.113.10" }],
    mfaStatus: { totpEnabled: true, passkeys: [{ id: "passkey-a", name: "Account A laptop" }] },
    totpSecret: null
  };
  const targetKey = () => state.accountId ? `user:${state.accountId}` : null;
  const isCurrent = (guard, operation) => state.settingsOpen && guard.isCurrent(operation, targetKey());

  const oldHistory = deferred();
  const oldMfa = deferred();
  const oldTotpSetup = deferred();
  const newHistory = deferred();
  const newMfa = deferred();

  const applyHistory = async (request, operation) => {
    const value = await request.promise;
    if (isCurrent(historyGuard, operation)) state.loginHistory = value;
  };
  const applyMfa = async (request, operation) => {
    const value = await request.promise;
    if (isCurrent(mfaGuard, operation)) state.mfaStatus = value;
  };
  const applyTotpSetup = async (request, operation) => {
    const value = await request.promise;
    if (isCurrent(totpGuard, operation)) state.totpSecret = value.secret;
  };

  const oldOperations = [
    applyHistory(oldHistory, historyGuard.begin(targetKey())),
    applyMfa(oldMfa, mfaGuard.begin(targetKey())),
    applyTotpSetup(oldTotpSetup, totpGuard.begin(targetKey()))
  ];

  state.settingsOpen = false;
  historyGuard.invalidate();
  mfaGuard.invalidate();
  totpGuard.invalidate();
  state.loginHistory = [];
  state.mfaStatus = { totpEnabled: false, passkeys: [] };
  state.totpSecret = null;
  state.accountId = "account-b";
  state.settingsOpen = true;

  const clearedPasskeysBeforeNewLoad = state.mfaStatus.passkeys.length === 0;
  const clearedLoginHistoryBeforeNewLoad = state.loginHistory.length === 0;

  const newOperations = [
    applyHistory(newHistory, historyGuard.begin(targetKey())),
    applyMfa(newMfa, mfaGuard.begin(targetKey()))
  ];
  newHistory.resolve([{ ipAddress: "198.51.100.20" }]);
  newMfa.resolve({ totpEnabled: false, passkeys: [{ id: "passkey-b", name: "Account B phone" }] });
  await Promise.all(newOperations);

  oldHistory.resolve([{ ipAddress: "203.0.113.99" }]);
  oldMfa.resolve({ totpEnabled: true, passkeys: [{ id: "passkey-a2", name: "Account A security key" }] });
  oldTotpSetup.resolve({ secret: "ACCOUNT-A-TOTP-SECRET" });
  await Promise.all(oldOperations);

  return {
    clearedPasskeysBeforeNewLoad,
    clearedLoginHistoryBeforeNewLoad,
    newAccountMfaPreserved: state.mfaStatus.passkeys[0]?.name === "Account B phone",
    newAccountLoginHistoryPreserved: state.loginHistory[0]?.ipAddress === "198.51.100.20",
    staleTotpSecretSuppressed: state.totpSecret === null
  };
}

console.log(JSON.stringify({
  vulnerable: await reproduceVulnerable(),
  fixed: await reproduceFixed()
}, null, 2));
