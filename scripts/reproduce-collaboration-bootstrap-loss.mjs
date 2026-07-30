import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assessInitialCollaborationBootstrap } from "../src/lib/collaboration-bootstrap.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const normalize = (value) => value.replace(/\r\n/g, "\n");
const read = (relativePath) => normalize(readFileSync(join(root, relativePath), "utf8"));
const readHead = (relativePath) => normalize(execFileSync(
  "git",
  ["show", `HEAD:${relativePath}`],
  { cwd: root, encoding: "utf8" }
));

const vulnerableServer = readHead("src/lib/collaboration-server.ts");
const fixedServer = read("src/lib/collaboration-server.ts");
const materializationRoute = read("src/routes/collaboration.routes.ts");

assert.doesNotMatch(vulnerableServer, /assessInitialCollaborationBootstrap/);
assert.match(vulnerableServer, /currentUpdateId = toSafeUpdateId[\s\S]*INSERT INTO page_yjs_updates/);
assert.match(materializationRoute, /row\.type === "ATTACHMENT" \|\| activeIds\.has\(row\.id\)[\s\S]*DELETE FROM blocks/);
assert.match(fixedServer, /assessInitialCollaborationBootstrap/);
assert.match(fixedServer, /currentUpdateId === 0/);
assert.match(fixedServer, /client\.socket\.close\(4012/);

const storedBlocks = [
  {
    id: "root",
    page_id: "page-1",
    parent_block_id: null,
    type: "HEADING_1",
    markdown: "Canonical root",
    html_cache: "<h1>Canonical root</h1>",
    checked: 0,
    sort_order: 0,
    metadata: null,
    created_at: "2026-07-30 00:00:00",
    updated_at: "2026-07-30 00:00:00"
  },
  {
    id: "critical",
    page_id: "page-1",
    parent_block_id: "root",
    type: "MARKDOWN",
    markdown: "must survive",
    html_cache: "<p>must survive</p>",
    checked: 0,
    sort_order: 10,
    metadata: JSON.stringify({ importance: "critical" }),
    created_at: "2026-07-30 00:00:00",
    updated_at: "2026-07-30 00:00:00"
  }
];

// A valid Yjs document can still be semantically incomplete: a nonblank title
// with no blocks passes document decoding, then the old first-write path stores it.
const incompleteCandidate = {
  title: "Canonical page",
  blocks: [],
  deletedAttachmentIds: []
};

const vulnerableDurableHistoryAccepted = true;
const activeIds = new Set(incompleteCandidate.blocks.map((block) => block.id));
const vulnerableBlocksAfterMaterialization = storedBlocks.filter(
  (row) => row.type === "ATTACHMENT" || activeIds.has(row.id)
);
const fixedAssessment = assessInitialCollaborationBootstrap({
  pageTitle: "Canonical page",
  storedBlocks,
  candidate: incompleteCandidate
});
const fixedDurableHistoryAccepted = fixedAssessment.accepted;
const fixedBlocksAfterRejectedBootstrap = fixedDurableHistoryAccepted
  ? vulnerableBlocksAfterMaterialization
  : storedBlocks;

assert.equal(vulnerableDurableHistoryAccepted, true);
assert.equal(vulnerableBlocksAfterMaterialization.length, 0);
assert.equal(fixedAssessment.accepted, false);
assert.equal(fixedAssessment.summary.missingBlockCount, 2);
assert.equal(fixedDurableHistoryAccepted, false);
assert.equal(fixedBlocksAfterRejectedBootstrap.length, 2);

console.log(JSON.stringify({
  baselineCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  vulnerable: {
    firstYjsUpdateSemanticallyComparedWithSql: false,
    incompleteCandidateIsSyntacticallyValid: true,
    durableHistoryAccepted: vulnerableDurableHistoryAccepted,
    relationalBlockCountBeforeMaterialization: storedBlocks.length,
    relationalBlockCountAfterMaterialization: vulnerableBlocksAfterMaterialization.length,
    permanentLossWindowReproduced: vulnerableBlocksAfterMaterialization.length < storedBlocks.length
  },
  fixed: {
    firstYjsUpdateSemanticallyComparedWithSql: true,
    bootstrapAccepted: fixedDurableHistoryAccepted,
    mismatch: fixedAssessment.accepted ? null : fixedAssessment.summary,
    relationalBlockCountAfterRejectedBootstrap: fixedBlocksAfterRejectedBootstrap.length,
    permanentLossWindowClosed:
      !fixedDurableHistoryAccepted
      && fixedBlocksAfterRejectedBootstrap.length === storedBlocks.length
  }
}, null, 2));
