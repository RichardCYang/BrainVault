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

test("credential rotation cancels account-data work before stale restores can resume", async () => {
  const source = await read("public/app.js");

  const rotationStart = source.indexOf("function acceptRotatedAuthenticationSession()");
  const rotationEnd = source.indexOf("function syncWorkspaceCreateControls", rotationStart);
  const rotation = source.slice(rotationStart, rotationEnd);
  const generationAdvance = rotation.indexOf("authenticationSessionGeneration += 1");
  const dataOperationInvalidation = rotation.indexOf("accountDataOperationGuard.invalidate()");
  const replacementSessionAcceptance = rotation.indexOf("setAuthenticated(true)");
  assert.ok(
    generationAdvance >= 0
      && dataOperationInvalidation > generationAdvance
      && replacementSessionAcceptance > dataOperationInvalidation,
    "credential rotation must invalidate pending account-data work before accepting the replacement session"
  );

  for (const [name, startMarker, endMarker, requestMarker] of [
    [
      "backup restore",
      "async function restoreUserDataBackup",
      "function formatSnapshotSize",
      'api("/api/data/import", { method: "POST", body: formData })'
    ],
    [
      "snapshot restore",
      "async function restoreWorkspaceSnapshotClient",
      "function getUserInitials",
      'api(`/api/snapshots/${encodeURIComponent(snapshotId)}/restore`, { method: "POST" })'
    ]
  ]) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    const operation = source.slice(start, end);
    const wait = operation.indexOf("await fetchOwnedWorkspacePageIds()");
    const postWaitFence = operation.indexOf("if (!isCurrentAccountDataOperation(activeOperation))", wait);
    const request = operation.indexOf(requestMarker, postWaitFence);
    assert.ok(
      start >= 0 && end > start && wait >= 0 && postWaitFence > wait && request > postWaitFence,
      `${name} must recheck the invalidatable operation guard after its workspace wait and before the destructive request`
    );
  }
});

test("authenticated API requests revalidate auth scope around async network preparation", async () => {
  const source = await read("public/app.js");
  const apiStart = source.indexOf("async function api(path, options = {})");
  const apiEnd = source.indexOf("function enqueueAccountProfilePatch", apiStart);
  const apiSource = source.slice(apiStart, apiEnd);

  assert.ok(apiStart >= 0 && apiEnd > apiStart, "shared api helper is missing");
  assert.match(apiSource, /const authenticationScope = captureAuthenticatedSessionScope\(\)/);
  assert.match(apiSource, /const startedAuthenticated = Boolean\(state\.authenticated && authenticationScope\.targetKey\)/);

  const headerAwait = apiSource.indexOf("await applyClientNetworkVerificationHeaders(headers)");
  const preFetchFence = apiSource.indexOf(
    "if (startedAuthenticated && !isCurrentAuthenticatedSessionScope(authenticationScope))",
    headerAwait
  );
  const fetchCall = apiSource.indexOf("response = await fetch(path", preFetchFence);
  const postFetchFence = apiSource.indexOf(
    "if (startedAuthenticated && !isCurrentAuthenticatedSessionScope(authenticationScope))",
    preFetchFence + 1
  );
  const firstResponseUse = apiSource.indexOf("if (response.status === 204)", postFetchFence);

  assert.ok(
    headerAwait >= 0 && headerAwait < preFetchFence && preFetchFence < fetchCall,
    "an authenticated request must not reach fetch after its initiating auth generation changes during network-signal preparation"
  );
  assert.ok(
    fetchCall >= 0 && fetchCall < postFetchFence && postFetchFence < firstResponseUse,
    "a response from an obsolete auth generation must not be applied to the replacement session"
  );
});

