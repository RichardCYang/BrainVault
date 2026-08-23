import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const routeUrl = new URL("../src/routes/block.routes.ts", import.meta.url);

function section(source, startNeedle, endNeedle = null) {
  const start = source.indexOf(startNeedle);
  const end = endNeedle === null ? source.length : source.indexOf(endNeedle, start);
  assert.ok(start >= 0 && end > start, `missing source section: ${startNeedle}`);
  return source.slice(start, end);
}

test("block patch resolves exact idempotent replay before the current shared-page direct-write gate", async () => {
  const source = (await readFile(routeUrl, "utf8")).replace(/\r\n/g, "\n");
  const patch = section(
    source,
    'blockRouter.patch("/blocks/:blockId"',
    'blockRouter.post(\n  "/blocks/:blockId/move"'
  );

  const replayIndex = patch.indexOf("isMatchingMutationReplay(");
  const gateIndex = patch.indexOf("assertDirectBlockMutationAllowed(lockedAccess);");
  const archivedIndex = patch.indexOf("assertPageNotArchived(lockedPage);");
  assert.ok(replayIndex >= 0 && gateIndex > replayIndex && archivedIndex > gateIndex);
});

test("block reorder resolves its owner-scoped receipt before the current shared-page direct-write gate", async () => {
  const source = (await readFile(routeUrl, "utf8")).replace(/\r\n/g, "\n");
  const reorder = section(source, '"/pages/:pageId/blocks/reorder"');

  const receiptIndex = reorder.indexOf("FROM block_order_mutations");
  const replayReturnIndex = reorder.indexOf("return { rows, pageContentVersion", receiptIndex);
  const gateIndex = reorder.indexOf("assertDirectBlockMutationAllowed(lockedAccess);");
  assert.ok(receiptIndex >= 0 && replayReturnIndex > receiptIndex && gateIndex > replayReturnIndex);
});

test("reproduction: sharing after a committed response-loss mutation no longer breaks exact replay", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-block-share-replay-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.deepEqual(result.exactReplay.vulnerable, {
    outcome: "COLLABORATION_REQUIRED",
    writes: 0
  });
  assert.deepEqual(result.exactReplay.fixed, {
    outcome: "REPLAYED",
    writes: 0
  });
  assert.equal(result.collision.fixed.outcome, "MUTATION_ID_REUSED");
  assert.equal(result.collision.fixed.writes, 0);
});
