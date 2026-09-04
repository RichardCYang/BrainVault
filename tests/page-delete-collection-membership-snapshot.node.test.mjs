import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPageDeletionSnapshot } from "../src/lib/page-delete-snapshot.ts";

const pages = [{
  id: "page_child",
  parent_page_id: "page_parent",
  edit_version: 7,
  content_version: 11
}];
const blocks = [{
  id: "block_1",
  page_id: "page_child",
  edit_version: 3
}];

function snapshot(memberships) {
  return createPageDeletionSnapshot(
    pages,
    blocks,
    [],
    [],
    [],
    memberships,
    []
  );
}

test("moving an ancestor between collections invalidates a descendant deletion snapshot", () => {
  // Reproduction:
  // 1. Preview permanent deletion for page_child while its ancestor belongs to collection_a.
  // 2. In another session, move that ancestor to collection_b. The child page row and block
  //    versions do not change, but replacePageSubtreeCollectionMembership changes this row.
  // 3. Submitting the old preview must conflict rather than deleting the child in collection_b.
  const previewSnapshot = snapshot([{
    page_id: "page_child",
    collection_id: "collection_a"
  }]);

  assert.notEqual(
    snapshot([{ page_id: "page_child", collection_id: "collection_b" }]),
    previewSnapshot,
    "a collection-to-collection move must invalidate stale destructive intent"
  );
  assert.notEqual(
    snapshot([]),
    previewSnapshot,
    "moving the subtree out of a collection must also invalidate the preview"
  );
});

test("collection membership hashing is deterministic and page-bound", () => {
  const memberships = [
    { page_id: "page_child", collection_id: "collection_a" },
    { page_id: "page_descendant", collection_id: "collection_a" }
  ];
  assert.equal(snapshot(memberships), snapshot([...memberships].reverse()));
  assert.notEqual(
    snapshot(memberships),
    snapshot([{ ...memberships[0], page_id: "other_page" }, memberships[1]])
  );
});

test("permanent deletion reads, locks, and validates collection memberships before deleting", () => {
  const route = readFileSync(
    new URL("../src/routes/page.routes.ts", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const snapshotSource = readFileSync(
    new URL("../src/lib/page-delete-snapshot.ts", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const snapshotRouteStart = route.indexOf('pageRouter.get(\n  "/:pageId/deletion-snapshot"');
  const patchRouteStart = route.indexOf('pageRouter.patch("/:pageId"', snapshotRouteStart);
  const deleteRouteStart = route.indexOf('pageRouter.delete(\n  "/:pageId"');
  const tagRouteStart = route.indexOf('pageRouter.put("/:pageId/tags"', deleteRouteStart);
  assert.ok(snapshotRouteStart >= 0 && patchRouteStart > snapshotRouteStart);
  assert.ok(deleteRouteStart >= 0 && tagRouteStart > deleteRouteStart);

  const snapshotRoute = route.slice(snapshotRouteStart, patchRouteStart);
  const deleteRoute = route.slice(deleteRouteStart, tagRouteStart);
  assert.match(
    route,
    /async function getPageDeletionCollectionMemberships\([\s\S]*SELECT page_id, collection_id[\s\S]*FROM page_collection_memberships/
  );
  assert.match(
    snapshotSource,
    /`membership\\0\$\{membership\.page_id\}\\0\$\{membership\.collection_id\}\\n`/
  );
  assert.match(
    snapshotRoute,
    /const membershipRows = await getPageDeletionCollectionMemberships\(client, subtreeRows\);/
  );
  assert.match(
    snapshotRoute,
    /createPageDeletionSnapshot\([\s\S]*commentRows,[\s\S]*membershipRows[\s\S]*\)/
  );

  const pageLock = deleteRoute.indexOf("getOwnedPageTreeRows(workspaceOwnerId, client, true)");
  const membershipLock = deleteRoute.indexOf(
    "getPageDeletionCollectionMemberships(client, subtreeRows, true)"
  );
  const snapshotFence = deleteRoute.indexOf("assertPageDeletionSnapshot(", membershipLock);
  const destructiveDelete = deleteRoute.indexOf(
    'DELETE FROM pages WHERE id = ? AND owner_id = ?',
    snapshotFence
  );
  assert.ok(pageLock >= 0);
  assert.ok(membershipLock > pageLock, "membership rows must be read after the owned page tree is locked");
  assert.ok(snapshotFence > membershipLock, "membership must participate in stale-delete validation");
  assert.ok(destructiveDelete > snapshotFence, "validation must precede every destructive page delete");
  assert.match(deleteRoute.slice(snapshotFence, destructiveDelete), /membershipRows/);
});
