import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
function hasMembershipOutsideDeletedPages(pages, memberships) {
  const deleted = new Set(pages.map((page) => page.id));
  return memberships.some(
    (membership) => deleted.has(membership.collection_id) && !deleted.has(membership.page_id)
  );
}

function rowsCascadedByDeleting(pageIds, memberships) {
  const deleted = new Set(pageIds);
  return memberships.filter((membership) =>
    deleted.has(membership.page_id) || deleted.has(membership.collection_id)
  );
}

test("workspace restore rejects reverse memberships that would cascade into a surviving page", () => {
  // Reproduction:
  // 1. user A owns collection_a; user B owns page_b.
  // 2. A stale/legacy row links page_b -> collection_a. The schema permits the
  //    individual foreign keys even though the row crosses workspace ownership.
  // 3. Restore replaces A's workspace with DELETE FROM pages WHERE owner_id=A.
  // 4. MariaDB cascades deletion of collection_a through collection_id and would
  //    silently delete B's membership unless restore reads the reverse edge.
  const ownedPages = [{ id: "collection_a" }, { id: "page_a" }];
  const memberships = [
    { page_id: "collection_a", collection_id: "collection_a" },
    { page_id: "page_a", collection_id: "collection_a" },
    { page_id: "page_b", collection_id: "collection_a" }
  ];

  assert.deepEqual(
    rowsCascadedByDeleting(ownedPages.map((page) => page.id), memberships),
    memberships,
    "the collection_id FK makes the external membership part of the delete cascade"
  );
  assert.equal(
    hasMembershipOutsideDeletedPages(ownedPages, memberships),
    true,
    "restore must fail closed before deleting any owned page"
  );
});

test("workspace restore snapshots both membership directions and locks them before replacement", () => {
  const transfer = readFileSync(
    new URL("../src/lib/data-transfer.ts", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const migration = readFileSync(
    new URL("../migrations/068_collection_sharing.sql", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");

  assert.match(
    migration,
    /FOREIGN KEY \(collection_id\) REFERENCES pages\(id\) ON DELETE CASCADE/
  );

  const helperStart = transfer.indexOf("async function getWorkspaceRestoreCollectionMemberships(");
  const helperEnd = transfer.indexOf("async function createWorkspaceRestoreSnapshot(", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = transfer.slice(helperStart, helperEnd);

  assert.match(helper, /WHERE page_id IN \(/);
  assert.match(helper, /WHERE collection_id IN \(/);
  assert.match(helper, /ORDER BY collection_id ASC, page_id ASC\$\{lock \? " FOR UPDATE" : ""\}/);
  assert.match(helper, /hasPageDeletionMembershipOutsideSubtree\(pages, memberships\)/);
  assert.match(helper, /"DATA_RESTORE_CONFLICT"/);

  const snapshotStart = transfer.indexOf("async function createWorkspaceRestoreSnapshot(");
  const snapshotEnd = transfer.indexOf("\nfunction invalidBackup(", snapshotStart);
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
  const snapshot = transfer.slice(snapshotStart, snapshotEnd);

  const pagesRead = snapshot.indexOf("const pages = await client.query<WorkspaceRestorePageRow>");
  const membershipsRead = snapshot.indexOf(
    "getWorkspaceRestoreCollectionMemberships(client, pages, lock)",
    pagesRead
  );
  const collaborationRead = snapshot.indexOf("assertWorkspaceCollaborationMaterialized", membershipsRead);
  const membershipHash = snapshot.indexOf("collection-membership\\0", collaborationRead);
  assert.ok(pagesRead >= 0);
  assert.ok(membershipsRead > pagesRead);
  assert.ok(collaborationRead > membershipsRead);
  assert.ok(membershipHash > collaborationRead);

  const lockedSnapshot = transfer.indexOf(
    "const lockedWorkspaceSnapshot = await createWorkspaceRestoreSnapshot("
  );
  const destructiveReplace = transfer.indexOf("await importRows(", lockedSnapshot);
  assert.ok(lockedSnapshot >= 0 && destructiveReplace > lockedSnapshot);
  assert.match(
    transfer.slice(lockedSnapshot, destructiveReplace),
    /createWorkspaceRestoreSnapshot\(\s*userId,\s*client,\s*true,/
  );

  const importRowsStart = transfer.indexOf("async function importRows(");
  const importRowsEnd = transfer.indexOf("\nasync function", importRowsStart + 20);
  assert.ok(importRowsStart >= 0 && importRowsEnd > importRowsStart);
  assert.match(
    transfer.slice(importRowsStart, importRowsEnd),
    /DELETE FROM pages WHERE owner_id = \?/
  );
});

test("safe in-workspace memberships remain valid restore state", () => {
  const ownedPages = [{ id: "collection_a" }, { id: "page_a" }];
  assert.equal(
    hasMembershipOutsideDeletedPages(ownedPages, [
      { page_id: "collection_a", collection_id: "collection_a" },
      { page_id: "page_a", collection_id: "collection_a" }
    ]),
    false
  );
});
