import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPageDeletionSnapshot } from "../src/lib/page-delete-snapshot.ts";

const pages = [{
  id: "page_1",
  parent_page_id: null,
  edit_version: 4,
  content_version: 9
}];

function snapshot(collapsed = [], order = []) {
  return createPageDeletionSnapshot(
    pages,
    [],
    [],
    [],
    [],
    [],
    [],
    { ownerId: "user_owner", generation: 1 },
    [],
    collapsed,
    order
  );
}

test("owner navigation changes after deletion preview invalidate the stale hard delete", () => {
  const previewSnapshot = snapshot();

  assert.notEqual(
    snapshot([{ page_id: "page_1" }]),
    previewSnapshot,
    "a newly collapsed target page must invalidate the old destructive snapshot"
  );
  assert.notEqual(
    snapshot([], [{ page_id: "page_1", sort_order: 7 }]),
    previewSnapshot,
    "a newly ordered target page must invalidate the old destructive snapshot"
  );
  assert.notEqual(
    snapshot([], [{ page_id: "page_1", sort_order: 8 }]),
    snapshot([], [{ page_id: "page_1", sort_order: 7 }]),
    "a changed owner navigation order must change the snapshot"
  );
});

test("owner navigation snapshot hashing is deterministic and semantic", () => {
  const order = [
    { page_id: "page_2", sort_order: 4 },
    { page_id: "page_1", sort_order: 2 }
  ];
  assert.equal(
    snapshot(
      [{ page_id: "page_2" }, { page_id: "page_1" }],
      order
    ),
    snapshot(
      [{ page_id: "page_1" }, { page_id: "page_2" }],
      [...order].reverse()
    )
  );
});

test("page deletion reads, locks, and validates owner navigation state before deleting pages", () => {
  const route = readFileSync(
    new URL("../src/routes/page.routes.ts", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");

  assert.match(
    route,
    /async function getPageDeletionOwnerNavigationPreferences[\s\S]*FROM user_navigation_collapsed_pages[\s\S]*WHERE user_id = \? AND page_id IN[\s\S]*FROM user_navigation_page_order[\s\S]*WHERE user_id = \? AND page_id IN/
  );

  const snapshotRouteStart = route.indexOf('pageRouter.get(\n  "/:pageId/deletion-snapshot"');
  const patchRouteStart = route.indexOf('pageRouter.patch("/:pageId"', snapshotRouteStart);
  const deleteRouteStart = route.indexOf('pageRouter.delete(\n  "/:pageId"');
  const tagRouteStart = route.indexOf('pageRouter.put("/:pageId/tags"', deleteRouteStart);
  assert.ok(snapshotRouteStart >= 0 && patchRouteStart > snapshotRouteStart);
  assert.ok(deleteRouteStart >= 0 && tagRouteStart > deleteRouteStart);

  const snapshotRoute = route.slice(snapshotRouteStart, patchRouteStart);
  const deleteRoute = route.slice(deleteRouteStart, tagRouteStart);

  assert.match(
    snapshotRoute,
    /getPageDeletionOwnerNavigationPreferences\(\s*client,\s*subtreeRows,\s*access\.page\.owner_id\s*\)/
  );
  assert.match(snapshotRoute, /ownerNavigation\.collapsed[\s\S]*ownerNavigation\.order/);

  assert.match(
    deleteRoute,
    /getPageDeletionOwnerNavigationPreferences\(\s*client,\s*subtreeRows,\s*workspaceOwnerId,\s*true\s*\)/
  );
  const lockIndex = deleteRoute.indexOf("getPageDeletionOwnerNavigationPreferences(");
  const validationIndex = deleteRoute.indexOf("assertPageDeletionSnapshot(", lockIndex);
  const deleteIndex = deleteRoute.indexOf('DELETE FROM pages WHERE id = ? AND owner_id = ?', validationIndex);
  assert.ok(lockIndex >= 0 && validationIndex > lockIndex && deleteIndex > validationIndex);
  assert.match(
    deleteRoute.slice(validationIndex, deleteIndex),
    /ownerNavigation\.collapsed[\s\S]*ownerNavigation\.order/
  );
});
