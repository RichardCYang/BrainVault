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

test("collection sharing migration stores role grants and materialized collection membership", async () => {
  const migration = await read("../migrations/068_collection_sharing.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS collection_shares/);
  assert.match(migration, /permission ENUM\('READ', 'WRITE', 'ADMIN'\) NOT NULL/);
  assert.match(migration, /generation VARCHAR\(64\) NOT NULL/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS page_collection_memberships/);
  assert.match(migration, /PRIMARY KEY \(page_id\)/);
  assert.match(migration, /WITH RECURSIVE collection_tree/);
});

test("collection permission is authoritative before legacy per-page EDIT sharing", async () => {
  const access = await read("../src/lib/page-access.ts");
  const collectionLookup = access.indexOf("SELECT permission, generation\n           FROM collection_shares");
  const directLookup = access.indexOf("SELECT generation\n         FROM page_shares");
  assert.ok(collectionLookup >= 0 && directLookup > collectionLookup);
  assert.match(access, /scope = "COLLECTION"/);
  assert.match(access, /collectionGrant\.permission === "ADMIN"\s*\? "ADMIN"\s*:\s*collectionGrant\.permission === "WRITE"\s*\? "EDITOR"\s*:\s*"READER"/);

  const resolveRole = ({ owner = false, collection = null, directEdit = false }) => {
    if (owner) return "OWNER";
    if (collection) return collection === "ADMIN" ? "ADMIN" : collection === "WRITE" ? "EDITOR" : "READER";
    return directEdit ? "EDITOR" : null;
  };
  assert.equal(resolveRole({ collection: "READ", directEdit: true }), "READER");
  assert.equal(resolveRole({ collection: "WRITE", directEdit: false }), "EDITOR");
  assert.equal(resolveRole({ collection: "ADMIN", directEdit: false }), "ADMIN");
});

test("collection sharing API exposes create/update/remove and requires collection administration", async () => {
  const app = await read("../src/app.ts");
  const route = await read("../src/routes/collection-sharing.routes.ts");
  assert.match(app, /app\.use\("\/api", collectionSharingRouter\)/);
  assert.match(route, /collectionSharingRouter\.post\(\s*"\/collections\/:collectionId\/shares"/);
  assert.match(route, /collectionSharingRouter\.patch\(\s*"\/collections\/:collectionId\/shares\/:userId"/);
  assert.match(route, /collectionSharingRouter\.delete\(\s*"\/collections\/:collectionId\/shares\/:userId"/);
  assert.match(route, /assertPageCanAdminister\(access, "Administrator permission is required to manage collection sharing"\)/);
  assert.match(route, /createId\("cshare"\)/);
  assert.match(route, /const downgradedTargetPages: PageRow\[\] = \[\]/);
  assert.match(route, /permission === "READ"/);
  assert.match(route, /WHERE page_id = \? AND user_id = \? AND permission = 'EDIT'/);
  assert.match(route, /await preserveRevokedGrantRecovery\(page, ownerId, target\.id, client\)/);
  assert.match(route, /disconnectPageCollaborators\(page\.id, "Collection sharing changed"\)/);
});

test("Yjs collaboration stays readable for READ grants while server rejects their writes", async () => {
  const server = await read("../src/lib/collaboration-server.ts");
  const client = await read("../public/collaboration.js");

  assert.match(server, /canEdit: canEditPageAccess\(access\)/);
  assert.match(server, /if \(!client\.canEdit\) \{\s*client\.socket\.sendJson\(\{\s*type: "error",\s*code: "COLLABORATION_READ_ONLY"/);
  assert.match(server, /assertPageCanEdit\(access, "This collaboration session is read-only"\)/);
  assert.match(client, /this\.canEdit = options\.canEdit !== false && options\.page\?\.access\?\.canEdit !== false/);
  assert.match(client, /if \(!this\.canEdit\) throw new Error\("This collection is shared with read-only permission"\)/);
  assert.match(client, /mustSendFullState = this\.canEdit && Boolean\(message\.bootstrap \|\| this\.needsRecovery\)/);
  assert.match(client, /!this\.canEdit \? BOOTSTRAP_ORIGIN : LOCAL_ORIGIN/);
});

test("collection ADMIN capability is surfaced to page management UI and READ remains read-only", async () => {
  const app = await read("../public/app.js");
  const html = await read("../public/index.html");
  assert.match(app, /page\.access && typeof page\.access\.canEdit === "boolean"/);
  assert.match(app, /page\.access && typeof page\.access\.canManagePage === "boolean"/);
  assert.match(app, /page\.access && typeof page\.access\.canManageSharing === "boolean"/);
  assert.match(app, /elements\.shareCollectionButton\.classList\.toggle\("hidden", !collection \|\| !canManagePageSharing\(collection\)\)/);
  assert.match(app, /if \(collection && !canManagePage\(collection\)\) return/);
  assert.match(html, /id="share-collection-button"/);
  assert.match(html, /value="READ"/);
  assert.match(html, /value="WRITE"/);
  assert.match(html, /value="ADMIN"/);
});

test("backup restore carries collection grants and rebuilds membership", async () => {
  const transfer = await read("../src/lib/data-transfer.ts");
  assert.match(transfer, /collectionShares: z\.array\(collectionShareSchema\).*\.optional\(\)/);
  assert.match(transfer, /const collectionShares = await client\.query<BackupCollectionShare>/);
  assert.match(transfer, /collectionShares: snapshot\.collectionShares/);
  assert.match(transfer, /await rebuildOwnerPageCollectionMemberships\(client, userId\)/);
  assert.match(transfer, /INSERT INTO collection_shares/);
});
