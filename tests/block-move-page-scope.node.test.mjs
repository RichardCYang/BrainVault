import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routeSource = readFileSync(
  new URL("../src/routes/block.routes.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

function blockMoveRouteSource() {
  const start = routeSource.indexOf('blockRouter.post(\n  "/blocks/:blockId/move"');
  const end = routeSource.indexOf('blockRouter.delete(\n  "/blocks/:blockId"', start);
  assert.ok(start >= 0, "block move route should be present");
  assert.ok(end > start, "block delete route should follow block move route");
  return routeSource.slice(start, end);
}

test("block move detaches only rows still owned by the locked source page", () => {
  const moveSource = blockMoveRouteSource();

  assert.match(
    moveSource,
    /UPDATE blocks SET parent_block_id = NULL WHERE id IN \(\$\{placeholders\}\) AND page_id = \?/
  );
  assert.match(moveSource, /\[\.\.\.movedBlockIds, sourcePageId\]/);
  assert.doesNotMatch(
    moveSource,
    /UPDATE blocks SET parent_block_id = NULL WHERE id IN \(\$\{placeholders\}\)`,/
  );
});

test("block move keeps the actual page transfer source-page scoped", () => {
  const moveSource = blockMoveRouteSource();

  assert.match(
    moveSource,
    /UPDATE blocks SET page_id = \? WHERE id IN \(\$\{placeholders\}\) AND page_id = \?/
  );
});

test("block move receipt replay rejects superseded source or destination page generations", () => {
  const moveSource = blockMoveRouteSource();
  const receiptBranchStart = moveSource.indexOf("if (receipt) {");
  const freshMoveStart = moveSource.indexOf(
    "// Resolve the current source only after the durable receipt check.",
    receiptBranchStart
  );
  assert.ok(
    receiptBranchStart >= 0 && freshMoveStart > receiptBranchStart,
    "receipt replay branch should be present"
  );

  const replaySource = moveSource.slice(receiptBranchStart, freshMoveStart);
  assert.match(
    replaySource,
    /sourceAccess: replaySourceAccess,[\s\S]*targetAccess: replayTargetAccess[\s\S]*await lockMovePages\(/
  );
  assert.match(
    replaySource,
    /const currentSourcePageContentVersion = Number\(replaySourceAccess\.page\.content_version \?\? 1\);/
  );
  assert.match(
    replaySource,
    /currentSourcePageContentVersion !== receiptSourcePageContentVersion/
  );
  assert.match(
    replaySource,
    /const currentTargetPageContentVersion = Number\(replayTargetAccess\.page\.content_version \?\? 1\);/
  );
  assert.match(
    replaySource,
    /currentTargetPageContentVersion !== receiptTargetPageContentVersion/
  );
  assert.match(replaySource, /BLOCK_MOVE_REPLAY_SUPERSEDED/);
});