test("share mutations stay bound to the initiating authentication generation across persistence waits", async () => {
  const source = await read("public/app.js");

  const addStart = source.indexOf('elements.sharePageForm.addEventListener("submit"');
  const addEnd = source.indexOf('elements.sharePageList.addEventListener("click"', addStart);
  const addSource = source.slice(addStart, addEnd);
  const addScope = addSource.indexOf("const authenticationScope = captureAuthenticatedSessionScope()");
  const addFlush = addSource.indexOf("await flushPendingPageEdits({ allowLocked: true })");
  const addPostWaitFence = addSource.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;",
    addFlush
  );
  const addRequest = addSource.indexOf("/shares`, {", addPostWaitFence);
  assert.ok(
    addScope >= 0 && addFlush > addScope && addPostWaitFence > addFlush && addRequest > addPostWaitFence,
    "share creation must revalidate the initiating auth generation after draft draining and before the request"
  );

  const removeStart = addEnd;
  const removeEnd = source.indexOf('document.addEventListener("keydown"', removeStart);
  const removeSource = source.slice(removeStart, removeEnd);
  const removeScope = removeSource.indexOf("const authenticationScope = captureAuthenticatedSessionScope()");
  const removeFlush = removeSource.indexOf(
    "await flushPendingPageEdits({ allowLocked: true, collaborationCompact: false })"
  );
  const removePostWaitFence = removeSource.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;",
    removeFlush
  );
  const collaborationDestroy = removeSource.indexOf("await destroyPageCollaboration", removePostWaitFence);
  const removePostDestroyFence = removeSource.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;",
    collaborationDestroy
  );
  const removeRequest = removeSource.indexOf('{ method: "DELETE", body: { expectedGeneration } }', removePostDestroyFence);
  assert.ok(
    removeScope >= 0
      && removeFlush > removeScope
      && removePostWaitFence > removeFlush
      && collaborationDestroy > removePostWaitFence
      && removePostDestroyFence > collaborationDestroy
      && removeRequest > removePostDestroyFence,
    "share removal must revalidate auth after draft draining and collaboration teardown before deleting access"
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

test("direct note saves and reorder retries stay bound to the edit's authentication generation", async () => {
  const source = await read("public/app.js");

  const titleQueueStart = source.indexOf("const pageTitleSaveQueue = createLatestWriteQueue");
  const titleQueueEnd = source.indexOf("async function downloadAttachment", titleQueueStart);
  const titleQueue = source.slice(titleQueueStart, titleQueueEnd);
  assert.match(titleQueue, /assertCurrentAuthenticatedSessionScope\(task\.authenticationScope\)/);
  assert.ok(
    (titleQueue.match(/assertCurrentAuthenticatedSessionScope\(task\.authenticationScope\)/g) ?? []).length >= 3,
    "title saves must fence queue start, every request attempt, and response application"
  );

  const titleSaveStart = source.indexOf("async function savePageTitleNow");
  const titleSaveEnd = source.indexOf("function schedulePageTitleSave", titleSaveStart);
  const titleSave = source.slice(titleSaveStart, titleSaveEnd);
  assert.match(
    titleSave,
    /authenticationScope = pageTitleEditAuthenticationScope \?\? captureAuthenticatedSessionScope\(\)/
  );
  assert.match(titleSave, /authenticationScope,\s+mutationId: createMutationId\(\)/);

  const titleScheduleStart = titleSaveEnd;
  const titleScheduleEnd = source.indexOf("function normalizeRecoveredBlockPayload", titleScheduleStart);
  const titleSchedule = source.slice(titleScheduleStart, titleScheduleEnd);
  assert.match(titleSchedule, /pageTitleEditAuthenticationScope = authenticationScope/);
  assert.match(titleSchedule, /savePageTitleNow\(\{ authenticationScope \}\)/);

  const blockDirtyStart = source.indexOf("function markBlockDirty");
  const blockQueueStart = source.indexOf("function getBlockSaveQueue", blockDirtyStart);
  const blockDirty = source.slice(blockDirtyStart, blockQueueStart);
  assert.match(blockDirty, /const authenticationScope = captureAuthenticatedSessionScope\(\)/);
  assert.match(blockDirty, /blockEditAuthenticationScopes\.set\(blockId, authenticationScope\)/);

  const blockSaveStart = source.indexOf("async function saveBlockRow", blockQueueStart);
  const blockQueue = source.slice(blockQueueStart, blockSaveStart);
  assert.ok(
    (blockQueue.match(/assertCurrentAuthenticatedSessionScope\(task\.authenticationScope\)/g) ?? []).length >= 3,
    "block saves must fence queue start, every request attempt, and response application"
  );

  const blockScheduleStart = source.indexOf("function scheduleBlockSave", blockSaveStart);
  const blockSave = source.slice(blockSaveStart, blockScheduleStart);
  assert.match(blockSave, /blockEditAuthenticationScopes\.get\(blockId\)/);
  assert.match(blockSave, /assertCurrentAuthenticatedSessionScope\(authenticationScope\)/);
  assert.match(blockSave, /authenticationScope,\s+mutationId: createMutationId\(\)/);

  const blockScheduleEnd = source.indexOf("function getTextareaSelection", blockScheduleStart);
  const blockSchedule = source.slice(blockScheduleStart, blockScheduleEnd);
  assert.match(blockSchedule, /saveBlockRow\(row, \{ quiet: true, authenticationScope \}\)/);

  const orderTaskStart = source.indexOf("function createBlockOrderTask");
  const orderTaskEnd = source.indexOf("function persistBlockOrderDraft", orderTaskStart);
  const orderTask = source.slice(orderTaskStart, orderTaskEnd);
  assert.match(orderTask, /authenticationScope = captureAuthenticatedSessionScope\(\)/);
  assert.match(orderTask, /assertCurrentAuthenticatedSessionScope\(authenticationScope\)/);
  assert.match(orderTask, /recoveredOrigin,\s+authenticationScope/);

  const orderSubmitStart = source.indexOf("async function submitBlockOrderTask", orderTaskEnd);
  const orderSubmitEnd = source.indexOf("async function requireBlockOrderRecoveryDurability", orderSubmitStart);
  const orderSubmit = source.slice(orderSubmitStart, orderSubmitEnd);
  assert.ok(
    (orderSubmit.match(/assertCurrentAuthenticatedSessionScope\(task\.authenticationScope\)/g) ?? []).length >= 2,
    "reorder requests must fence both dispatch and response application"
  );

  const dragStart = source.indexOf("async function finishBlockDrag");
  const dragEnd = source.indexOf("function setRowType", dragStart);
  const drag = source.slice(dragStart, dragEnd);
  const dragCapture = drag.indexOf("const authenticationScope = captureAuthenticatedSessionScope()");
  const editLock = drag.indexOf("return withPageEditLock", dragCapture);
  const postLockFence = drag.indexOf("if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return;", editLock);
  assert.ok(
    dragCapture >= 0 && editLock > dragCapture && postLockFence > editLock,
    "drag reorders must bind auth before queued-save draining and revalidate after that wait"
  );
});

test("authenticated API responses revalidate auth scope after streaming the response body", async () => {
  const source = await read("public/app.js");
  const apiStart = source.indexOf("async function api(path, options = {})");
  const apiEnd = source.indexOf("function enqueueAccountProfilePatch", apiStart);
  const apiSource = source.slice(apiStart, apiEnd);

  const responseText = apiSource.indexOf("const text = await response.text()");
  const postBodyFence = apiSource.indexOf(
    "if (startedAuthenticated && !isCurrentAuthenticatedSessionScope(authenticationScope))",
    responseText
  );
  const parseStart = apiSource.indexOf("data = text ? JSON.parse(text) : null", postBodyFence);
  assert.ok(
    responseText >= 0 && postBodyFence > responseText && parseStart > postBodyFence,
    "a credential rotation while the response body is streaming must be rejected before stale data is parsed/applied"
  );
});

test("standalone note-save auth-rotation reproduction rejects delayed stale writes", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-note-save-auth-rotation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.delayedTitleCrossesRotation, true);
  assert.equal(result.vulnerable.queuedBlockSaveCrossesRotation, true);
  assert.equal(result.vulnerable.reorderRetryCrossesRotation, true);
  assert.equal(result.fixed.delayedTitleCrossesRotation, false);
  assert.equal(result.fixed.queuedBlockSaveCrossesRotation, false);
  assert.equal(result.fixed.reorderRetryCrossesRotation, false);
  assert.equal(result.fixed.rejectedStaleWrites, 3);
});

