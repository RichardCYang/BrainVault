import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (path) => (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `section not found: ${startMarker}`);
  return source.slice(start, end);
}

function cascadeFrom(rows, rootGrantorId) {
  const byGrantor = new Map();
  for (const row of rows) {
    const children = byGrantor.get(row.sharedBy) ?? [];
    children.push(row.userId);
    byGrantor.set(row.sharedBy, children);
  }
  const queue = [rootGrantorId];
  const included = new Set([rootGrantorId]);
  const result = [];
  for (let index = 0; index < queue.length; index += 1) {
    for (const userId of byGrantor.get(queue[index]) ?? []) {
      if (included.has(userId)) continue;
      included.add(userId);
      result.push(userId);
      queue.push(userId);
    }
  }
  return result;
}

test("collection ADMIN downgrade/removal recursively revokes delegated collection grant provenance", async () => {
  const route = await read("../src/routes/collection-sharing.routes.ts");
  const helper = section(
    route,
    "async function lockDelegatedCollectionGrantCascade(",
    "async function lockDelegatedDirectGrants("
  );
  const patch = section(
    route,
    'collectionSharingRouter.patch(\n  "/collections/:collectionId/shares/:userId"',
    'collectionSharingRouter.delete(\n  "/collections/:collectionId/shares/:userId"'
  );
  const remove = route.slice(route.indexOf('collectionSharingRouter.delete(\n  "/collections/:collectionId/shares/:userId"'));

  assert.match(helper, /SELECT user_id, permission, generation, shared_by[\s\S]*FROM collection_shares[\s\S]*FOR UPDATE/);
  assert.match(helper, /byGrantor\.get\(grantorId\)/);
  assert.match(helper, /includedUsers\.has\(child\.user_id\)/);
  assert.match(patch, /permission !== "ADMIN"[\s\S]*lockDelegatedCollectionGrantCascade\(collectionId, sharedUserId, client\)/);
  assert.match(patch, /deleteDelegatedCollectionGrantCascade\(collectionId, cascadedCollectionGrants, client\)/);
  assert.match(patch, /result\.cascadedCollectionGrants[\s\S]*disconnectSharedUserGrant/);
  assert.match(remove, /lockDelegatedCollectionGrantCascade\([\s\S]*collectionId,[\s\S]*sharedUserId,[\s\S]*client/);
  assert.match(remove, /deleteDelegatedCollectionGrantCascade\(collectionId, cascadedCollectionGrants, client\)/);
  assert.match(remove, /result\.cascadedCollectionGrants[\s\S]*disconnectSharedUserGrant/);
});

test("delegation closure removes only descendants still rooted in the revoked ADMIN", () => {
  const rows = [
    { userId: "adminA", sharedBy: "owner" },
    { userId: "adminB", sharedBy: "adminA" },
    { userId: "writerC", sharedBy: "adminB" },
    { userId: "adminD", sharedBy: "owner" },
    { userId: "readerE", sharedBy: "adminD" }
  ];
  assert.deepEqual(cascadeFrom(rows, "adminA"), ["adminB", "writerC"]);

  // Owner re-authorization severs the dependency on A; C remains valid because
  // its immediate grantor B also survives with owner-backed authority.
  const reauthorized = rows.map((row) => row.userId === "adminB" ? { ...row, sharedBy: "owner" } : row);
  assert.deepEqual(cascadeFrom(reauthorized, "adminA"), []);
});

test("delegation closure is cycle-safe and never re-adds the cascade root", () => {
  const rows = [
    { userId: "adminA", sharedBy: "adminB" },
    { userId: "adminB", sharedBy: "adminA" },
    { userId: "writerC", sharedBy: "adminB" }
  ];
  assert.deepEqual(cascadeFrom(rows, "adminA"), ["adminB", "writerC"]);
});
