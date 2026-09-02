import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPageDraftStore } from "../public/draft-store.js";
import { createCollaborationRecoveryStore } from "../public/collaboration-recovery-store.js";
import { shouldClearLocalRecoveryAfterAck } from "../public/collaboration.js";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertBefore(source, first, second, label) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `${label}: missing ${first}`);
  assert.notEqual(secondIndex, -1, `${label}: missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${label}: ${first} must run before ${second}`);
}

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

test("collaboration validation and no-op filtering happen before the durable write lease", () => {
  const server = read("src/lib/collaboration-server.ts");
  const persist = section(server, "  private async persistUpdate(", "  private broadcastPresenceUpdate(");
  assertBefore(
    persist,
    "validation = await this.validationPool.validate({",
    "const writeLeaseId = await reserveCollaborationWriteLease(",
    "collaboration update admission"
  );
  assertBefore(
    persist,
    'persistenceDecision.action === "ignore"',
    "const writeLeaseId = await reserveCollaborationWriteLease(",
    "no-op collaboration update admission"
  );
  assert.match(persist, /finally \{\n\s+await releaseWriteLease\(\);\n\s+\}/);

  const lease = read("src/lib/collaboration-write-lease.ts");
  assertBefore(
    lease,
    "getPageAccess(pageId, userId, client, { lockPage: true })",
    "INSERT INTO page_collaboration_write_leases",
    "lease reservation"
  );
  assert.match(lease, /expires_at <= CURRENT_TIMESTAMP\(6\)/);
  assert.match(lease, /COLLABORATION_WRITES_PENDING/);
});

test("room history replay releases the page row lock before CPU replay", () => {
  const server = read("src/lib/collaboration-server.ts");
  const roomLoad = section(server, "  private getOrCreateRoom(", "  private checkRate(");
  assertBefore(
    roomLoad,
    "const snapshot = await transaction(async (dbClient) => {",
    "const replay = await this.validationPool.replayHistory({",
    "room history snapshot"
  );
  assertBefore(
    roomLoad,
    "const replay = await this.validationPool.replayHistory({",
    "const loaded = await transaction(async (dbClient) => {",
    "room history replay"
  );
  assert.match(roomLoad, /SELECT id FROM pages WHERE id = \? FOR UPDATE/);
  assert.match(roomLoad, /COLLABORATION_HISTORY_CHANGED/);
});

test("archived pages cannot have version history reset", () => {
  const pageRoutes = read("src/routes/page.routes.ts");
  const resetRoute = section(
    pageRoutes,
    'pageRouter.delete(\n  "/:pageId/versions"',
    'pageRouter.get(\n  "/:pageId/versions/:versionId"'
  );
  assertBefore(
    resetRoute,
    "assertPageCanAdminister(pageAccess);",
    "assertPageNotArchived(page);",
    "version reset archived-page fence"
  );
  assertBefore(
    resetRoute,
    "assertPageNotArchived(page);",
    "INSERT INTO page_version_reset_mutations",
    "version reset archived-page fence"
  );
});

test("share removal, hard deletion, and restore fence active collaboration leases before destructive writes", () => {
  const routes = read("src/routes/collaboration.routes.ts");
  const removeShare = section(
    routes,
    'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"',
    'collaborationRouter.post(\n  "/recovery/pages/:pageId/candidates"'
  );
  assertBefore(
    removeShare,
    "getPageAccess(pageId, actor.id, client, { lockPage: true })",
    "await assertNoActiveCollaborationWriteLeases(client, [pageId])",
    "share removal"
  );
  assertBefore(
    removeShare,
    "await assertNoActiveCollaborationWriteLeases(client, [pageId])",
    "DELETE FROM page_shares",
    "share removal"
  );
  assert.match(removeShare, /permission = 'EDIT' AND generation = \?/);

  const pageRoutes = read("src/routes/page.routes.ts");
  const hardDelete = section(pageRoutes, "const pageIds = subtreeRows.map", "const attachmentIds = blockRows");
  assertBefore(
    hardDelete,
    "await assertNoActiveCollaborationWriteLeases(client, pageIds)",
    '"DELETE FROM pages WHERE id = ? AND owner_id = ?"',
    "hard deletion"
  );

  const transfer = read("src/lib/data-transfer.ts");
  const restore = section(transfer, "const lockedWorkspaceSnapshot = await createWorkspaceRestoreSnapshot", "await mkdir(path.dirname(targetAttachmentDir)");
  assertBefore(
    restore,
    "await assertNoActiveCollaborationWriteLeases(client, lockedWorkspaceSnapshot.pageIds)",
    "await importRows(",
    "workspace restore"
  );
});

