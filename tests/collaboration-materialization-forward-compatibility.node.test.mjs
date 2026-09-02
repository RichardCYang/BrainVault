import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function assertBefore(source, first, second, label) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `${label}: missing ${first}`);
  assert.notEqual(secondIndex, -1, `${label}: missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${label}: ${first} must run before ${second}`);
}

const protocolSource = readSource("../src/lib/collaboration-protocol.ts");
const collaborationRoutes = readSource("../src/routes/collaboration.routes.ts");
const pageRoutes = readSource("../src/routes/page.routes.ts");
const dataTransfer = readSource("../src/lib/data-transfer.ts");

const versionMatch = protocolSource.match(
  /currentCollaborationMaterializationVersion\s*=\s*(\d+)/
);
assert.ok(versionMatch, "missing collaboration materialization version");
const currentVersion = Number(versionMatch[1]);

test("future collaboration provenance is distinguishable from a legacy checkpoint", () => {
  const futureVersion = currentVersion + 1;
  const latestUpdateId = 73;
  const materializedUpdateId = 73;

  // Before the fix, the generic stale predicate treated both legacy and future
  // provenance as materialization work and sent a future document into this
  // older final sink.
  const oldWouldRematerialize =
    latestUpdateId !== materializedUpdateId
    || (latestUpdateId > 0 && futureVersion !== currentVersion);

  assert.equal(oldWouldRematerialize, true);
  assert.match(
    protocolSource,
    /return materializationVersion > currentCollaborationMaterializationVersion;/
  );
});

test("the collaboration final sink rejects future provenance before canonical rewrites", () => {
  const start = collaborationRoutes.indexOf(
    'collaborationRouter.put(\n  "/pages/:pageId/collaboration/snapshot"'
  );
  assert.notEqual(start, -1, "missing collaboration materialization route");
  const materialization = collaborationRoutes.slice(start);

  assertBefore(
    materialization,
    "if (isUnsupportedCollaborationMaterializationVersion(materializationVersion))",
    "materialization = (await collaborationMaterializationPool.materializeHistory({",
    "future materialization-version fence"
  );
  assertBefore(
    materialization,
    "if (isUnsupportedCollaborationMaterializationVersion(materializationVersion))",
    "UPDATE blocks",
    "future materialization-version fence"
  );
  assertBefore(
    materialization,
    "if (isUnsupportedCollaborationMaterializationVersion(materializationVersion))",
    "SET materialized_update_id = ?, materialization_version = ?",
    "future materialization-version fence"
  );
});

test("destructive page/share and workspace-transfer paths fail closed on future provenance", () => {
  const shareStart = collaborationRoutes.indexOf(
    'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"'
  );
  const shareEnd = collaborationRoutes.indexOf(
    'collaborationRouter.post(\n  "/pages/:pageId/collaboration/session"',
    shareStart
  );
  assert.notEqual(shareStart, -1, "missing page-share deletion route");
  const shareRemoval = collaborationRoutes.slice(shareStart, shareEnd);

  assertBefore(
    shareRemoval,
    "isUnsupportedCollaborationMaterializationVersion(preRemovalState.materialization_version)",
    "DELETE FROM page_shares",
    "final-share future-version fence"
  );

  const pageGuardStart = pageRoutes.indexOf("async function assertCollaborationMaterialized");
  assert.notEqual(pageGuardStart, -1, "missing destructive page materialization guard");
  const pageGuard = pageRoutes.slice(pageGuardStart, pageRoutes.indexOf("\n}\n", pageGuardStart) + 3);
  assertBefore(
    pageGuard,
    "isUnsupportedCollaborationMaterializationVersion(materializationVersion)",
    "needsCollaborationMaterialization({",
    "page destructive future-version fence"
  );

  const transferGuardStart = dataTransfer.indexOf("async function assertWorkspaceCollaborationMaterialized");
  assert.notEqual(transferGuardStart, -1, "missing workspace collaboration materialization guard");
  const transferGuard = dataTransfer.slice(
    transferGuardStart,
    dataTransfer.indexOf("\n}\n", transferGuardStart) + 3
  );
  assertBefore(
    transferGuard,
    "isUnsupportedCollaborationMaterializationVersion(materializationVersion)",
    "needsCollaborationMaterialization({",
    "workspace transfer future-version fence"
  );
});
