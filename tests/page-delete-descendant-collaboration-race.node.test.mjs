import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const route = readFileSync(path.join(root, "src/routes/page.routes.ts"), "utf8").replace(/\r\n/g, "\n");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function needsMaterialization({
  latestUpdateId,
  materializedUpdateId,
  materializationVersion
}) {
  return latestUpdateId !== materializedUpdateId
    || (latestUpdateId > 0 && materializationVersion !== 2);
}

test("reproduction: an RR snapshot can miss a descendant update that commits before its page lock", () => {
  const rootAuthorizationSnapshot = {
    latestUpdateId: 8,
    materializedUpdateId: 8,
    materializationVersion: 2
  };
  const currentStateAfterDescendantCommit = {
    latestUpdateId: 9,
    materializedUpdateId: 8,
    materializationVersion: 2
  };

  assert.equal(
    needsMaterialization(rootAuthorizationSnapshot),
    false,
    "a stale consistent read incorrectly appears safe to delete"
  );
  assert.equal(
    needsMaterialization(currentStateAfterDescendantCommit),
    true,
    "a current read must detect the newly durable, unmaterialized update"
  );
});

test("page deletion checks collaboration state with locking current reads", () => {
  const helper = section(
    route,
    "async function assertCollaborationMaterialized",
    "async function assertOwnedParentPage"
  );

  assert.match(
    helper,
    /FROM page_collaboration_state[\s\S]*WHERE page_id = \?[\s\S]*FOR UPDATE/
  );
  assert.match(
    helper,
    /FROM page_yjs_updates[\s\S]*WHERE page_id = \?[\s\S]*ORDER BY id DESC[\s\S]*LIMIT 1[\s\S]*FOR UPDATE/
  );
  assert.doesNotMatch(
    helper,
    /\(SELECT MAX\(id\) FROM page_yjs_updates/,
    "materialization guard must not use a stale scalar subquery"
  );
});

test("permanent deletion locks the owned page tree before its collaboration checkpoint", () => {
  const deleteRoute = section(
    route,
    'pageRouter.delete(\n  "/:pageId"',
    'pageRouter.put("/:pageId/tags"'
  );

  const treeLock = deleteRoute.indexOf("getOwnedPageTreeRows(workspaceOwnerId, client, true)");
  const checkpoint = deleteRoute.indexOf(
    "assertCollaborationMaterialized(client, subtreeRows.map((page) => page.id))",
    treeLock
  );
  const snapshotFence = deleteRoute.indexOf("assertPageDeletionSnapshot(", checkpoint);
  const finalDelete = deleteRoute.indexOf(
    '"DELETE FROM pages WHERE id = ? AND owner_id = ?"',
    snapshotFence
  );

  assert.ok(treeLock >= 0, "subtree page rows must be locked");
  assert.ok(checkpoint > treeLock, "current collaboration read must follow subtree page locking");
  assert.ok(snapshotFence > checkpoint, "snapshot validation must follow the collaboration checkpoint");
  assert.ok(finalDelete > snapshotFence, "hard delete must remain behind all validation fences");
});