test("note metadata mutations stay bound to the initiating authentication generation", async () => {
  const source = await read("public/app.js");

  const emojiStart = source.indexOf("async function saveEmojiSelection");
  const emojiEnd = source.indexOf("function positionEmojiPicker", emojiStart);
  const emoji = source.slice(emojiStart, emojiEnd);
  assert.match(
    emoji,
    /\{ operation = null, authenticationScope = captureAuthenticatedSessionScope\(\) \} = \{\}/
  );
  const pageEmojiStart = emoji.indexOf("const savePageEmoji = async () =>");
  const pageEmojiRequest = emoji.indexOf('api(`/api/pages/${target.pageId}`', pageEmojiStart);
  const pageEmojiPreFence = emoji.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;",
    pageEmojiStart
  );
  const pageEmojiPostFence = emoji.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;",
    pageEmojiRequest
  );
  assert.ok(
    pageEmojiStart >= 0
      && pageEmojiPreFence > pageEmojiStart
      && pageEmojiRequest > pageEmojiPreFence
      && pageEmojiPostFence > pageEmojiRequest,
    "page icon writes must revalidate the initiating auth scope before dispatch and response application"
  );

  const coverStart = source.indexOf("async function persistPageCover");
  const coverEnd = source.indexOf("function loadCustomCoverImage", coverStart);
  const cover = source.slice(coverStart, coverEnd);
  assert.match(
    cover,
    /\{ operation = null, authenticationScope = captureAuthenticatedSessionScope\(\) \} = \{\}/
  );
  const coverLock = cover.indexOf("await withPageEditLock");
  const coverFence = cover.indexOf("!isCurrentAuthenticatedSessionScope(authenticationScope)", coverLock);
  const coverRetry = cover.indexOf("submitWithFreshMutationIdOnReuse", coverFence);
  const retryFence = cover.indexOf("if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;", coverRetry);
  const coverRequest = cover.indexOf('api(`/api/pages/${pageId}`', retryFence);
  const coverPostFence = cover.indexOf(
    "if (data === null || !isCurrentAuthenticatedSessionScope(authenticationScope)) return;",
    coverRequest
  );
  assert.ok(
    coverLock >= 0
      && coverFence > coverLock
      && coverRetry > coverFence
      && retryFence > coverRetry
      && coverRequest > retryFence
      && coverPostFence > coverRequest,
    "page cover writes must not cross auth rotation while draining edits or retrying a mutation"
  );

  const coverInputStart = source.indexOf('elements.pageCoverCustomInput.addEventListener("change"');
  const coverInputEnd = source.indexOf('elements.pageCoverRemoveButton.addEventListener("click"', coverInputStart);
  const coverInput = source.slice(coverInputStart, coverInputEnd);
  const coverCapture = coverInput.indexOf("const authenticationScope = captureAuthenticatedSessionScope()");
  const coverPrepare = coverInput.indexOf("await prepareCustomCoverDataUrl(file)");
  const coverPostPrepare = coverInput.indexOf(
    "!isCurrentAuthenticatedSessionScope(authenticationScope)",
    coverPrepare
  );
  assert.ok(
    coverCapture >= 0 && coverPrepare > coverCapture && coverPostPrepare > coverPrepare,
    "custom cover preprocessing must preserve the credential generation from the file-selection event"
  );
  assert.match(coverInput, /\{ operation, authenticationScope \}/);

  const uploadStart = source.indexOf("async function uploadCustomIconFile");
  const uploadEnd = source.indexOf("function positionEmojiPicker", uploadStart);
  const upload = source.slice(uploadStart, uploadEnd);
  assert.match(upload, /authenticationScope = captureAuthenticatedSessionScope\(\)/);
  assert.ok(
    (upload.match(/isCurrentAuthenticatedSessionScope\(authenticationScope\)/g) ?? []).length >= 2,
    "custom icon upload must fence both request dispatch and response application"
  );

  const fileStart = source.indexOf("async function applyCustomIconFile");
  const fileEnd = source.indexOf('elements.emojiPickerClose.addEventListener', fileStart);
  const fileHandler = source.slice(fileStart, fileEnd);
  const fileCapture = fileHandler.indexOf("const authenticationScope = captureAuthenticatedSessionScope()");
  const fileValidation = fileHandler.indexOf("await validateCustomIconFileContents(file)");
  const filePostValidationFence = fileHandler.indexOf(
    "!isCurrentAuthenticatedSessionScope(authenticationScope)",
    fileValidation
  );
  const fileUpload = fileHandler.indexOf("await uploadCustomIconFile(file, { authenticationScope })", filePostValidationFence);
  assert.ok(
    fileCapture >= 0
      && fileValidation > fileCapture
      && filePostValidationFence > fileValidation
      && fileUpload > filePostValidationFence,
    "custom icon file validation must not allow a stale user action to adopt a replacement credential"
  );
  assert.match(fileHandler, /saveEmojiSelection\(value, \{ operation, authenticationScope \}\)/);
});

