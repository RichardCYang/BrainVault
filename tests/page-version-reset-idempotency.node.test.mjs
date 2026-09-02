import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assessPageVersionResetMutationReceipt } from "../src/lib/page-version-reset-mutation.ts";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("page-version reset receipts distinguish new, replay, collision, and incomplete states", () => {
  assert.deepEqual(
    assessPageVersionResetMutationReceipt(null, { pageId: "pag_a", requestHash: "hash-a" }),
    { kind: "new" }
  );
  assert.deepEqual(
    assessPageVersionResetMutationReceipt(
      { page_id: "pag_a", request_hash: "hash-a", revision: 1, deleted_count: 3 },
      { pageId: "pag_a", requestHash: "hash-a" }
    ),
    { kind: "replay", revision: 1, deletedCount: 3 }
  );
  assert.deepEqual(
    assessPageVersionResetMutationReceipt(
      { page_id: "pag_b", request_hash: "hash-a", revision: 1, deleted_count: 3 },
      { pageId: "pag_a", requestHash: "hash-a" }
    ),
    { kind: "collision" }
  );
  assert.deepEqual(
    assessPageVersionResetMutationReceipt(
      { page_id: "pag_a", request_hash: "hash-b", revision: 1, deleted_count: 3 },
      { pageId: "pag_a", requestHash: "hash-a" }
    ),
    { kind: "collision" }
  );
  assert.deepEqual(
    assessPageVersionResetMutationReceipt(
      { page_id: "pag_a", request_hash: "hash-a", revision: null, deleted_count: null },
      { pageId: "pag_a", requestHash: "hash-a" }
    ),
    { kind: "incomplete" }
  );
});

