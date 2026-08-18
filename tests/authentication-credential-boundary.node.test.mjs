import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("MFA credential changes rotate the authentication boundary atomically", async () => {
  const source = await read("src/routes/mfa.routes.ts");

  assert.match(source, /SELECT \* FROM users WHERE id = \? FOR UPDATE/);
  assert.match(source, /normalizeAuthVersion\(user\.auth_version\) !== expectedAuthVersion/);
  assert.match(source, /async function rotateAuthenticationCredentials/);
  assert.match(source, /UPDATE users SET auth_version = \? WHERE id = \?/);
  assert.match(source, /DELETE FROM mfa_login_sessions WHERE user_id = \?/);
  assert.match(source, /DELETE FROM webauthn_challenges WHERE user_id = \?/);
  assert.match(source, /DELETE FROM mfa_totp_setups WHERE user_id = \?/);
  assert.match(source, /function issueRotatedAuthenticationSession/);
  assert.match(source, /disconnectUserCollaborators\(user\.id, "Authentication credentials changed"\)/);
  assert.ok(
    (source.match(/issueRotatedAuthenticationSession\(res,/g) ?? []).length >= 4,
    "TOTP verification/removal and passkey registration/removal must issue a replacement cookie"
  );
  assert.match(source, /authVersion: expectedAuthVersion/);
  assert.match(source, /Number\(metadata\.authVersion\) !== expectedAuthVersion/);
});

test("current-password operations have an account-scoped throttle", async () => {
  const limiter = await read("src/middleware/auth-rate-limit.ts");
  const authRoutes = await read("src/routes/auth.routes.ts");
  const mfaRoutes = await read("src/routes/mfa.routes.ts");

  assert.match(limiter, /function accountReauthenticationKey/);
  assert.match(limiter, /hashRateLimitKey\("account-reauthentication", userId\)/);
  assert.match(limiter, /export const accountReauthenticationRateLimit = rateLimit/);
  assert.match(limiter, /windowMs: env\.AUTH_MFA_SETUP_WINDOW_MS/);
  assert.match(limiter, /limit: env\.AUTH_MFA_SETUP_MAX/);
  assert.match(authRoutes, /"\/password",\s+requireAuth,\s+accountReauthenticationRateLimit,/);
  assert.ok(
    (mfaRoutes.match(/accountReauthenticationRateLimit/g) ?? []).length >= 5,
    "all MFA operations that accept the current password must share the account limiter"
  );
});

test("password change and logout reject stale requests and clear pending authentication state", async () => {
  const source = await read("src/routes/auth.routes.ts");

  assert.match(source, /function assertAuthenticationVersion/);
  assert.ok(
    (source.match(/assertAuthenticationVersion\(user, expectedAuthVersion\)/g) ?? []).length >= 2,
    "password change and logout must revalidate auth_version under the user row lock"
  );
  assert.ok(
    (source.match(/DELETE FROM mfa_totp_setups WHERE user_id = \?/g) ?? []).length >= 2,
    "password change and logout must invalidate unfinished TOTP enrollment"
  );
});

test("the global limiter executes before request-body parsing", async () => {
  const source = await read("src/app.ts");
  const limiterIndex = source.indexOf("rateLimit({");
  const jsonParserIndex = source.indexOf("express.json({ limit: \"5mb\" })");
  const urlencodedParserIndex = source.indexOf("express.urlencoded({ extended: false })");

  assert.ok(limiterIndex >= 0, "global rate limiter is missing");
  assert.ok(limiterIndex < jsonParserIndex, "JSON parsing must not precede the global limiter");
  assert.ok(limiterIndex < urlencodedParserIndex, "form parsing must not precede the global limiter");
});

test("the browser fences responses started under the replaced cookie", async () => {
  const source = await read("public/app.js");

  assert.match(source, /function acceptRotatedAuthenticationSession\(\)/);
  assert.match(source, /authenticationSessionGeneration \+= 1/);
  assert.ok(
    (source.match(/acceptRotatedAuthenticationSession\(\);/g) ?? []).length >= 5,
    "password and MFA credential changes must accept the replacement cookie generation"
  );
});

test("destructive block actions stay bound to the initiating authentication generation", async () => {
  const source = await read("public/app.js");

  const directDeleteStart = source.indexOf("async function deleteBlockWithVersionCheck");
  const directDeleteEnd = source.indexOf("function updateBlockInState", directDeleteStart);
  const directDelete = source.slice(directDeleteStart, directDeleteEnd);
  assert.match(
    directDelete,
    /const authenticationScope = options\.authenticationScope \?\? captureAuthenticatedSessionScope\(\)/
  );

  const directCapture = directDelete.indexOf(
    "const authenticationScope = options.authenticationScope ?? captureAuthenticatedSessionScope()"
  );
  const collaborativeBranch = directDelete.indexOf("if (isCollaborativePage())");
  assert.ok(
    directCapture >= 0 && collaborativeBranch >= 0 && directCapture < collaborativeBranch,
    "collaborative block deletion must bind authentication before choosing the Yjs transport"
  );
  const collaborativeAction = directDelete.slice(
    collaborativeBranch,
    directDelete.indexOf("// A replacement block", collaborativeBranch)
  );
  const collaborativeTransition = collaborativeAction.indexOf("withCollaborativeDestructiveTransition");
  const collaborativePostWaitFence = collaborativeAction.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope))",
    collaborativeTransition
  );
  assert.ok(
    collaborativeTransition >= 0 && collaborativePostWaitFence > collaborativeTransition,
    "collaborative block deletion must revalidate authentication after destructive-transition waits"
  );

  const emptyDeleteStart = source.indexOf("async function deleteEmptyBlock");
  const emptyDeleteEnd = source.indexOf("function focusPendingBlock", emptyDeleteStart);
  const emptyDelete = source.slice(emptyDeleteStart, emptyDeleteEnd);
  const emptyCapture = emptyDelete.indexOf("const authenticationScope = captureAuthenticatedSessionScope()");
  const emptyLock = emptyDelete.indexOf("return withPageEditLock");
  const emptyDiscard = emptyDelete.indexOf("await discardBlockSave(blockId)");
  const emptyPostDiscardFence = emptyDelete.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return;",
    emptyDiscard
  );
  const emptyRequest = emptyDelete.indexOf("await deleteBlockWithVersionCheck", emptyDiscard);
  assert.ok(emptyCapture >= 0 && emptyCapture < emptyLock, "empty-block delete must bind auth before the edit-lock flush");
  assert.ok(
    emptyDiscard >= 0 && emptyDiscard < emptyPostDiscardFence && emptyPostDiscardFence < emptyRequest,
    "empty-block delete must revalidate auth after waiting for queued saves"
  );
  assert.match(emptyDelete, /preserveChildren: true,\s+authenticationScope/);

  const uploadStart = source.indexOf("async function uploadAttachmentFromRow");
  const uploadEnd = source.indexOf("function requestAttachmentUpload", uploadStart);
  const upload = source.slice(uploadStart, uploadEnd);
  const uploadDirectStart = upload.indexOf(
    "const shouldReplaceCurrentBlock = replaceCurrentBlock && currentEditRevision === sourceEditRevision;"
  );
  const uploadDirect = upload.slice(uploadDirectStart);
  const uploadDiscard = uploadDirect.indexOf("await discardBlockSave(blockId)");
  const uploadPostDiscardFence = uploadDirect.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;",
    uploadDiscard
  );
  const uploadDelete = uploadDirect.indexOf("await deleteBlockWithVersionCheck", uploadDiscard);
  const uploadPostDeleteFence = uploadDirect.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;",
    uploadPostDiscardFence + 1
  );
  assert.ok(
    uploadDiscard >= 0
      && uploadDiscard < uploadPostDiscardFence
      && uploadPostDiscardFence < uploadDelete
      && uploadDelete < uploadPostDeleteFence,
    "attachment replacement must not cross an auth rotation while settling or deleting its source block"
  );
  assert.match(uploadDirect, /includeDescendants: false,\s+authenticationScope/);

  const contextDeleteStart = source.indexOf('if (button.dataset.action === "delete-block")');
  const contextDeleteEnd = source.indexOf('document.addEventListener("visibilitychange"', contextDeleteStart);
  const contextDelete = source.slice(contextDeleteStart, contextDeleteEnd);
  const contextCapture = contextDelete.indexOf("const authenticationScope = captureAuthenticatedSessionScope()");
  const contextLock = contextDelete.indexOf("await withPageEditLock");
  const contextDiscard = contextDelete.indexOf("await discardBlockSave(blockId)");
  const contextPostDiscardFence = contextDelete.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return;",
    contextDiscard
  );
  const contextRequest = contextDelete.indexOf("await deleteBlockWithVersionCheck", contextDiscard);
  assert.ok(
    contextCapture >= 0 && contextCapture < contextLock,
    "context-menu delete must bind auth before the edit-lock flush"
  );
  assert.ok(
    contextDiscard >= 0 && contextDiscard < contextPostDiscardFence && contextPostDiscardFence < contextRequest,
    "context-menu delete must revalidate auth after waiting for queued saves"
  );
  assert.match(contextDelete, /await deleteBlockWithVersionCheck\(blockId, \{ authenticationScope \}\)/);
});