test("standalone metadata auth-rotation reproduction rejects stale delayed mutations", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-note-metadata-auth-rotation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.pageIconCrossesRotation, true);
  assert.equal(result.vulnerable.pageCoverCrossesRotation, true);
  assert.equal(result.vulnerable.customIconUploadCrossesRotation, true);
  assert.equal(result.fixed.pageIconCrossesRotation, false);
  assert.equal(result.fixed.pageCoverCrossesRotation, false);
  assert.equal(result.fixed.customIconUploadCrossesRotation, false);
  assert.equal(result.fixed.rejectedStaleMutations, 3);
});

test("custom icon mutations revalidate authentication inside the storage transaction", async () => {
  const route = await read("src/routes/custom-icon.routes.ts");
  const library = await read("src/lib/custom-icons.ts");

  assert.match(route, /import \{ assertCurrentAuthSessionBoundary \} from "\.\.\/lib\/auth-sessions\.js"/);
  assert.match(route, /import \{ requireAuth, requireRequestAuthScope \} from "\.\.\/middleware\/auth\.js"/);
  assert.equal(
    (route.match(/const authScope = requireRequestAuthScope\(req\);/g) ?? []).length,
    4,
    "every custom-icon write route must bind the request authentication scope"
  );
  assert.equal(
    (route.match(/beforeMutation: \(client\) => assertCurrentAuthSessionBoundary\(user\.id, authScope, client\)/g) ?? []).length,
    4,
    "every custom-icon write route must carry the auth scope to its durable transaction"
  );

  for (const [name, endMarker] of [
    ["removeCustomIconFromLibrary", "export async function restoreCustomIconToLibrary"],
    ["restoreCustomIconToLibrary", "export async function rememberCustomIconPaths"],
    ["rememberCustomIconPaths", "export async function storeCustomIcon"],
    ["storeCustomIcon", null]
  ]) {
    const start = library.indexOf(`export async function ${name}`);
    const end = endMarker ? library.indexOf(endMarker, start) : library.length;
    const operation = library.slice(start, end);
    const lock = operation.indexOf("withUserAttachmentLock");
    const authFence = operation.indexOf("await beforeMutation?.(client)", lock);
    const firstDurableMutation = Math.min(
      ...["await client.execute(", "await writeFile("]
        .map((marker) => operation.indexOf(marker, authFence))
        .filter((index) => index >= 0)
    );
    assert.ok(
      start >= 0 && lock >= 0 && authFence > lock && firstDurableMutation > authFence,
      `${name} must revalidate credentials after acquiring the user lock and before durable mutation`
    );
  }
});

