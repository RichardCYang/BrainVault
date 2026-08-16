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

test("authentication requests and authenticated shell initialization are generation scoped", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

  assert.match(app, /const authFlowOperationGuard = createAccountAvatarOperationGuard\(\);/);
  assert.match(app, /const authenticatedSessionOperationGuard = createAccountAvatarOperationGuard\(\);/);
  assert.match(app, /authOperationBusy: false/);

  const controls = section(app, "function syncAuthOperationControls", "function isCurrentAccountDataOperation");
  assert.match(controls, /elements\.authSubmit\.disabled = busy;/);
  assert.match(controls, /elements\.mfaLoginCancel\.disabled = busy;/);
  assert.match(controls, /elements\.authSwitchLink\.setAttribute\("aria-disabled", String\(busy\)\);/);

  const completion = section(app, "async function completeAuthenticatedLogin", "async function logout");
  assert.match(completion, /authenticatedSessionOperationGuard\.begin\(targetKey\)/);
  assert.match(completion, /fetchAllPageSummaries\(\)/);
  assert.match(completion, /if \(!isCurrentAuthenticatedSessionOperation\(operation\)\) return \{ outcome: "superseded" \};/);
  assert.doesNotMatch(completion, /await loadPages\(\)/);

  const handlers = section(
    app,
    'elements.mfaLoginTotpForm.addEventListener("submit"',
    "function refreshLocalizedUi"
  );
  assert.match(handlers, /if \(state\.authOperationBusy\) return;/);
  assert.match(handlers, /const operation = beginAuthFlowOperation\(\);/);
  assert.match(handlers, /if \(state\.authOperationBusy\) return;\n  authFlowOperationGuard\.invalidate\(\);\n  resetMfaLogin/);

  const authForm = section(app, 'elements.authForm.addEventListener("submit"', "boot();");
  assert.match(authForm, /if \(state\.authOperationBusy\) return;/);
  assert.match(authForm, /setAuthOperationBusy\(true\);/);
  assert.match(authForm, /if \(!isCurrentAuthFlowOperation\(operation\)\) return;/);
});

test("backup transfer responses remain bound to the account that started them", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(app, /const accountDataOperationGuard = createAccountAvatarOperationGuard\(\);/);
  assert.match(app, /accountDataOperationBusy: false/);

  const transfer = section(app, "async function downloadUserDataBackup", "function renderShell");
  assert.match(transfer, /accountDataOperationGuard\.begin\(targetKey\)/);
  assert.match(transfer, /if \(!isCurrentAccountDataOperation\(activeOperation\)\) return \{ applied: false \};/);
  assert.match(transfer, /getAccountAvatarTargetKey\(data\?\.user\) !== targetKey/);
  assert.match(transfer, /const pages = await fetchAllPageSummaries\(\);/);
  assert.doesNotMatch(transfer, /await loadPages\("", ""\)/);

  const reset = section(app, "function resetAuthenticationSessionState", "function setAccountMessage");
  assert.match(reset, /accountDataOperationGuard\.invalidate\(\);/);
  assert.match(reset, /closeAccountSettings\(\{ restoreFocus: false, force: true \}\);/);
  assert.match(reset, /state\.accountDataOperationBusy = false;/);
});

test("old page-edit and transition finalizers cannot unlock a new authentication generation", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(app, /let pageEditLockGeneration = 0;/);

  const lock = section(app, "function lockPageEdits", "async function withPagePersistenceTransition");
  assert.match(lock, /const generation = pageEditLockGeneration;/);
  assert.match(lock, /if \(generation !== pageEditLockGeneration\) return;/);
  assert.match(lock, /unlockPageEdits\(lockGeneration\);/);

  const reset = section(app, "function resetAuthenticationSessionState", "function setAccountMessage");
  assert.match(reset, /pageEditLockGeneration \+= 1;/);
  assert.match(reset, /pageTransitionLock\.release\(activePageTransitionLease\);/);
  assert.match(reset, /activePageTransitionLease = null;/);
});

test("standalone reproduction proves the vulnerable ordering and the fixed boundaries", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-auth-data-lock-boundary-races.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.boot.vulnerableStaleBootSessionCommitted, true);
  assert.equal(result.boot.fixedStaleBootSessionCommitted, false);
  assert.equal(result.boot.fixedOutcome, "superseded");
  assert.equal(result.authentication.vulnerableOutOfOrderLoginOverwroteLatestResponse, true);
  assert.equal(result.authentication.fixedConcurrentSecondRequestStarted, false);
  assert.equal(result.authentication.fixedMfaCancelAppliedDuringVerification, false);
  assert.equal(result.accountData.vulnerableOldAccountBackupDownloaded, true);
  assert.equal(result.accountData.vulnerableOldImportOverwroteNewAccount, true);
  assert.equal(result.accountData.fixedOldAccountBackupDownloaded, false);
  assert.equal(result.accountData.fixedOldImportOverwroteNewAccount, false);
  assert.equal(result.accountData.fixedCurrentAccountKey, "user:account-b");
  assert.equal(result.pageLock.vulnerableOldFinallyUnlockedNewAccount, true);
  assert.equal(result.pageLock.fixedOldFinallyUnlockedNewAccount, false);
  assert.equal(result.pageLock.fixedNewLockGenerationPreserved, true);
  assert.equal(result.pageLock.vulnerableActiveTransitionAfterReset, true);
  assert.equal(result.pageLock.fixedActiveTransitionAfterReset, false);
});
