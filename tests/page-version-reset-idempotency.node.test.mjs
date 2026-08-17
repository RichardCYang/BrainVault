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
  const route = (await readFile(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const resetRoute = section(
    route,
    'pageRouter.delete(\n  "/:pageId/versions",',
    'pageRouter.get(\n  "/:pageId/versions/:versionId",'
  );

  assert.match(resetRoute, /validate\(\{ params: idParamSchema, body: pageVersionResetSchema \}\)/);
  assert.match(resetRoute, /createMutationRequestHash\(\{ pageId \}\)/);
  assert.match(resetRoute, /SELECT id FROM users WHERE id = \? FOR UPDATE/);
  assert.ok(
    resetRoute.indexOf("SELECT id FROM users WHERE id = ? FOR UPDATE")
      < resetRoute.indexOf("SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE"),
    "owner-scoped destructive operations must keep the global owner-before-page lock order"
  );
  assert.match(resetRoute, /INSERT INTO page_version_reset_mutations/);
  assert.match(resetRoute, /assessPageVersionResetMutationReceipt\(receipt, \{ pageId, requestHash \}\)/);
  assert.match(resetRoute, /MUTATION_ID_REUSED/);
  assert.match(resetRoute, /PAGE_VERSION_RESET_RECEIPT_INCOMPLETE/);
  assert.match(resetRoute, /UPDATE page_version_reset_mutations/);
  assert.ok(
    resetRoute.indexOf("INSERT INTO page_version_reset_mutations")
      < resetRoute.indexOf("resetPageVersionHistoryRecords"),
    "the receipt must be reserved before deleting history"
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
  assert.match(helpers, /body: \{ mutationId: task\.mutationId \}/);
  assert.match(helpers, /attempt === 0 && isAmbiguousApiError\(error\)/);
  assert.doesNotMatch(helpers, /submitWithFreshMutationIdOnReuse/);
  assert.match(reset, /getOrCreatePageVersionResetTask\(pageId\)/);
  const successfulReset = section(reset, "try {", "} catch (error)");
  assert.doesNotMatch(
    successfulReset,
    /pendingPageVersionResetTasks\.delete/,
    "a committed reset task must remain visible until post-response history refresh completes"
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
  const factory = new Function(
    "api",
    "isAmbiguousApiError",
    "isCurrentAuthenticatedSessionScope",
    "t",
    `${helperSource}\nreturn submitPageVersionResetTask;`
  );
  const submit = factory(
    api,
    (error) => error?.ambiguous === true,
    () => authenticationCurrent,
    () => "reset failed"
  );

  const result = await submit({
    pageId: "pag_auth_rotation",
    mutationId: "mut_auth_rotation",
    scope: { generation: 1, targetKey: "user:original" }
  });

  assert.equal(result, null);
  assert.equal(apiCalls, 1, "a stale authentication generation must not send the automatic destructive retry");
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
});
