import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

function laterEditReplayDecision(row, retry) {
  if (
    row.lastMutationId === retry.mutationId &&
    row.lastMutationHash === retry.mutationHash
  ) {
    return { outcome: "replay", returnedVersion: row.editVersion };
  }
  if (row.editVersion !== retry.expectedVersion) {
    return { outcome: "conflict", returnedVersion: row.editVersion };
  }
  return { outcome: "apply", returnedVersion: row.editVersion + 1 };
}

test("a later edit must invalidate an older replay marker before a delayed retry", () => {
  const retry = {
    mutationId: "mutation-a",
    mutationHash: "hash-a",
    expectedVersion: 1
  };

  // Mutation A committed as version 2, but its response was lost.
  // A later structural/collaboration edit then created version 3.
  const vulnerableRow = {
    editVersion: 3,
    lastMutationId: "mutation-a",
    lastMutationHash: "hash-a"
  };
  assert.deepEqual(laterEditReplayDecision(vulnerableRow, retry), {
    outcome: "replay",
    returnedVersion: 3
  });

  // Clearing the stale marker makes the same delayed retry hit the
  // optimistic version fence rather than inheriting unrelated version 3.
  const fixedRow = {
    ...vulnerableRow,
    lastMutationId: null,
    lastMutationHash: null
  };
  assert.deepEqual(laterEditReplayDecision(fixedRow, retry), {
    outcome: "conflict",
    returnedVersion: 3
  });
});

test("server replay checks occur before optimistic version checks, so invalidation is required", async () => {
  const [blocks, pages] = await Promise.all([
    read("src/routes/block.routes.ts"),
    read("src/routes/page.routes.ts")
  ]);

  const blockPatchStart = blocks.indexOf(".patch(");
  const blockReplay = blocks.indexOf("isMatchingMutationReplay(", blockPatchStart);
  const blockConflict = blocks.indexOf(
    "if (Number(existing.edit_version ?? 1) !== body.expectedVersion)",
    blockReplay
  );
  assert.ok(
    blockPatchStart >= 0 && blockReplay > blockPatchStart && blockConflict > blockReplay,
    "block replay recognition must remain explicit and precede the optimistic version fence"
  );

  const pagePatchStart = pages.indexOf(".patch(");
  const pageReplay = pages.indexOf("isMatchingMutationReplay(", pagePatchStart);
  const pageUpdate = pages.indexOf("UPDATE pages SET", pageReplay);
  assert.ok(
    pagePatchStart >= 0 && pageReplay > pagePatchStart && pageUpdate > pageReplay,
    "page replay recognition must remain explicit before its versioned update"
  );
  assert.match(
    pages.slice(pageReplay, pageUpdate),
    /Any later edit that does not carry a mutation id must invalidate the[\s\S]*previous replay marker/
  );
});

test("structural block edits clear obsolete block PATCH replay markers", async () => {
  const blocks = await read("src/routes/block.routes.ts");

  assert.match(
    blocks,
    /SET parent_block_id = \?, sort_order = \?, last_mutation_id = NULL,\s*last_mutation_hash = NULL, edit_version = edit_version \+ 1/
  );
  assert.match(
    blocks,
    /SET sort_order = \?, parent_block_id = \?, last_mutation_id = NULL,\s*last_mutation_hash = NULL, edit_version = edit_version \+ 1/
  );
  assert.match(
    blocks,
    /SET sort_order = \?, last_mutation_id = NULL, last_mutation_hash = NULL,\s*edit_version = edit_version \+ 1/
  );
});

test("collaboration materialization clears obsolete page and block replay markers", async () => {
  const collaboration = await read("src/routes/collaboration.routes.ts");

  assert.match(
    collaboration,
    /UPDATE blocks SET parent_block_id = NULL, last_mutation_id = NULL, last_mutation_hash = NULL, edit_version = edit_version \+ 1/
  );
  assert.match(
    collaboration,
    /SET parent_block_id = \?, sort_order = \?, last_mutation_id = NULL,\s*last_mutation_hash = NULL, edit_version = edit_version \+ 1/
  );
  assert.match(
    collaboration,
    /metadata = \?, last_mutation_id = NULL, last_mutation_hash = NULL,\s*edit_version = edit_version \+ 1/
  );
  assert.match(
    collaboration,
    /SET title = \?, last_mutation_id = NULL, last_mutation_hash = NULL,\s*edit_version = edit_version \+ 1, content_version = content_version \+ 1/
  );
});
