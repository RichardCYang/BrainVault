import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("collection share mutations bind delegated ADMIN authority to its admitted generation", () => {
  const source = readFileSync(new URL("../src/routes/collection-sharing.routes.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");

  const admission = section(
    source,
    "type CollectionManagementAdmission",
    "async function lockCollectionDocumentPages"
  );
  assert.match(admission, /LEFT JOIN page_collection_memberships pcm/);
  assert.match(admission, /LEFT JOIN collection_shares cs/);
  assert.match(admission, /LEFT JOIN page_shares ps/);
  assert.match(admission, /row\.collection_permission !== "ADMIN"/);
  assert.match(admission, /currentAccess\.shareGeneration === admission\.shareGeneration/);
  assert.match(admission, /"COLLECTION_SHARE_ACCESS_CHANGED"/);

  const manageable = section(
    source,
    "async function getManageableCollection",
    "type CollectionManagementAdmission"
  );
  assert.match(manageable, /lockAccess: lockPage/);

  const routes = [
    section(
      source,
      'collectionSharingRouter.post(\n  "/collections/:collectionId/shares"',
      'collectionSharingRouter.patch(\n  "/collections/:collectionId/shares/:userId"'
    ),
    section(
      source,
      'collectionSharingRouter.patch(\n  "/collections/:collectionId/shares/:userId"',
      'collectionSharingRouter.delete(\n  "/collections/:collectionId/shares/:userId"'
    ),
    source.slice(source.indexOf('collectionSharingRouter.delete(\n  "/collections/:collectionId/shares/:userId"'))
  ];

  for (const routeSource of routes) {
    const captureIndex = routeSource.indexOf("captureCollectionManagementAdmission(collectionId, actor.id)");
    const transactionIndex = routeSource.indexOf("transaction(async (client)");
    const authFenceIndex = routeSource.indexOf("assertCurrentAuthSessionBoundary(actor.id, authScope, client)");
    const accessIndex = routeSource.indexOf("getManageableCollection(collectionId, actor.id, client, true)");
    const generationFenceIndex = routeSource.indexOf("assertCollectionManagementAdmission(managementAdmission, collectionAccess)");
    const mutationIndexes = ["INSERT INTO collection_shares", "UPDATE collection_shares", "DELETE FROM collection_shares"]
      .map((needle) => routeSource.indexOf(needle))
      .filter((index) => index >= 0);
    const firstMutationIndex = mutationIndexes.length ? Math.min(...mutationIndexes) : -1;

    assert.ok(
      captureIndex >= 0
        && captureIndex < transactionIndex
        && authFenceIndex > transactionIndex
        && accessIndex > authFenceIndex
        && generationFenceIndex > accessIndex
        && firstMutationIndex > generationFenceIndex,
      "each collection-share mutation must compare the admitted ADMIN grant with current locked access before writing"
    );
  }
});

test("race model rejects create/update/delete admitted under a replaced ADMIN grant", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-collection-admin-generation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);

  for (const action of ["create-share", "update-share", "delete-share"]) {
    assert.deepEqual(result.staleAdminGrant[action], {
      vulnerable: { action, outcome: "committed" },
      fixed: { action, outcome: "rejected-management-generation" }
    });
    assert.deepEqual(result.sameGeneration[action], { action, outcome: "committed" });
  }
});