test("both page archive routes fence active collaboration write leases", () => {
  const pageRoutes = read("src/routes/page.routes.ts");
  const patchRoute = section(
    pageRoutes,
    'pageRouter.patch("/:pageId"',
    'pageRouter.delete(\n  "/:pageId"'
  );
  const patchArchive = section(
    patchRoute,
    "if (updates.isArchived === true)",
    "if (existingPage.is_collection && updates.parentPageId)"
  );
  assertBefore(
    patchArchive,
    "await assertCollaborationMaterialized(client, [pageId])",
    "await assertNoActiveCollaborationWriteLeases(client, [pageId])",
    "PATCH archive collaboration fence"
  );

  const deleteRoute = section(
    pageRoutes,
    'pageRouter.delete(\n  "/:pageId"',
    'pageRouter.put("/:pageId/tags"'
  );
  const archiveBranch = section(
    deleteRoute,
    "const access = await getPageAccess(pageId, user.id, client, { lockPage: true })",
    "const updateResult = await client.execute"
  );
  assertBefore(
    archiveBranch,
    "await assertCollaborationMaterialized(client, [pageId])",
    "await assertNoActiveCollaborationWriteLeases(client, [pageId])",
    "DELETE archive collaboration fence"
  );
});

test("browser destructive transitions refresh durable recovery after acquiring the writer-exclusive barrier", () => {
  const app = read("public/app.js");
  const transition = section(
    app,
    "async function withPagePersistenceTransition(pageId, kind, action)",
    "async function withWorkspacePersistenceTransition(kind, action)"
  );
  assertBefore(
    transition,
    "pageTransitionLock.runWriterExclusive(",
    "await recoveryStorage.refresh();",
    "writer-exclusive recovery refresh"
  );
  assertBefore(
    transition,
    "await recoveryStorage.refresh();",
    "return action();",
    "fresh recovery inspection before destructive action"
  );
  assert.match(transition, /status\.localRecoveryInspectionFailed/);
});

