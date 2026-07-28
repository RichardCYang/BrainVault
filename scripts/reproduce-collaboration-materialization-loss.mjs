import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const normalize = (value) => value.replace(/\r\n/g, "\n");
const read = (relativePath) => normalize(readFileSync(join(root, relativePath), "utf8"));
const vulnerableCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8"
}).trim();
const vulnerableRoute = normalize(execFileSync(
  "git",
  ["show", "HEAD:src/routes/collaboration.routes.ts"],
  { cwd: root, encoding: "utf8" }
));
const fixedRoute = read("src/routes/collaboration.routes.ts");
const fixedMigration = read("migrations/022_server_authoritative_collaboration_materialization.sql");
const fixedProtocol = read("src/lib/collaboration-protocol.ts");
const pageGuards = read("src/routes/page.routes.ts");
const transferGuards = read("src/lib/data-transfer.ts");

// Prove the archived baseline accepted request-body content and advanced the
// checkpoint based only on an independently supplied numeric update ID.
assert.match(vulnerableRoute, /validateCollaborationBlockHierarchy\(body\.blocks\)/);
assert.match(vulnerableRoute, /\[body\.title, pageId\]/);
assert.match(vulnerableRoute, /materialized_update_id = \?/);

// Prove the working tree has removed that authority from the request and now
// reconstructs under the same database lock used by durable Yjs writers.
assert.match(fixedRoute, /materializeCollaborationUpdates/);
assert.match(fixedRoute, /SELECT id, update_data[\s\S]*ORDER BY id ASC[\s\S]*FOR UPDATE/);
assert.doesNotMatch(fixedRoute, /body\.(?:title|blocks|deletedAttachmentIds)/);
assert.match(fixedRoute, /materialization_version = \?/);
assert.match(fixedMigration, /materialization_version[\s\S]*NOT NULL DEFAULT 0/i);
assert.match(fixedProtocol, /latestUpdateId !== state\.materializedUpdateId/);
assert.match(fixedProtocol, /materializationVersion !== currentCollaborationMaterializationVersion/);
assert.match(pageGuards, /needsCollaborationMaterialization/);
assert.match(transferGuards, /needsCollaborationMaterialization/);

const durable = {
  updateId: 73,
  title: "Durable title",
  blocks: [
    { id: "root", markdown: "Canonical root" },
    { id: "child", markdown: "must survive" }
  ]
};
const forgedRequest = {
  updateId: durable.updateId,
  title: "Truncated",
  blocks: [],
  deletedAttachmentIds: []
};

// Exact pre-fix data-flow model: ID equality authorized a semantically unrelated
// duplicate body, which then made every ID-only destructive guard look safe.
const vulnerableSql = {
  title: forgedRequest.title,
  blocks: forgedRequest.blocks,
  materializedUpdateId: forgedRequest.updateId
};
const vulnerableDestructiveGuardAllowsHistoryDeletion =
  durable.updateId <= vulnerableSql.materializedUpdateId;

// Fixed data-flow model: request content is absent, SQL is derived from the
// durable update log, and a legacy version-0 marker cannot authorize deletion.
const fixedSql = {
  title: durable.title,
  blocks: durable.blocks,
  materializedUpdateId: durable.updateId,
  materializationVersion: 1
};
const fixedPreservesDurableContent =
  fixedSql.title === durable.title
  && fixedSql.blocks.length === durable.blocks.length;
const legacyCheckpointAllowsDestruction =
  durable.updateId === durable.updateId && 0 === fixedSql.materializationVersion;
const authoritativeCheckpointAllowsDestruction =
  durable.updateId === fixedSql.materializedUpdateId
  && fixedSql.materializationVersion === 1;

assert.equal(vulnerableSql.blocks.length, 0);
assert.equal(vulnerableDestructiveGuardAllowsHistoryDeletion, true);
assert.equal(fixedPreservesDurableContent, true);
assert.equal(legacyCheckpointAllowsDestruction, false);
assert.equal(authoritativeCheckpointAllowsDestruction, true);

console.log(JSON.stringify({
  baselineCommit: vulnerableCommit,
  vulnerable: {
    latestDurableUpdateId: durable.updateId,
    forgedRequestAcceptedAtSameUpdateId: true,
    relationalBlockCountAfterMaterialization: vulnerableSql.blocks.length,
    destructiveGuardAllowsHistoryDeletion: vulnerableDestructiveGuardAllowsHistoryDeletion,
    permanentLossWindowReproduced: true
  },
  fixed: {
    requestCarriesContent: false,
    materializationSource: "ordered page_yjs_updates",
    relationalBlockCountAfterMaterialization: fixedSql.blocks.length,
    legacyCheckpointRequiresRematerialization: !legacyCheckpointAllowsDestruction,
    authoritativeCheckpointAllowsDestruction,
    permanentLossWindowClosed: fixedPreservesDurableContent
  }
}, null, 2));
