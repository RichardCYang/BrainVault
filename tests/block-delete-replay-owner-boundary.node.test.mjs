import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return text.slice(startIndex, endIndex);
}

const route = source("../src/routes/block.routes.ts");

test("block-delete receipt replay stays bound to the original page owner before cleanup", () => {
  const deleteRoute = section(
    route,
    'blockRouter.delete(\n  "/blocks/:blockId"',
    'blockRouter.post(\n  "/pages/:pageId/blocks/reorder"'
  );
  const replayStart = deleteRoute.indexOf("const replayAccess = await getPageAccess");
  const replayEnd = deleteRoute.indexOf("replayed: true", replayStart);
  assert.ok(replayStart >= 0 && replayEnd > replayStart, "receipt replay section must exist");

  const replaySection = deleteRoute.slice(replayStart, replayEnd);
  assert.match(replaySection, /replayAccess\.role !== "OWNER"/);
  assert.match(replaySection, /replayAccess\.page\.owner_id !== user\.id/);
  assert.match(replaySection, /BLOCK_DELETE_REPLAY_SUPERSEDED/);
  assert.match(replaySection, /ownerId: user\.id/);

  const ownershipFence = replaySection.indexOf('replayAccess.role !== "OWNER"');
  const generationFence = replaySection.indexOf("currentPageContentVersion !== assessment.pageContentVersion");
  assert.ok(
    ownershipFence >= 0 && generationFence > ownershipFence,
    "ownership must be revalidated before a durable delete receipt can authorize replay cleanup"
  );
});

test("defense-in-depth model: cross-owner receipt replay cannot authorize old attachment cleanup", () => {
  // The current schema cascades block-delete receipts when a page is deleted, so
  // normal application flows cannot reuse the page id across owners. Model the
  // authorization boundary anyway so a future migration/import/repair cannot
  // turn a stale receipt into cross-owner filesystem cleanup authority.
  function replayDecision({ originalActorId, currentPageOwnerId, currentRole, fixed }) {
    const currentPageContentVersion = 7;
    const receiptPageContentVersion = 7;
    const recreatedBlockExists = false;
    const currentAttachmentGeneration = 1;
    const receiptAttachmentGeneration = 1;

    if (
      fixed
      && (
        currentRole !== "OWNER"
        || currentPageOwnerId !== originalActorId
      )
    ) {
      return { status: 409, cleanupAuthorized: false };
    }

    if (currentPageContentVersion !== receiptPageContentVersion || recreatedBlockExists) {
      return { status: 409, cleanupAuthorized: false };
    }

    return {
      status: 204,
      cleanupAuthorized: currentAttachmentGeneration === receiptAttachmentGeneration
    };
  }

  const input = {
    originalActorId: "user_a",
    currentPageOwnerId: "user_b",
    currentRole: "EDITOR"
  };

  assert.deepEqual(
    replayDecision({ ...input, fixed: false }),
    { status: 204, cleanupAuthorized: true },
    "vulnerable replay can cross the page-owner boundary when generations coincide"
  );
  assert.deepEqual(
    replayDecision({ ...input, fixed: true }),
    { status: 409, cleanupAuthorized: false },
    "fixed replay rejects the cross-owner page generation before cleanup"
  );
});
