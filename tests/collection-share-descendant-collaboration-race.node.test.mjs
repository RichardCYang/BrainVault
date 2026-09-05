import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const route = readFileSync(
  path.join(root, "src/routes/collection-sharing.routes.ts"),
  "utf8"
).replace(/\r\n/g, "\n");

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

test("reproduction: an RR collection snapshot can miss a descendant update committed before its page lock", () => {
  const collectionAuthorizationSnapshot = {
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
    needsMaterialization(collectionAuthorizationSnapshot),
    false,
    "the old transaction snapshot incorrectly appears safe to tear down"
  );
  assert.equal(
    needsMaterialization(currentStateAfterDescendantCommit),
    true,
    "a current read must detect the newly durable, unmaterialized descendant update"
  );
});

test("final collection-share teardown reads the latest Yjs update with a locking current read", () => {
  const helper = section(
    route,
    "async function teardownCollaborationIfFinalShare",
    "collectionSharingRouter.get("
  );

  assert.match(
    helper,
    /FROM page_yjs_updates[\s\S]*WHERE page_id = \?[\s\S]*ORDER BY id DESC[\s\S]*LIMIT 1[\s\S]*FOR UPDATE/,
    "the latest durable update must be read after waits using SELECT ... FOR UPDATE"
  );
  assert.doesNotMatch(
    helper,
    /SELECT MAX\(id\) AS max_update_id FROM page_yjs_updates/,
    "plain MAX(id) can be pinned to an older REPEATABLE READ snapshot"
  );
});

test("collection-share removal locks member pages before the collaboration teardown fence", () => {
  const removeRoute = section(
    route,
    "collectionSharingRouter.delete(",
    "\n);"
  );

  const descendantLocks = removeRoute.indexOf("lockCollectionDocumentPages(collectionId, client)");
  const writeLeaseFence = removeRoute.indexOf("assertNoActiveCollaborationWriteLeases", descendantLocks);
  const teardown = removeRoute.indexOf("teardownCollaborationIfFinalShare", writeLeaseFence);

  assert.ok(descendantLocks >= 0, "collection member page rows must be locked");
  assert.ok(writeLeaseFence > descendantLocks, "the write-lease fence must follow descendant locking");
  assert.ok(teardown > writeLeaseFence, "final-share teardown must remain behind both fences");
});