test("collaboration ACK cleanup is prepared-mutation fenced and generation-matched", () => {
  const collaboration = read("public/collaboration.js");
  const cleanup = section(collaboration, "  clearLocalRecovery()", "  get isReady()");
  assert.match(collaboration, /this\.currentRecoveryGeneration = null/);
  assert.match(collaboration, /this\.recoveryCleanupQueue = Promise\.resolve\(\)/);
  assert.match(collaboration, /pendingPreparedLocalMutations === 0/);
  assert.match(cleanup, /this\.recoveryStore\.removeDurably\(/);
  assert.match(cleanup, /currentRecord\.generation/);
  assert.doesNotMatch(cleanup, /this\.recoveryStore\.remove\(/);
  assert.equal(shouldClearLocalRecoveryAfterAck(0, 1, false), false);
  assert.equal(shouldClearLocalRecoveryAfterAck(0, 0, true), false);
  assert.equal(shouldClearLocalRecoveryAfterAck(1, 0, false), false);
  assert.equal(shouldClearLocalRecoveryAfterAck(0, 0, false), true);
});

test("destructive transitions preserve server recovery admission before deleting access or page rows", () => {
  const routes = read("src/routes/collaboration.routes.ts");
  const removeShare = section(
    routes,
    'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"',
    'collaborationRouter.post(\n  "/recovery/pages/:pageId/candidates"'
  );
  assertBefore(removeShare, "await grantDirectPageRecovery(client", "DELETE FROM page_shares", "direct recovery grant");
  assertBefore(removeShare, "await grantYjsPageRecovery(client", "DELETE FROM page_shares", "Yjs recovery grant");

  const pageRoutes = read("src/routes/page.routes.ts");
  const hardDelete = section(pageRoutes, "const pageIds = subtreeRows.map", "const attachmentIds = blockRows");
  assertBefore(
    hardDelete,
    'await preserveRecoveryGrantsForPages(client, workspaceOwnerId, pageIds, "PAGE_DELETED")',
    '"DELETE FROM pages WHERE id = ? AND owner_id = ?"',
    "hard-delete recovery grant"
  );

  const transfer = read("src/lib/data-transfer.ts");
  assertBefore(
    transfer,
    '"WORKSPACE_RESTORED"',
    "await importRows(",
    "restore recovery grant"
  );
});

test("recovery vault survives page deletion, is quarantined, deduplicated, and quota bounded", () => {
  const migration = read("migrations/058_recovery_candidates.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS page_recovery_grants/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS page_recovery_candidates/);
  assert.match(migration, /YJS_LEGACY_UPDATE/);
  assert.doesNotMatch(migration, /FOREIGN KEY \(page_id\) REFERENCES pages/);

  const recovery = read("src/lib/recovery-candidates.ts");
  const store = section(recovery, "export async function storeRecoveryCandidate", "export async function listRecoveryCandidates");
  assertBefore(store, 'SELECT id FROM users WHERE id = ? FOR UPDATE', "SELECT owner_id", "quota serialization");
  assertBefore(store, "if (existing) return", "const usage = await client.queryOne", "idempotent retry");
  assert.match(store, /maxRecoveryVaultCandidatesPerPrincipal/);
  assert.match(store, /maxRecoveryVaultBytesPerPrincipal/);
  assert.match(store, /RECOVERY_VAULT_QUOTA_EXCEEDED/);
  assert.match(recovery, /legacyYjsRecoveryLineageKey/);
  assert.doesNotMatch(store, /UPDATE pages|INSERT INTO pages|UPDATE blocks|INSERT INTO blocks/);
});

test("old-only collaboration recovery warns before refusing a cross-lineage merge", () => {
  const collaboration = read("public/collaboration.js");
  const restore = section(
    collaboration,
    "  restoreLocalRecovery(documentEpoch)",
    "  persistRecoveryState"
  );
  assertBefore(
    restore,
    "if (preservedRecords.length && !this.recoveryLineageWarningShown)",
    "if (!matchingRecords.length) return false",
    "old-lineage warning"
  );
  assertBefore(
    restore,
    "if (!matchingRecords.length) return false",
    "this.Y.applyUpdate(this.doc, record.update, RECOVERY_ORIGIN)",
    "cross-lineage merge fence"
  );
});

test("server upload cleanup cannot delete a newer direct draft written during the upload", () => {
  const storage = new MemoryStorage();
  const store = createPageDraftStore(storage, { sourceId: "tab-a" });
  assert.equal(store.saveTitle({
    userId: "user-1",
    pageId: "page-1",
    value: "first",
    expectedVersion: 1,
    revision: 1
  }), true);
  const uploadedRecord = store.loadPage("user-1", "page-1", "tab-a");
  assert.ok(uploadedRecord);

  assert.equal(store.saveTitle({
    userId: "user-1",
    pageId: "page-1",
    value: "newer local edit",
    expectedVersion: 1,
    revision: 2
  }), true);

  assert.equal(store.removePageIfUnchanged(uploadedRecord), false);
  assert.equal(store.loadPage("user-1", "page-1", "tab-a")?.title?.value, "newer local edit");

  const latest = store.loadPage("user-1", "page-1", "tab-a");
  assert.equal(store.removePageIfUnchanged(latest), true);
  assert.equal(store.loadPage("user-1", "page-1", "tab-a"), null);
});

test("browser recovery sync removes local orphan bytes only after a successful durable upload", () => {
  const app = read("public/app.js");
  const sync = section(app, "async function reconcileServerRecoveryCandidates()", "function getCollaborativePageDrafts");
  assertBefore(
    sync,
    "await uploadServerRecoveryCandidate({",
    "await pageDraftStore.removePageIfUnchangedDurably(record)",
    "direct orphan upload"
  );
  assertBefore(
    sync,
    "await uploadServerRecoveryCandidate({",
    "await collaborationRecoveryStore.removeDurably(",
    "Yjs orphan upload"
  );
  assert.match(sync, /if \(!accessiblePageIds\.has\(record\.pageId\)\)/);
  assert.match(sync, /YJS_LEGACY_UPDATE/);
  assert.match(sync, /RECOVERY_GRANT_NOT_FOUND/);
});

test("recovery candidate deletion is owned exclusively by the recovery principal", () => {
  const recovery = read("src/lib/recovery-candidates.ts");
  const deletionStart = recovery.indexOf("export async function deleteRecoveryCandidate");
  assert.notEqual(deletionStart, -1, "missing recovery candidate deletion function");
  const deletion = recovery.slice(deletionStart);
  assert.match(deletion, /WHERE id = \? AND principal_id = \?/);
  assert.doesNotMatch(deletion, /owner_id/);
  assert.match(deletion, /\[candidateId, principalId\]/);
});

test("recovery candidate bytes are verified on the server and again before browser download", () => {
  const recovery = read("src/lib/recovery-candidates.ts");
  const readCandidate = section(
    recovery,
    "export async function getRecoveryCandidate",
    "export async function deleteRecoveryCandidate"
  );
  assert.match(readCandidate, /createHash\("sha256"\)\.update\(row\.payload\)\.digest\("hex"\)/);
  assert.match(readCandidate, /RECOVERY_CANDIDATE_INTEGRITY_FAILED/);
  assertBefore(readCandidate, "actualSha256 =", "return row", "server recovery integrity verification");

  const app = read("public/app.js");
  const download = section(
    app,
    "async function sha256BytesHex(bytes)",
    "function appendServerRecoveryCandidatePanel()"
  );
  assert.match(download, /globalThis\.crypto\.subtle\.digest\("SHA-256", bytes\)/);
  assert.match(download, /const bytes = await response\.arrayBuffer\(\)/);
  assert.match(download, /X-BrainVault-Recovery-SHA256/);
  assert.match(download, /actualSha256 !== expectedSha256/);
  assert.match(download, /servedSha256 !== expectedSha256/);
  assertBefore(download, "const actualSha256 = await sha256BytesHex(bytes)", "download.click()", "browser recovery integrity verification");
});


test("direct page opening fails closed when browser recovery cannot be inspected safely", () => {
  const app = read("public/app.js");
  const recovery = section(app, "function applyPersistedPageDraft(page)", "function findRenderedBlockRow");
  assertBefore(
    recovery,
    "pageDraftStore.inspectPageDrafts(scope.userId, scope.pageId)",
    "const records = inspection.records",
    "direct recovery strong inspection"
  );
  assertBefore(
    recovery,
    "assertBrowserRecoveryInspectionSafe(inspection)",
    "const records = inspection.records",
    "direct recovery fail-closed guard"
  );
  assert.doesNotMatch(recovery, /loadPageDrafts\(/);
});

test("collaboration account/page inspection preserves unreadable recovery evidence", () => {
  const storage = new MemoryStorage();
  const corruptKey = "brainvault.collaborationRecovery.v1:user-1:page-1:epoch-1:tab-corrupt";
  storage.setItem(corruptKey, "{not-json");
  const store = createCollaborationRecoveryStore(storage);
  const inspection = store.inspectAll("user-1", "page-1");
  assert.equal(inspection.reliable, true);
  assert.deepEqual(inspection.records, []);
  assert.deepEqual(inspection.unreadableKeys, [corruptKey]);
  assert.deepEqual(store.loadAll("user-1", "page-1"), []);
  assert.equal(storage.getItem(corruptKey), "{not-json");
});

test("collaboration startup treats unreadable or undecodable recovery as a non-retrying integrity failure", () => {
  const collaboration = read("public/collaboration.js");
  const restore = section(collaboration, "  restoreLocalRecovery(documentEpoch)", "  persistRecoveryState");
  assert.match(restore, /this\.recoveryStore\?\.inspectAll\?\./);
  assert.match(restore, /COLLABORATION_RECOVERY_INSPECTION_FAILED/);
  assert.match(restore, /COLLABORATION_RECOVERY_DECODE_FAILED/);
  assertBefore(
    restore,
    "if (decodeFailure)",
    "this.recoveredLocalRecords = recovered",
    "decode failure fence"
  );

  const connect = section(collaboration, "  async connect()", "  handleSocketMessage");
  assertBefore(
    connect,
    "this.restoreLocalRecovery(documentEpoch)",
    "const socket = new WebSocket",
    "recovery before websocket"
  );
  assert.match(connect, /if \(!recoveryIntegrityFailure\) this\.scheduleReconnect\(\)/);
});
