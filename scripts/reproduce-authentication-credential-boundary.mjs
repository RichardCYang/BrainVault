import assert from "node:assert/strict";

function sessionIsValid(session, account) {
  return session.authVersion === account.authVersion;
}

function reproduceUnrotatedMfaCredentialChange() {
  const account = { authVersion: 7, passkeys: [] };
  const settingsSession = { authVersion: 7 };
  const stolenSession = { authVersion: 7 };

  // Vulnerable behavior: the factor is added without changing auth_version.
  account.passkeys.push("attacker-controlled-passkey");

  return {
    factorWasAdded: account.passkeys.length === 1,
    settingsSessionRemainsValid: sessionIsValid(settingsSession, account),
    stolenSessionSurvivesFactorChange: sessionIsValid(stolenSession, account)
  };
}

function reproduceRotatedMfaCredentialChange() {
  const account = { authVersion: 7, passkeys: [] };
  const settingsSession = { authVersion: 7 };
  const stolenSession = { authVersion: 7 };

  // Fixed behavior: factor persistence and session rotation happen in one transaction.
  account.passkeys.push("new-passkey");
  account.authVersion += 1;
  const replacementSession = { ...settingsSession, authVersion: account.authVersion };

  return {
    factorWasAdded: account.passkeys.length === 1,
    replacementSessionIsValid: sessionIsValid(replacementSession, account),
    stolenSessionSurvivesFactorChange: sessionIsValid(stolenSession, account)
  };
}

function reproducePasswordOnlyLoginRace({ fixed }) {
  const account = { authVersion: 9, totpEnabled: false };
  const loginDecision = { authVersion: account.authVersion, mfaRequired: account.totpEnabled };

  // Enrollment commits after the login flow has already observed "no MFA".
  account.totpEnabled = true;
  if (fixed) account.authVersion += 1;

  const passwordOnlySession = { authVersion: loginDecision.authVersion };
  return {
    loginObservedMfa: loginDecision.mfaRequired,
    passwordOnlySessionSurvivesEnrollment: sessionIsValid(passwordOnlySession, account)
  };
}

function reproduceStaleCredentialCommit({ fixed }) {
  const account = { authVersion: 11, passkeys: [], pendingTotpSetups: ["setup-token"] };
  const staleRequest = { expectedAuthVersion: 11, verifiedCurrentPassword: true };

  // A concurrent password change establishes a new authentication boundary.
  account.authVersion += 1;
  if (fixed) account.pendingTotpSetups = [];

  let stalePasskeyCommitRejected = false;
  if (fixed && staleRequest.expectedAuthVersion !== account.authVersion) {
    stalePasskeyCommitRejected = true;
  } else if (staleRequest.verifiedCurrentPassword) {
    account.passkeys.push("stale-request-passkey");
  }

  return {
    stalePasskeyCommitRejected,
    stalePasskeyWasCommitted: account.passkeys.includes("stale-request-passkey"),
    staleTotpSetupSurvivedPasswordChange: account.pendingTotpSetups.length > 0
  };
}

function reproduceDistributedPasswordOracle({ fixed, addressCount, attemptsPerAddress, accountLimit }) {
  const totalAttempts = addressCount * attemptsPerAddress;
  return fixed ? Math.min(totalAttempts, accountLimit) : totalAttempts;
}

function reproduceBodyParsingBeforeGlobalLimit({ fixed, rejectedRequests, bodyBytes }) {
  return fixed ? 0 : rejectedRequests * bodyBytes;
}

const addressCount = 12;
const attemptsPerAddress = 120;
const accountLimit = 10;
const rejectedRequests = 25;
const bodyBytes = 5 * 1024 * 1024;

const vulnerableFactorChange = reproduceUnrotatedMfaCredentialChange();
const fixedFactorChange = reproduceRotatedMfaCredentialChange();
const vulnerableRace = reproduceStaleCredentialCommit({ fixed: false });
const fixedRace = reproduceStaleCredentialCommit({ fixed: true });
const vulnerableLoginRace = reproducePasswordOnlyLoginRace({ fixed: false });
const fixedLoginRace = reproducePasswordOnlyLoginRace({ fixed: true });

const result = {
  scenario: "Authentication credential boundary, reauthentication throttling, and pre-parser request limiting",
  vulnerable: {
    stolenSessionSurvivesFactorChange: vulnerableFactorChange.stolenSessionSurvivesFactorChange,
    passwordOnlyLoginSurvivesMfaEnrollment: vulnerableLoginRace.passwordOnlySessionSurvivesEnrollment,
    stalePasskeyCommitCrossesPasswordChange: vulnerableRace.stalePasskeyWasCommitted,
    staleTotpSetupSurvivesPasswordChange: vulnerableRace.staleTotpSetupSurvivedPasswordChange,
    distributedCurrentPasswordAttempts: reproduceDistributedPasswordOracle({
      fixed: false,
      addressCount,
      attemptsPerAddress,
      accountLimit
    }),
    rejectedBodyBytesParsedBeforeRateLimit: reproduceBodyParsingBeforeGlobalLimit({
      fixed: false,
      rejectedRequests,
      bodyBytes
    })
  },
  fixed: {
    stolenSessionSurvivesFactorChange: fixedFactorChange.stolenSessionSurvivesFactorChange,
    replacementSessionIsValid: fixedFactorChange.replacementSessionIsValid,
    passwordOnlyLoginSurvivesMfaEnrollment: fixedLoginRace.passwordOnlySessionSurvivesEnrollment,
    stalePasskeyCommitRejected: fixedRace.stalePasskeyCommitRejected,
    stalePasskeyCommitCrossesPasswordChange: fixedRace.stalePasskeyWasCommitted,
    staleTotpSetupSurvivesPasswordChange: fixedRace.staleTotpSetupSurvivedPasswordChange,
    accountScopedCurrentPasswordAttempts: reproduceDistributedPasswordOracle({
      fixed: true,
      addressCount,
      attemptsPerAddress,
      accountLimit
    }),
    rejectedBodyBytesParsedBeforeRateLimit: reproduceBodyParsingBeforeGlobalLimit({
      fixed: true,
      rejectedRequests,
      bodyBytes
    })
  }
};

assert.equal(result.vulnerable.stolenSessionSurvivesFactorChange, true);
assert.equal(result.fixed.stolenSessionSurvivesFactorChange, false);
assert.equal(result.fixed.replacementSessionIsValid, true);
assert.equal(result.vulnerable.passwordOnlyLoginSurvivesMfaEnrollment, true);
assert.equal(result.fixed.passwordOnlyLoginSurvivesMfaEnrollment, false);
assert.equal(result.vulnerable.stalePasskeyCommitCrossesPasswordChange, true);
assert.equal(result.fixed.stalePasskeyCommitRejected, true);
assert.equal(result.fixed.stalePasskeyCommitCrossesPasswordChange, false);
assert.equal(result.vulnerable.staleTotpSetupSurvivesPasswordChange, true);
assert.equal(result.fixed.staleTotpSetupSurvivesPasswordChange, false);
assert.equal(result.vulnerable.distributedCurrentPasswordAttempts, 1_440);
assert.equal(result.fixed.accountScopedCurrentPasswordAttempts, 10);
assert.equal(result.vulnerable.rejectedBodyBytesParsedBeforeRateLimit, 131_072_000);
assert.equal(result.fixed.rejectedBodyBytesParsedBeforeRateLimit, 0);

console.log(JSON.stringify(result, null, 2));
