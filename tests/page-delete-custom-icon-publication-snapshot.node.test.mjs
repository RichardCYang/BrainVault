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

function snapshot(publications) {
  return createPageDeletionSnapshot(
    pages,
    [],
    [],
    [],
    [],
    [],
    [],
    { ownerId: "user_owner", generation: 1 },
    publications
  );
}

test("a custom-icon publication committed after deletion preview invalidates the stale hard delete", () => {
  const previewSnapshot = snapshot([]);
  const publication = {
    page_id: "page_1",
    owner_id: "user_owner",
    file_path: "/upload/icons/user_owner/icon.webp"
  };

  assert.notEqual(
    snapshot([publication]),
    previewSnapshot,
    "post-preview owner-controlled publication state must change the destructive snapshot"
  );
  assert.equal(snapshot([publication]), snapshot([{ ...publication }]));
  assert.notEqual(
    snapshot([publication]),
    snapshot([{ ...publication, file_path: "/upload/icons/user_owner/other.webp" }])
  );
});

test("page deletion reads, locks, and hashes custom-icon publications before its delete sink", () => {
  const route = readFileSync(
    new URL("../src/routes/page.routes.ts", import.meta.url),
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
    /async function getPageDeletionCustomIconPublications[\s\S]*FROM custom_icon_page_publications/
  );
  assert.match(snapshotRoute, /getPageDeletionCustomIconPublications\(client, subtreeRows\)/);
  assert.match(
    deleteRoute,
    /const customIconPublicationRows = await getPageDeletionCustomIconPublications\(client, subtreeRows, true\);/
  );

  const lockIndex = deleteRoute.indexOf("getPageDeletionCustomIconPublications(client, subtreeRows, true)");
  const validationIndex = deleteRoute.indexOf("assertPageDeletionSnapshot(", lockIndex);
  const deleteIndex = deleteRoute.indexOf('DELETE FROM pages WHERE id = ? AND owner_id = ?', validationIndex);
  assert.ok(lockIndex >= 0 && validationIndex > lockIndex && deleteIndex > validationIndex);
  assert.match(deleteRoute.slice(validationIndex, deleteIndex), /customIconPublicationRows/);
});
