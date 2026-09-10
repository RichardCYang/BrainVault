import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

test("block-create receipts bind actor and destination-owner restore generations", () => {
  const helper = source("src/lib/block-create-mutation.ts");
  assert.match(helper, /workspace_generation: number \| bigint \| string \| null/);
  assert.match(helper, /workspace_owner_id: string \| null/);
  assert.match(helper, /owner_workspace_generation: number \| bigint \| string \| null/);
  assert.match(helper, /receiptWorkspaceGeneration !== input\.workspaceGeneration/);
  assert.match(helper, /receipt\.workspace_owner_id !== input\.workspaceOwnerId/);
  assert.match(helper, /receiptOwnerWorkspaceGeneration !== input\.ownerWorkspaceGeneration/);

  const route = source("src/routes/block.routes.ts");
  assert.match(route, /workspace_generation, workspace_owner_id, owner_workspace_generation/);
  assert.match(route, /workspaceGeneration: authScope\.workspaceGeneration/);
  assert.match(route, /ownerWorkspaceGeneration: attachmentGeneration/);
  assert.match(route, /ownerWorkspaceGeneration: currentWorkspaceGeneration/);
  assert.match(route, /BLOCK_CREATE_REPLAY_SUPERSEDED/);

  const migration = source("migrations/074_block_create_owner_generation_receipts.sql");
  assert.match(migration, /workspace_generation BIGINT UNSIGNED NULL/);
  assert.match(migration, /workspace_owner_id VARCHAR\(64\) NULL/);
  assert.match(migration, /owner_workspace_generation BIGINT UNSIGNED NULL/);
});

test("restore-replay model rejects stale receipts while preserving same-generation retries", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-block-create-receipt-restore-replay.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.deepEqual(result.ownerRestoreReplay, {
    vulnerable: "replayed-restored-block",
    fixed: "superseded"
  });
  assert.deepEqual(result.actorRestoreReplay, {
    vulnerable: "replayed-restored-block",
    fixed: "superseded"
  });
  assert.equal(result.sameGenerationReplay, "replayed-original-block");
});
