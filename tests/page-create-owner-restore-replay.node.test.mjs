import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

test("delegated page-create receipts bind both actor and destination-owner restore generations", () => {
  const helper = source("src/lib/page-create-mutation.ts");
  assert.match(helper, /workspace_owner_id: string \| null/);
  assert.match(helper, /owner_workspace_generation: number \| bigint \| string \| null/);
  assert.match(helper, /receipt\.workspace_owner_id !== workspaceOwnerId/);
  assert.match(helper, /receiptOwnerGeneration !== ownerWorkspaceGeneration/);

  const route = source("src/routes/page.routes.ts");
  assert.match(route, /workspace_owner_id, owner_workspace_generation/);
  assert.match(route, /receiptWorkspaceOwnerId/);
  assert.match(route, /receiptOwnerWorkspaceGeneration/);
  assert.match(
    route,
    /assessPageCreateMutationReceipt\([\s\S]*receiptWorkspaceOwnerId,[\s\S]*receiptOwnerWorkspaceGeneration[\s\S]*\)/
  );

  const migration = source("migrations/073_page_create_owner_generation_receipts.sql");
  assert.match(migration, /workspace_owner_id VARCHAR\(64\) NULL/);
  assert.match(migration, /owner_workspace_generation BIGINT UNSIGNED NULL/);
});

test("race model rejects a stale receipt when only the destination owner restored", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-create-owner-restore-replay.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.deepEqual(result.ownerRestoreReplay, {
    vulnerable: "replayed-restored-page",
    fixed: "superseded"
  });
  assert.equal(result.sameGenerationReplay, "replayed-original-page");
});
