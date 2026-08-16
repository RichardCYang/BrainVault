import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPageDraftStore } from "../public/draft-store.js";

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

test("collaboration validation is fenced by a durable write lease before CPU validation", () => {
  const server = read("src/lib/collaboration-server.ts");
  const persist = section(server, "  private async persistUpdate(", "  private broadcastPresenceUpdate(");
  assertBefore(
    persist,
    "const writeLeaseId = await reserveCollaborationWriteLease(",
    "validation = await this.validationPool.validate({",
    "collaboration update admission"
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

test("share removal, hard deletion, and restore fence active collaboration leases before destructive writes", () => {
  const routes = read("src/routes/collaboration.routes.ts");
  const removeShare = section(
    routes,
    'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"',
    'collaborationRouter.post(\n  "/recovery/pages/:pageId/candidates"'
  );
  assertBefore(
    removeShare,
    "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
    "await assertNoActiveCollaborationWriteLeases(client, [pageId])",
    "share removal"
  );
  assertBefore(
    removeShare,
    "await assertNoActiveCollaborationWriteLeases(client, [pageId])",
    'DELETE FROM page_shares WHERE page_id = ? AND user_id = ? AND permission = \'EDIT\'',
    "share removal"
  );

  const pageRoutes = read("src/routes/page.routes.ts");
  const hardDelete = section(pageRoutes, "const pageIds = subtreeRows.map", "const attachmentIds = blockRows");
  assertBefore(
    hardDelete,
    "await assertNoActiveCollaborationWriteLeases(client, pageIds)",
    'await client.execute("DELETE FROM pages WHERE id = ? AND owner_id = ?"',
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
    'await preserveRecoveryGrantsForPages(client, user.id, pageIds, "PAGE_DELETED")',
    'await client.execute("DELETE FROM pages WHERE id = ? AND owner_id = ?"',
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
    "pageDraftStore.removePageIfUnchanged(record)",
    "direct orphan upload"
  );
  assertBefore(
    sync,
    "await uploadServerRecoveryCandidate({",
    "collaborationRecoveryStore.remove(",
    "Yjs orphan upload"
  );
  assert.match(sync, /if \(!accessiblePageIds\.has\(record\.pageId\)\)/);
  assert.match(sync, /YJS_LEGACY_UPDATE/);
  assert.match(sync, /RECOVERY_GRANT_NOT_FOUND/);
});