test("collaboration writes revalidate auth and session state at the durable transaction boundary", async () => {
  const server = await read("src/lib/collaboration-server.ts");
  const sessions = await read("src/lib/auth-sessions.ts");

  assert.match(
    server,
    /await assertCurrentCollaborationAuthentication\(client\);\s+const access = await getPageAccess\(room\.pageId, client\.user\.id\)/
  );

  const persistStart = server.indexOf("private async persistUpdate");
  const persistEnd = server.indexOf("private async handleMessage", persistStart);
  const persist = server.slice(persistStart, persistEnd >= 0 ? persistEnd : undefined);
  const transactionalAuthFence = persist.indexOf(
    "await assertCurrentCollaborationAuthentication(client, dbClient, { lock: true })"
  );
  const lockedPageAccess = persist.indexOf(
    "getPageAccess(room.pageId, client.user.id, dbClient, { lockPage: true })"
  );
  assert.ok(
    transactionalAuthFence >= 0
      && lockedPageAccess > transactionalAuthFence,
    "durable collaboration writes must lock the credential boundary before the page row"
  );

  assert.match(
    sessions,
    /\{ lock = false \}: \{ lock\?: boolean \} = \{\}/
  );
  assert.match(
    sessions,
    /\$\{lock \? "FOR UPDATE" : ""\}/
  );
});

test("standalone reproduction demonstrates vulnerable and remediated outcomes", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-authentication-credential-boundary.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

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
});

test("collaboration auth-rotation delete race reproduction is fenced at client and server", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-collaboration-auth-rotation-delete-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.collaborativeDeleteCrossesAuthRotation, true);
  assert.equal(result.vulnerable.staleSocketWritePersistsBeforePeriodicRecheck, true);
  assert.equal(result.fixed.clientFenceRejectsStaleDelete, true);
  assert.equal(result.fixed.serverWriteRejectsRevokedCredential, true);
});

