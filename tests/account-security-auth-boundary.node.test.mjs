import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("account security data and mutations are isolated across authentication boundaries", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

  assert.match(app, /const accountSecurityOperationGuards = Object\.freeze\(\{/);
  assert.match(app, /resetAccountSecurityOperationState\(\{ clearSensitiveState: true \}\);/);
  assert.match(app, /state\.mfaStatus = \{ totpEnabled: false, passkeys: \[\] \};/);
  assert.match(app, /state\.blockHistory = \{ months: blockMonths, blocks: \[\], truncated: false, loading: false, loadedMonths: null \};/);
  assert.match(app, /state\.countryLoginPolicy = \{[\s\S]*?mode: "OFF",[\s\S]*?countries: \[\],[\s\S]*?loaded: false[\s\S]*?\};/);
  assert.match(app, /accountPasskeyRegistering: false/);
  assert.match(app, /function setAccountPasskeyRegistering\(registering\)/);

  const reset = section(app, "function resetAuthenticationSessionState", "function setAccountMessage");
  assert.match(reset, /closePageVersionHistory\(\{ restoreFocus: false \}\);/);
  assert.match(reset, /closePageCoverDialog\(\);/);
  assert.match(reset, /resetAccountSecurityOperationState\(\{ clearSensitiveState: true \}\);/);

  const history = section(app, "async function loadLoginHistory", "function loadActiveSecurityPanel");
  assert.match(history, /loginHistory\.begin\(targetKey\)/);
  assert.match(history, /if \(!isCurrentAccountSecurityOperation\(accountSecurityOperationGuards\.loginHistory, operation\)\) return;/);
  assert.match(history, /blockHistory\.begin\(targetKey\)/);
  assert.match(history, /countryPolicy\.begin\(targetKey\)/);

  const mfa = section(app, "async function loadMfaSettings", "function setSearchDialogMessage");
  assert.match(mfa, /mfaStatus\.begin\(targetKey\)/);
  assert.match(mfa, /if \(!isCurrentAccountSecurityOperation\(accountSecurityOperationGuards\.mfaStatus, operation\)\) return;/);

  const handlers = section(
    app,
    'elements.accountPasswordForm.addEventListener("submit"',
    'elements.mfaLoginTotpForm.addEventListener("submit"'
  );
  assert.match(handlers, /password\.begin\(targetKey\)/);
  assert.match(handlers, /totpSetup\.begin\(targetKey\)/);
  assert.match(handlers, /passkeyRegister\.begin\(targetKey\)/);
  assert.match(handlers, /if \(!isCurrentAccountSecurityOperation\(accountSecurityOperationGuards\.passkeyRegister, operation\)\) return;[\s\S]*?createWebAuthnCredential/);
  assert.match(handlers, /createWebAuthnCredential[\s\S]*?if \(!isCurrentAccountSecurityOperation\(accountSecurityOperationGuards\.passkeyRegister, operation\)\) return;[\s\S]*?challengeToken/);
});

test("standalone reproduction proves sensitive state leakage and stale-response suppression", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-account-security-auth-boundary.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.retainedPasskeyVisibleToNewAccount, true);
  assert.equal(result.vulnerable.retainedLoginAttemptVisibleToNewAccount, true);
  assert.equal(result.vulnerable.staleMfaResponseOverwroteNewAccount, true);
  assert.equal(result.vulnerable.staleLoginHistoryOverwroteNewAccount, true);
  assert.equal(result.vulnerable.staleTotpSecretVisibleToNewAccount, true);
  assert.equal(result.fixed.clearedPasskeysBeforeNewLoad, true);
  assert.equal(result.fixed.clearedLoginHistoryBeforeNewLoad, true);
  assert.equal(result.fixed.newAccountMfaPreserved, true);
  assert.equal(result.fixed.newAccountLoginHistoryPreserved, true);
  assert.equal(result.fixed.staleTotpSecretSuppressed, true);
});
