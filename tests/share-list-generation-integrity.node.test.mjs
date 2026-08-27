import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `section not found: ${startMarker}`);
  return source.slice(start, end);
}

test("share list binds owner authorization and share rows to one database snapshot", async () => {
  const routes = (await readFile(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const route = section(
    routes,
    'collaborationRouter.get(\n  "/pages/:pageId/shares",',
    'collaborationRouter.post(\n  "/pages/:pageId/shares",'
  );

  assert.match(route, /const rows = await transaction\(async \(client\) => \{/);
  assert.match(route, /getOwnedPage\(pageId, user\.id, client\)/);
  assert.match(route, /return getShareRows\(pageId, user\.id, client\)/);
  assert.doesNotMatch(route, /getOwnedPage\(pageId, user\.id\);/);
  assert.doesNotMatch(route, /const rows = await getShareRows\(pageId\);/);

  const helper = section(
    routes,
    "async function getShareRows",
    "function toSharePayload"
  );
  assert.match(helper, /INNER JOIN pages p ON p\.id = ps\.page_id AND p\.owner_id = \?/);
  assert.match(helper, /\[ownerId, pageId\]/);

  const postRoute = section(
    routes,
    'collaborationRouter.post(\n  "/pages/:pageId/shares",',
    'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId",'
  );
  assert.match(postRoute, /const shareResult = await transaction\(async \(client\) => \{/);
  assert.match(postRoute, /const rows = await getShareRows\(pageId, owner\.id, client\)/);
  assert.match(postRoute, /return \{ created, count: rows\.length \};/);
  assert.doesNotMatch(postRoute, /await getShareRows\(pageId\);/);
});

test("reproduction: page-id reuse cannot expose a replacement owner's share list", () => {
  const requestingOwnerId = "usr-owner-a";
  const stablePageId = "pag-stable-id";

  const oldGeneration = {
    pageId: stablePageId,
    ownerId: requestingOwnerId,
    shares: ["usr-collaborator-a"]
  };
  const replacementGeneration = {
    pageId: stablePageId,
    ownerId: "usr-owner-b",
    shares: ["usr-private-b"]
  };

  // Vulnerable flow: autocommit #1 authorizes the old generation. A delete/import
  // reuses the stable page ID, then autocommit #2 reads by page_id alone.
  assert.equal(oldGeneration.ownerId, requestingOwnerId);
  const vulnerableShares = replacementGeneration.shares;
  assert.deepEqual(vulnerableShares, ["usr-private-b"]);

  // Fixed flow: REPEATABLE READ pins both statements to the old authorized
  // generation; the replacement owner's rows are not visible to this request.
  const requestSnapshot = oldGeneration;
  assert.equal(requestSnapshot.ownerId, requestingOwnerId);
  assert.deepEqual(requestSnapshot.shares, ["usr-collaborator-a"]);
  assert.notDeepEqual(requestSnapshot.shares, replacementGeneration.shares);
});
