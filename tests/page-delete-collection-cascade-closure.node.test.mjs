import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hasPageDeletionMembershipOutsideSubtree } from "../src/lib/page-delete-snapshot.ts";

const subtreePages = [
  { id: "collection_a" },
  { id: "page_child" }
];

function rowsCascadedByDeleting(pageIds, memberships) {
  const deleted = new Set(pageIds);
  return memberships.filter((membership) =>
    deleted.has(membership.page_id) || deleted.has(membership.collection_id)
  );
}

test("collection deletion detects a membership row whose surviving page is outside the subtree", () => {
  // Reproduction:
  // 1. collection_a and page_child are the confirmed deletion subtree.
  // 2. A stale, legacy, or otherwise inconsistent row links outside_page to collection_a.
  // 3. MariaDB cascades that row when collection_a is deleted because collection_id is an FK.
  // 4. The old snapshot query selected only by page_id, so outside_page's relationship was invisible.
  const memberships = [
    { page_id: "collection_a", collection_id: "collection_a" },
    { page_id: "page_child", collection_id: "collection_a" },
    { page_id: "outside_page", collection_id: "collection_a" }
  ];
  const cascaded = rowsCascadedByDeleting(
    subtreePages.map((page) => page.id),
    memberships
  );

  assert.equal(cascaded.length, 3, "the reverse FK removes the outside page membership too");
  assert.equal(
    hasPageDeletionMembershipOutsideSubtree(subtreePages, memberships),
    true,
    "the deletion guard must fail closed before that cascade"
  );
});

test("the closure guard permits only relationships contained by the confirmed deletion scope", () => {
  assert.equal(
    hasPageDeletionMembershipOutsideSubtree(subtreePages, [
      { page_id: "collection_a", collection_id: "collection_a" },
      { page_id: "page_child", collection_id: "collection_a" }
    ]),
    false
  );
  assert.equal(
    hasPageDeletionMembershipOutsideSubtree(
      [{ id: "page_child" }],
      [{ page_id: "page_child", collection_id: "collection_a" }]
    ),
    false,
    "deleting a child may remove its own membership without modifying another page"
  );
});

test("preview and permanent delete read reverse memberships and reject them before destructive SQL", () => {
  const route = readFileSync(
    new URL("../src/routes/page.routes.ts", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const helperStart = route.indexOf("async function getPageDeletionCollectionMemberships(");
  const helperEnd = route.indexOf("async function getPageDeletionShares(", helperStart);
  const snapshotRouteStart = route.indexOf('pageRouter.get(\n  "/:pageId/deletion-snapshot"');
  const patchRouteStart = route.indexOf('pageRouter.patch("/:pageId"', snapshotRouteStart);
  const deleteRouteStart = route.indexOf('pageRouter.delete(\n  "/:pageId"');
  const tagRouteStart = route.indexOf('pageRouter.put("/:pageId/tags"', deleteRouteStart);

  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.ok(snapshotRouteStart >= 0 && patchRouteStart > snapshotRouteStart);
  assert.ok(deleteRouteStart >= 0 && tagRouteStart > deleteRouteStart);

  const helper = route.slice(helperStart, helperEnd);
  const snapshotRoute = route.slice(snapshotRouteStart, patchRouteStart);
  const deleteRoute = route.slice(deleteRouteStart, tagRouteStart);

  assert.match(helper, /WHERE page_id IN \(/);
  assert.match(helper, /WHERE collection_id IN \(/);
  assert.match(helper, /ORDER BY collection_id ASC, page_id ASC\$\{lock \? " FOR UPDATE" : ""\}/);

  const previewMembershipRead = snapshotRoute.indexOf("getPageDeletionCollectionMemberships(client, subtreeRows)");
  const previewClosure = snapshotRoute.indexOf("assertPageDeletionMembershipClosure(", previewMembershipRead);
  const previewSnapshot = snapshotRoute.indexOf("createPageDeletionSnapshot(", previewClosure);
  assert.ok(previewMembershipRead >= 0);
  assert.ok(previewClosure > previewMembershipRead);
  assert.ok(previewSnapshot > previewClosure);

  const lockedMembershipRead = deleteRoute.indexOf(
    "getPageDeletionCollectionMemberships(client, subtreeRows, true)"
  );
  const lockedClosure = deleteRoute.indexOf(
    "assertPageDeletionMembershipClosure(",
    lockedMembershipRead
  );
  const snapshotFence = deleteRoute.indexOf("assertPageDeletionSnapshot(", lockedClosure);
  const destructiveDelete = deleteRoute.indexOf(
    'DELETE FROM pages WHERE id = ? AND owner_id = ?',
    snapshotFence
  );
  assert.ok(lockedMembershipRead >= 0);
  assert.ok(lockedClosure > lockedMembershipRead);
  assert.ok(snapshotFence > lockedClosure);
  assert.ok(destructiveDelete > snapshotFence);
});
