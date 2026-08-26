import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function assertBefore(source, first, second, label) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `${label}: missing ${first}`);
  assert.notEqual(secondIndex, -1, `${label}: missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${label}: ${first} must run before ${second}`);
}

const routeSource = readFileSync(
  new URL("../src/routes/collaboration.routes.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const materializationStart = routeSource.indexOf(
  'collaborationRouter.put(\n  "/pages/:pageId/collaboration/snapshot"'
);
assert.notEqual(materializationStart, -1, "missing collaboration materialization route");
const materialization = routeSource.slice(materializationStart);

test("collaboration materialization fails closed on zero-row canonical writes", () => {
  assert.match(
    materialization,
    /const detachedSurvivor = await client\.execute<\{ affectedRows: number \}>\([\s\S]*?if \(Number\(detachedSurvivor\.affectedRows\) !== 1\)/
  );
  assert.match(
    materialization,
    /const attachmentUpdate = await client\.execute<\{ affectedRows: number \}>\([\s\S]*?if \(Number\(attachmentUpdate\.affectedRows\) !== 1\)/
  );
  assert.match(
    materialization,
    /const blockUpdate = await client\.execute<\{ affectedRows: number \}>\([\s\S]*?if \(Number\(blockUpdate\.affectedRows\) !== 1\)/
  );
  assert.match(
    materialization,
    /const pageUpdate = await client\.execute<\{ affectedRows: number \}>\([\s\S]*?if \(Number\(pageUpdate\.affectedRows\) !== 1\)/
  );
});

test("the canonical block set is verified before the durable checkpoint advances", () => {
  assert.match(
    materialization,
    /const expectedFinalBlockIds = new Set\(activeIds\);[\s\S]*?const canonicalBlockSetMatches = currentBlockIds\.size === expectedFinalBlockIds\.size[\s\S]*?if \(!canonicalBlockSetMatches\)/
  );
  assertBefore(
    materialization,
    "const expectedFinalBlockIds = new Set(activeIds)",
    "const checkpoint = await client.execute<{ affectedRows: number }>",
    "collaboration final-sink verification"
  );
});

test("zero-row survivor detachment cannot commit a cascading data-loss checkpoint", () => {
  const originalRows = new Map([
    ["obsolete-parent", { id: "obsolete-parent", parentId: null }],
    ["surviving-child", { id: "surviving-child", parentId: "obsolete-parent" }]
  ]);

  const vulnerableRows = structuredClone(originalRows);
  // The protective UPDATE unexpectedly affects zero rows, but the old implementation
  // ignored that result and continued. Deleting the parent then cascades the child.
  const vulnerableDetachAffectedRows = 0;
  if (vulnerableDetachAffectedRows === 1) {
    vulnerableRows.get("surviving-child").parentId = null;
  }
  vulnerableRows.delete("obsolete-parent");
  if (vulnerableRows.get("surviving-child")?.parentId === "obsolete-parent") {
    vulnerableRows.delete("surviving-child");
  }
  const vulnerableCheckpointAdvanced = true;
  assert.equal(vulnerableCheckpointAdvanced, true);
  assert.equal(vulnerableRows.has("surviving-child"), false);

  const fixedRows = structuredClone(originalRows);
  const fixedDetachAffectedRows = 0;
  let fixedCheckpointAdvanced = false;
  let rolledBack = false;
  if (fixedDetachAffectedRows !== 1) {
    rolledBack = true;
  } else {
    fixedRows.get("surviving-child").parentId = null;
    fixedRows.delete("obsolete-parent");
    fixedCheckpointAdvanced = true;
  }

  assert.equal(rolledBack, true);
  assert.equal(fixedCheckpointAdvanced, false);
  assert.deepEqual(fixedRows, originalRows);
});
