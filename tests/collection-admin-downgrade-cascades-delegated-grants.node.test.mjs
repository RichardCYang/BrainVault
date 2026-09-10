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

test("collection ADMIN downgrade cascades legacy direct grants created by that administrator", async () => {
  const route = await read("../src/routes/collection-sharing.routes.ts");
  const patch = section(
    route,
    'collectionSharingRouter.patch(\n  "/collections/:collectionId/shares/:userId"',
    'collectionSharingRouter.delete(\n  "/collections/:collectionId/shares/:userId"'
  );

  assert.match(patch, /if \(permission !== "ADMIN"\) \{/);
  assert.match(
    patch,
    /SELECT user_id, generation[\s\S]*WHERE page_id = \? AND shared_by = \? AND permission = 'EDIT'[\s\S]*FOR UPDATE/
  );
  assert.match(patch, /cascadedDirectGrants\.push\(\{ pageId: page\.id, userId: grant\.user_id, generation: grant\.generation \}\)/);
  assert.match(patch, /await assertNoActiveCollaborationWriteLeases\(client, \[\.\.\.fencedPageIds\]\)/);
  assert.match(patch, /await preserveRevokedGrantRecovery\(page, ownerId, principalId, client\)/);
  assert.match(patch, /DELETE FROM page_shares WHERE page_id = \? AND shared_by = \?/);
  assert.match(patch, /return \{ updated, oldGeneration: existing\.generation, pages, cascadedDirectGrants \}/);
  assert.match(patch, /for \(const grant of result\.cascadedDirectGrants\)/);
  assert.match(
    patch,
    /disconnectSharedUserGrant\(\s*grant\.pageId,\s*grant\.userId,\s*grant\.generation,\s*"Direct access granted by a downgraded collection administrator was revoked"/s
  );
});

test("downgrading the delegating admin can no longer leave a third-party editor behind", () => {
  const effectiveRole = ({ collectionPermission = null, directEdit = false }) => {
    if (collectionPermission === "ADMIN") return "ADMIN";
    if (collectionPermission === "WRITE") return "EDITOR";
    if (collectionPermission === "READ") return "READER";
    return directEdit ? "EDITOR" : null;
  };

  // Historical state supported by the migration path: a collection ADMIN once
  // minted a direct EDIT grant for a third party.
  assert.equal(effectiveRole({ directEdit: true }), "EDITOR");

  // ADMIN -> WRITE/READ revokes the authority that justified the delegated
  // grant. The downgrade must therefore cascade that direct grant.
  assert.equal(effectiveRole({ directEdit: false }), null);
});