test("block move response application stays fenced to the initiating authentication generation", async () => {
  const source = await read("public/app.js");

  const submitStart = source.indexOf("async function submitBlockMoveTask");
  const moveStart = source.indexOf("async function moveBlockToPage", submitStart);
  const deleteStart = source.indexOf("async function deleteBlockWithVersionCheck", moveStart);
  assert.ok(submitStart >= 0 && moveStart > submitStart && deleteStart > moveStart);

  const submit = source.slice(submitStart, moveStart);
  const move = source.slice(moveStart, deleteStart);

  const submitResponseIndex = submit.indexOf("const data = await submitWithFreshMutationIdOnReuse");
  const submitFenceIndex = submit.indexOf(
    "if (data === null || !isCurrentAuthenticatedSessionScope(authenticationScope)) return null;",
    submitResponseIndex
  );
  const submitTaskCleanupIndex = submit.indexOf("pendingBlockMoveTasks.delete", submitResponseIndex);
  assert.ok(
    submitResponseIndex >= 0
      && submitFenceIndex > submitResponseIndex
      && submitTaskCleanupIndex > submitFenceIndex,
    "a completed block-move response must be rejected after auth rotation before its retry task is acknowledged"
  );

  const moveResponseIndex = move.indexOf("const data = await submitBlockMoveTask(task, scope);");
  const moveFenceIndex = move.indexOf(
    "if (data === null || !isCurrentAuthenticatedSessionScope(scope)) return null;",
    moveResponseIndex
  );
  const localCleanupIndex = move.indexOf("pageDraftStore.removeBlocks", moveResponseIndex);
  assert.ok(
    moveResponseIndex >= 0 && moveFenceIndex > moveResponseIndex && localCleanupIndex > moveFenceIndex,
    "the initiating auth generation must be revalidated before moved-block recovery drafts are removed"
  );

  async function reproduce({ fixed }) {
    let currentAuthenticationScope = true;
    let localDraftPresent = true;
    const response = { movedBlockIds: ["blk_1"] };

    // The API response can pass its own boundary check and then yield. A
    // credential-rotation continuation may run before the caller applies the
    // response or removes local recovery state.
    await Promise.resolve();
    currentAuthenticationScope = false;

    if (fixed) {
      if (response === null || !currentAuthenticationScope) {
        return { localDraftPresent, responseApplied: false };
      }
    } else if (response === null && !currentAuthenticationScope) {
      return { localDraftPresent, responseApplied: false };
    }

    localDraftPresent = false;
    return { localDraftPresent, responseApplied: true };
  }

  assert.deepEqual(
    await reproduce({ fixed: false }),
    { localDraftPresent: false, responseApplied: true },
    "the old conjunction permits a stale successful JSON response to erase local recovery state"
  );
  assert.deepEqual(
    await reproduce({ fixed: true }),
    { localDraftPresent: true, responseApplied: false },
    "the fixed disjunction rejects the stale response and preserves local recovery state"
  );
});
