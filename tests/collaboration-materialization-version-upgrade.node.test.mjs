import assert from "node:assert/strict";
import test from "node:test";
import {
  currentCollaborationMaterializationVersion,
  needsCollaborationMaterialization
} from "../src/lib/collaboration-protocol.ts";

test("version-1 collaboration checkpoints are rematerialized under the canonical-state verifier", () => {
  assert.equal(currentCollaborationMaterializationVersion, 2);

  const historicalCheckpoint = {
    latestUpdateId: 73,
    materializedUpdateId: 73,
    materializationVersion: 1
  };
  assert.equal(
    needsCollaborationMaterialization(historicalCheckpoint),
    true,
    "a version-1 checkpoint may predate final-sink/canonical verification and must not authorize destructive operations"
  );

  assert.equal(
    needsCollaborationMaterialization({
      ...historicalCheckpoint,
      materializationVersion: currentCollaborationMaterializationVersion
    }),
    false,
    "only a version-2 checkpoint produced by the strengthened verifier is trusted"
  );
});
