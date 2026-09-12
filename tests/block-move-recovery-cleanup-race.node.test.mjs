import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appUrl = new URL("../public/app.js", import.meta.url);

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert.ok(start >= 0 && end > start, `missing source section: ${startNeedle}`);
  return source.slice(start, end);
}

test("block move cleans only source recovery drafts captured before request dispatch", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const move = section(source, "async function moveBlockToPage", "\nasync function deleteBlockWithVersionCheck");

  const captureIndex = move.indexOf("const sourceDraftRecord = sourceDraftScope");
  const submitIndex = move.indexOf("const data = await submitBlockMoveTask(task, scope");
  const cleanupIndex = move.indexOf("pageDraftStore.removeBlockIfUnchanged", submitIndex);
  const orderCaptureIndex = move.indexOf("const sourceBlockOrderCleanupOrigin =", captureIndex);
  const orderCleanupIndex = move.indexOf("pageDraftStore.acknowledgeBlockOrder", submitIndex);
  assert.ok(captureIndex >= 0 && submitIndex > captureIndex && cleanupIndex > submitIndex);
  assert.ok(orderCaptureIndex > captureIndex && orderCaptureIndex < submitIndex);
  assert.ok(orderCleanupIndex > submitIndex);
  assert.match(move, /const sourceDraftCleanupOrigins = new Map\(/);
  assert.match(
    move,
    /sourceBlockOrderCleanupOrigin\?\.orderedIds\.some\(\(id\) => movedIds\.includes\(id\)\)/
  );
  assert.doesNotMatch(
    move,
    /pageDraftStore\.removeBlocks\(/,
    "a completed move must not blanket-delete a recovery record that may have changed while the request was in flight"
  );
});

test("standalone reproduction preserves a newer same-source recovery draft after block move", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-block-move-recovery-cleanup-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.newerDraftPreserved, false);
  assert.equal(result.fixed.newerDraftPreserved, true);
  assert.equal(
    result.fixed.markdown,
    "newer recovery edit written while move was in flight"
  );
  assert.equal(result.blockOrder.vulnerable.staleOrderRetained, true);
  assert.equal(result.blockOrder.vulnerable.wouldBecomeRecoveryConflict, true);
  assert.equal(result.blockOrder.fixed.staleOrderRetained, false);
  assert.equal(result.blockOrder.fixedWithNewerOrder.staleOrderRetained, true);
  assert.equal(result.blockOrder.fixedWithNewerOrder.mutationId, "order-newer");
});
