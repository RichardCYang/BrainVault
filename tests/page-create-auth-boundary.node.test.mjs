import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assessPageCreateMutationReceipt } from "../src/lib/page-create-mutation.ts";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("page creation receipts distinguish new requests, valid replays, and key reuse", () => {
  assert.deepEqual(assessPageCreateMutationReceipt(null, "hash-a"), { kind: "new" });
  assert.deepEqual(
    assessPageCreateMutationReceipt({ page_id: "page-a", request_hash: "hash-a" }, "hash-a"),
    { kind: "replay", pageId: "page-a" }
  );

  assert.deepEqual(
    assessPageCreateMutationReceipt({ page_id: "page-a", request_hash: "hash-a" }, "hash-b"),
    { kind: "collision" }
  );
  assert.deepEqual(
    assessPageCreateMutationReceipt({ page_id: "page-a", request_hash: null }, "hash-a"),
    { kind: "collision" }
  );
});

test("POST /api/pages reserves an owner-scoped idempotency receipt before durable creation", async () => {
  const route = (await readFile(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const createRoute = section(route, 'pageRouter.post("/",', 'pageRouter.get("/:pageId/cover"');

  assert.match(route, /mutationId: z\.string\(\)\.min\(1\)\.max\(64\)\.regex\(\/\^\[a-zA-Z0-9_-\]\+\$\/\)\.optional\(\)/);
  assert.match(createRoute, /createMutationRequestHash\(creation\)/);
  assert.match(createRoute, /INSERT INTO page_create_mutations/);
  assert.match(createRoute, /if \(!isDuplicateEntryError\(error\)\) throw error;/);
  assert.match(createRoute, /assessPageCreateMutationReceipt\(receipt, mutationHash\)/);
  assert.match(createRoute, /PAGE_CREATE_REPLAY_UNAVAILABLE/);
  assert.ok(
    createRoute.indexOf("INSERT INTO page_create_mutations") < createRoute.indexOf("INSERT INTO pages"),
    "the receipt must be reserved before the page row is inserted"
  );
});

test("fresh and upgraded databases both install durable page-creation receipts", async () => {
  const baseline = (await readFile(new URL("../migrations/001_init.sql", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const migration = (await readFile(
    new URL("../migrations/036_page_create_mutation_receipts.sql", import.meta.url),
    "utf8"
  )).replace(/\r\n/g, "\n");

  const baselineReceiptTable = section(
    baseline,
    "CREATE TABLE IF NOT EXISTS page_create_mutations",
    "CREATE TABLE IF NOT EXISTS blocks"
  );
  for (const source of [baselineReceiptTable, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS page_create_mutations/);
    assert.match(source, /PRIMARY KEY \(owner_id, mutation_id\)/);
    assert.match(source, /FOREIGN KEY \(owner_id\) REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.doesNotMatch(source, /FOREIGN KEY \(page_id\)/);
  }
});

test("browser page creation and downloads remain bound to the initiating authentication generation", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");

  assert.match(app, /let authenticationSessionGeneration = 0;/);
  assert.match(app, /const pendingWorkspaceCreateTasks = new Map\(\);/);
  assert.match(app, /workspaceCreateBusy: false/);

  const authScope = section(app, "function captureAuthenticatedSessionScope", "function syncAuthOperationControls");
  assert.match(authScope, /generation: authenticationSessionGeneration/);
  assert.match(authScope, /scope\.generation === authenticationSessionGeneration/);
  assert.match(authScope, /scope\.targetKey === getAccountAvatarTargetKey\(state\.user\)/);
  assert.match(authScope, /elements\.addCollectionButton\.disabled = busy;/);
  assert.match(authScope, /elements\.homeNewPageButton\.disabled = busy;/);
  assert.match(authScope, /elements\.addDocumentButton\.disabled = busy;/);

  const api = section(app, "async function api", "function enqueueAccountProfilePatch");
  assert.match(api, /const authenticationScope = captureAuthenticatedSessionScope\(\);/);
  assert.match(api, /response\.status === 401[\s\S]*isCurrentAuthenticatedSessionScope\(authenticationScope\)/);

  const download = section(app, "async function downloadAttachment", "function getResponseFilename");
  assert.match(download, /const authenticationScope = captureAuthenticatedSessionScope\(\);/);
  assert.match(download, /if \(!isCurrentAuthenticatedSessionScope\(authenticationScope\)\) return \{ applied: false \};/);
  assert.ok(
    download.lastIndexOf("isCurrentAuthenticatedSessionScope(authenticationScope)") < download.indexOf("link.click();"),
    "the final account check must happen before starting the browser download"
  );

  const submission = section(app, "async function submitWorkspacePageCreate", "async function createWorkspacePage");
  assert.match(submission, /pendingWorkspaceCreateTasks\.set\(task\.taskKey, task\)/);
  assert.match(submission, /body: \{ \.\.\.task\.payload, mutationId: task\.mutationId \}/);
  const successfulSubmission = section(submission, "try {", "} catch (error)");
  assert.doesNotMatch(
    successfulSubmission,
    /pendingWorkspaceCreateTasks\.delete\(task\.taskKey\)/,
    "a successful POST must not forget its receipt before list refresh and navigation complete"
  );

  const creation = section(app, "async function createWorkspacePage", "async function createCollection");
  assert.match(creation, /if \(state\.workspaceCreateBusy\) return \{ applied: false \};/);
  assert.match(creation, /const pages = await fetchAllPageSummaries\(\);/);
  assert.match(creation, /data\.page\.ownerId !== state\.user\?\.id/);
  assert.match(creation, /pendingWorkspaceCreateTasks\.delete\(task\.taskKey\)/);
  assert.doesNotMatch(creation, /await loadPages\("", ""\)/);
  const navigationIndex = Math.max(creation.indexOf("await showCollection"), creation.indexOf("await openPage"));
  assert.ok(
    navigationIndex >= 0 && navigationIndex < creation.indexOf("pendingWorkspaceCreateTasks.delete"),
    "the mutation task must remain available until the created page is listed and opened"
  );

  const reset = section(app, "function resetAuthenticationSessionState", "function setAccountMessage");
  assert.match(reset, /authenticationSessionGeneration \+= 1;/);
  assert.match(reset, /pendingWorkspaceCreateTasks\.clear\(\);/);
  assert.match(reset, /state\.workspaceCreateBusy = false;/);

  const credentialRotation = section(
    app,
    "function acceptRotatedAuthenticationSession",
    "function syncWorkspaceCreateControls"
  );
  assert.match(credentialRotation, /authenticationSessionGeneration \+= 1;/);
  assert.match(credentialRotation, /pendingWorkspaceCreateTasks\.clear\(\);/);
  assert.match(credentialRotation, /setWorkspaceCreateBusy\(false\);/);
  assert.ok(
    credentialRotation.indexOf("authenticationSessionGeneration += 1") < credentialRotation.indexOf("setAuthenticated(true)"),
    "same-account credential rotation must invalidate older responses before restoring controls"
  );
  const passwordRotation = section(
    app,
    'elements.accountPasswordForm.addEventListener("submit"',
    'elements.accountTotpSetup.addEventListener("click"'
  );
  assert.match(passwordRotation, /acceptRotatedAuthenticationSession\(\);/);
});

test("standalone reproduction proves duplicate POST and stale-account effects before the fix", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-create-auth-boundary.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.pageCreate.vulnerableDuplicateCreated, true);
  assert.equal(result.pageCreate.fixedDuplicateCreated, false);
  assert.equal(result.pageCreate.fixedPageCount, 1);
  assert.equal(result.pageCreate.fixedReplayReturnedOriginalPage, true);
  assert.equal(result.pageCreate.mismatchedPayloadRejected, true);
  assert.equal(result.pageCreate.vulnerablePostSuccessRefreshFailureCreatedDuplicate, true);
  assert.equal(result.pageCreate.fixedPostSuccessRefreshFailureCreatedDuplicate, false);
  assert.equal(result.rapidCreate.vulnerableDuplicateRequestStarted, true);
  assert.equal(result.rapidCreate.fixedDuplicateRequestStarted, false);
  assert.equal(result.authenticationBoundary.vulnerableOldPageOpenedInNewAccount, true);
  assert.equal(result.authenticationBoundary.fixedOldPageOpenedInNewAccount, false);
  assert.equal(result.authenticationBoundary.vulnerableOldAttachmentDownloaded, true);
  assert.equal(result.authenticationBoundary.fixedOldAttachmentDownloaded, false);
  assert.equal(result.authenticationBoundary.vulnerableStale401ResetNewSession, true);
  assert.equal(result.authenticationBoundary.fixedStale401ResetNewSession, false);
  assert.equal(result.authenticationBoundary.vulnerableStale401ResetRotatedSameAccountSession, true);
  assert.equal(result.authenticationBoundary.fixedStale401ResetRotatedSameAccountSession, false);
});