test("DELETE /api/pages/:pageId/versions reserves and completes a receipt around the destructive reset", async () => {
  const [route, pageAccess] = await Promise.all([
    readFile(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/page-access.ts", import.meta.url), "utf8")
  ]).then((sources) => sources.map((source) => source.replace(/\r\n/g, "\n")));
  const resetRoute = section(
    route,
    'pageRouter.delete(\n  "/:pageId/versions",',
    'pageRouter.get(\n  "/:pageId/versions/:versionId",'
  );

  assert.match(resetRoute, /validate\(\{ params: idParamSchema, body: pageVersionResetSchema \}\)/);
  assert.match(route, /pageVersionResetSchema = z\.object\([\s\S]*expectedVersion: safeVersionSchema,[\s\S]*expectedContentVersion: safeVersionSchema,[\s\S]*expectedRevision:/);
  assert.match(resetRoute, /createMutationRequestHash\(\{[\s\S]*pageId,[\s\S]*expectedVersion,[\s\S]*expectedContentVersion,[\s\S]*expectedRevision[\s\S]*\}\)/);
  assert.match(resetRoute, /SELECT id FROM users WHERE id = \? FOR UPDATE/);
  assert.match(resetRoute, /getPageAccess\(pageId, user\.id, client, \{ lockPage: true \}\)/);
  assert.match(resetRoute, /const page = pageAccess\.page;\n\s*assertPageNotArchived\(page\);/);
  assert.match(pageAccess, /WHERE id = \?\$\{lockPage \? " FOR UPDATE" : ""\}/);
  assert.ok(
    resetRoute.indexOf("SELECT id FROM users WHERE id = ? FOR UPDATE")
      < resetRoute.indexOf("getPageAccess(pageId, user.id, client, { lockPage: true })"),
    "owner-scoped destructive operations must keep the global owner-before-page lock order"
  );
  assert.match(resetRoute, /INSERT INTO page_version_reset_mutations/);
  assert.match(resetRoute, /assessPageVersionResetMutationReceipt\(receipt, \{ pageId, requestHash \}\)/);
  assert.match(resetRoute, /MUTATION_ID_REUSED/);
  assert.match(resetRoute, /PAGE_VERSION_RESET_RECEIPT_INCOMPLETE/);
  assert.match(resetRoute, /UPDATE page_version_reset_mutations/);
  assert.match(resetRoute, /SELECT MAX\(revision\) AS revision FROM page_versions WHERE page_id = \?/);
  assert.match(resetRoute, /PAGE_VERSION_RESET_CONFLICT/);
  assert.ok(
    resetRoute.indexOf("INSERT INTO page_version_reset_mutations")
      < resetRoute.indexOf("resetPageVersionHistoryRecords"),
    "the receipt must be reserved before deleting history"
  );
  assert.ok(
    resetRoute.indexOf('assessment.kind !== "replay"')
      < resetRoute.indexOf("PAGE_VERSION_RESET_CONFLICT"),
    "a completed ambiguous retry must replay before stale-state checks"
  );
  assert.ok(
    resetRoute.indexOf("PAGE_VERSION_RESET_CONFLICT")
      < resetRoute.indexOf("resetPageVersionHistoryRecords"),
    "a stale first attempt must fail before history is deleted"
  );
  assert.ok(
    resetRoute.indexOf("resetPageVersionHistoryRecords")
      < resetRoute.indexOf("UPDATE page_version_reset_mutations"),
    "the committed reset result must complete the same receipt"
  );
});

test("fresh and upgraded databases keep page-version reset receipts across page recreation", async () => {
  const baseline = (await readFile(new URL("../migrations/001_init.sql", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const migration = (await readFile(
    new URL("../migrations/037_page_version_reset_mutation_receipts.sql", import.meta.url),
    "utf8"
  )).replace(/\r\n/g, "\n");
  const durableMigration = (await readFile(
    new URL("../migrations/059_mutation_receipts_survive_page_recreation.sql", import.meta.url),
    "utf8"
  )).replace(/\r\n/g, "\n");

  for (const source of [baseline, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS page_version_reset_mutations/);
    assert.match(source, /PRIMARY KEY \(owner_id, mutation_id\)/);
    assert.match(source, /revision BIGINT UNSIGNED NULL/);
    assert.match(source, /deleted_count BIGINT UNSIGNED NULL/);
    assert.match(source, /FOREIGN KEY \(owner_id\) REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.doesNotMatch(source, /fk_page_version_reset_mutations_page/);
  }
  assert.match(durableMigration, /DROP FOREIGN KEY fk_page_version_reset_mutations_page/);
});

test("browser retries ambiguous reset outcomes with the same task and fences stale authentication scopes", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const helpers = section(app, "function getPageVersionResetTaskKey", "function renderPageVersionHistoryList");
  const reset = section(app, "async function resetPageVersionHistory", "async function loadPageVersionDetail");
  const open = section(app, "function openPageVersionHistory", "function closePageVersionHistory");
  const authReset = section(app, "function resetAuthenticationSessionState", "function setAccountMessage");
  const credentialRotation = section(
    app,
    "function acceptRotatedAuthenticationSession",
    "function syncWorkspaceCreateControls"
  );
  const passwordRotation = section(
    app,
    'elements.accountPasswordForm.addEventListener("submit"',
    'elements.accountTotpSetup.addEventListener("click"'
  );

  assert.match(app, /const pendingPageVersionResetTasks = new Map\(\);/);
  assert.match(helpers, /mutationId: createMutationId\(\)/);
  assert.match(helpers, /expectedVersion,/);
  assert.match(helpers, /expectedContentVersion,/);
  assert.match(helpers, /expectedRevision,/);
  assert.match(helpers, /attempted: false,/);
  assert.match(helpers, /mutationId: task\.mutationId,[\s\S]*expectedVersion: task\.expectedVersion,[\s\S]*expectedContentVersion: task\.expectedContentVersion,[\s\S]*expectedRevision: task\.expectedRevision/);
  assert.match(helpers, /\{ requestGuard = null \} = \{\}/);
  assert.match(helpers, /beforeFetch: \(\) => \{/);
  assert.match(helpers, /requestGuard\?\.\(\) === false/);
  assert.match(helpers, /task\.attempted = true;/);
  assert.match(helpers, /data === skippedApiRequest/);
  assert.match(helpers, /attempt === 0 && isAmbiguousApiError\(error\)/);
  assert.doesNotMatch(helpers, /submitWithFreshMutationIdOnReuse/);
  assert.match(reset, /const navigationGeneration = workspaceNavigationGeneration;/);
  assert.match(reset, /const isResetIntentCurrent = \(\) =>/);
  assert.match(reset, /isCurrentWorkspaceNavigation\(navigationGeneration\)/);
  assert.match(reset, /getOrCreatePageVersionResetTask\(pageId, history\.current\)/);
  assert.match(reset, /requestGuard: isResetIntentCurrent/);
  assert.match(reset, /data === skippedApiRequest/);
  assert.match(reset, /!task\.attempted[\s\S]*pendingPageVersionResetTasks\.delete\(task\.taskKey\)/);
  assert.match(reset, /PAGE_VERSION_RESET_CONFLICT/);
  assert.match(reset, /PAGE_VERSION_RESET_CONFLICT[\s\S]*loadPageVersionHistory\(\)/);
  const successfulReset = section(reset, "try {", "} catch (error)");
  assert.match(
    successfulReset,
    /if \(!task\.attempted && pendingPageVersionResetTasks\.get\(task\.taskKey\) === task\) \{\s*pendingPageVersionResetTasks\.delete\(task\.taskKey\);/,
    "a stale task may be discarded only when beforeFetch proves no reset request was attempted"
  );
  assert.doesNotMatch(
    successfulReset,
    /if \(pendingPageVersionResetTasks\.get\(task\.taskKey\) === task\) \{\s*pendingPageVersionResetTasks\.delete\(task\.taskKey\);/,
    "an attempted reset must keep its receipt until post-response history refresh completes"
  );
  assert.match(reset, /isDefinitiveApiError\(error\)/);
  assert.match(reset, /isCurrentAuthenticatedSessionScope\(task\.scope\)/);
  assert.match(reset, /const currentTask = getCurrentPageVersionResetTask\(pageId\)/);
  assert.match(open, /Boolean\(getCurrentPageVersionResetTask\(page\.id\)\?\.inFlight\)/);
  assert.match(authReset, /pendingPageVersionResetTasks\.clear\(\);/);
  assert.match(credentialRotation, /pendingPageVersionResetTasks\.clear\(\);/);
  assert.match(passwordRotation, /acceptRotatedAuthenticationSession\(\);/);
});

test("page-version reset retry stops when authentication rotates after an ambiguous request", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const helperSource = section(
    app,
    "async function submitPageVersionResetTask",
    "function renderPageVersionHistoryList"
  );

  let authenticationCurrent = true;
  let apiCalls = 0;
  const api = async () => {
    apiCalls += 1;
    if (apiCalls === 1) {
      authenticationCurrent = false;
      const error = new Error("network");
      error.ambiguous = true;
      throw error;
    }
    return { reset: true };
  };
  const skippedApiRequest = Symbol("skipped-api-request");
  const factory = new Function(
    "api",
    "isAmbiguousApiError",
    "isCurrentAuthenticatedSessionScope",
    "skippedApiRequest",
    "t",
    `${helperSource}\nreturn submitPageVersionResetTask;`
  );
  const submit = factory(
    api,
    (error) => error?.ambiguous === true,
    () => authenticationCurrent,
    skippedApiRequest,
    () => "reset failed"
  );

  const result = await submit({
    pageId: "pag_auth_rotation",
    mutationId: "mut_auth_rotation",
    expectedVersion: 7,
    expectedContentVersion: 11,
    expectedRevision: 3,
    attempted: false,
    scope: { generation: 1, targetKey: "user:original" }
  });

  assert.equal(result, null);
  assert.equal(apiCalls, 1, "a stale authentication generation must not send the automatic destructive retry");
});

test("page-version reset is canceled if navigation changes during async request preparation", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const helperSource = section(
    app,
    "async function submitPageVersionResetTask",
    "function renderPageVersionHistoryList"
  );

  const skippedApiRequest = Symbol("skipped-api-request");
  let navigationCurrent = true;
  let sentRequests = 0;
  const api = async (_path, options) => {
    // Simulate async network-header preparation yielding to a newer navigation.
    navigationCurrent = false;
    if (options.beforeFetch?.() === false) return skippedApiRequest;
    sentRequests += 1;
    return { reset: true };
  };
  const factory = new Function(
    "api",
    "isAmbiguousApiError",
    "isCurrentAuthenticatedSessionScope",
    "skippedApiRequest",
    "t",
    `${helperSource}\nreturn submitPageVersionResetTask;`
  );
  const submit = factory(
    api,
    (error) => error?.ambiguous === true,
    () => true,
    skippedApiRequest,
    () => "reset failed"
  );

  const task = {
    pageId: "pag_navigation",
    mutationId: "mut_navigation",
    expectedVersion: 7,
    expectedContentVersion: 11,
    expectedRevision: 3,
    attempted: false,
    scope: { generation: 1, targetKey: "user:current" }
  };
  const result = await submit(task, { requestGuard: () => navigationCurrent });

  assert.equal(result, skippedApiRequest);
  assert.equal(sentRequests, 0, "a reset that became stale before fetch must not delete history");
  assert.equal(task.attempted, false);
});

test("page-version reset ambiguous retry does not cross a newer navigation", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const helperSource = section(
    app,
    "async function submitPageVersionResetTask",
    "function renderPageVersionHistoryList"
  );

  const skippedApiRequest = Symbol("skipped-api-request");
  let navigationCurrent = true;
  let sentRequests = 0;
  const api = async (_path, options) => {
    if (options.beforeFetch?.() === false) return skippedApiRequest;
    sentRequests += 1;
    navigationCurrent = false;
    const error = new Error("network");
    error.ambiguous = true;
    throw error;
  };
  const factory = new Function(
    "api",
    "isAmbiguousApiError",
    "isCurrentAuthenticatedSessionScope",
    "skippedApiRequest",
    "t",
    `${helperSource}\nreturn submitPageVersionResetTask;`
  );
  const submit = factory(
    api,
    (error) => error?.ambiguous === true,
    () => true,
    skippedApiRequest,
    () => "reset failed"
  );

  const task = {
    pageId: "pag_retry_navigation",
    mutationId: "mut_retry_navigation",
    expectedVersion: 7,
    expectedContentVersion: 11,
    expectedRevision: 3,
    attempted: false,
    scope: { generation: 1, targetKey: "user:current" }
  };
  const result = await submit(task, { requestGuard: () => navigationCurrent });

  assert.equal(result, skippedApiRequest);
  assert.equal(sentRequests, 1, "a stale navigation must suppress the automatic destructive retry");
  assert.equal(task.attempted, true, "the mutation receipt must be retained after an ambiguous send");
});

test("browser retires a reset task only after the post-reset history list is synchronized", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const reset = section(app, "async function resetPageVersionHistory", "async function loadPageVersionDetail");

  assert.match(reset, /let synchronized = false;/);
  assert.doesNotMatch(reset, /completed = true/);
  assert.match(
    reset,
    /if \(loaded && isCurrentAuthenticatedSessionScope\(task\.scope\) && pageId === history\.pageId\) \{\s+synchronized = true;/
  );
  assert.match(
    reset,
    /if \(synchronized && pendingPageVersionResetTasks\.get\(task\.taskKey\) === task\) \{\s+pendingPageVersionResetTasks\.delete\(task\.taskKey\);/
  );
  assert.ok(
    reset.indexOf("synchronized = true") < reset.indexOf("if (synchronized && pendingPageVersionResetTasks.get"),
    "the task may be retired only after a successful, current-scope history refresh"
  );
});

test("standalone reproduction proves that a lost reset response used to erase later history", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-version-reset-retry-loss.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.responseLossFollowedByRetryDeletedNewHistory, true);
  assert.equal(result.fixed.replayReturnedOriginalResult, true);
  assert.equal(result.fixed.responseLossFollowedByRetryPreservedNewHistory, true);
  assert.equal(result.fixed.mutationCollisionRejected, true);
  assert.equal(result.refreshGap.vulnerable.reusedOriginalMutationId, false);
  assert.equal(result.refreshGap.vulnerable.replayedOriginalReset, false);
  assert.equal(result.refreshGap.vulnerable.preservedLaterHistory, false);
  assert.equal(result.refreshGap.fixed.reusedOriginalMutationId, true);
  assert.equal(result.refreshGap.fixed.replayedOriginalReset, true);
  assert.equal(result.refreshGap.fixed.preservedLaterHistory, true);
  assert.equal(result.concurrentEdit.vulnerableDeletedUnseenHistory, true);
  assert.equal(result.concurrentEdit.fixedRejectedStaleReset, true);
  assert.equal(result.concurrentEdit.fixedPreservedUnseenHistory, true);
});
