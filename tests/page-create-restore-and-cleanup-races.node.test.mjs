import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = end ? text.indexOf(end, startIndex + start.length) : text.length;
  assert.ok(endIndex > startIndex, `missing section end after: ${start}`);
  return text.slice(startIndex, endIndex);
}

test("collaborator page creation binds a shared parent to the grant generation admitted by the request", () => {
  const pages = source("src/routes/page.routes.ts");
  const helper = section(
    pages,
    "type PageCreateParentAdmission",
    "async function assertOwnedParentPage("
  );

  assert.match(helper, /SELECT p\.id AS page_id,[\s\S]*pcm\.collection_id,[\s\S]*cs\.generation AS share_generation/);
  assert.match(helper, /LEFT JOIN page_collection_memberships pcm ON pcm\.page_id = p\.id/);
  assert.match(helper, /LEFT JOIN collection_shares cs[\s\S]*cs\.user_id = \?/);
  assert.match(helper, /row\.owner_id !== userId && row\.collection_permission !== "ADMIN"/);
  assert.match(helper, /admission\.shareGeneration === currentAccess\.shareGeneration/);
  assert.match(helper, /"PAGE_CREATE_ACCESS_CHANGED"/);

  const create = section(pages, 'pageRouter.post("/",', 'pageRouter.get("/:pageId/cover"');
  const captureIndex = create.indexOf(
    "const parentAdmission = await capturePageCreateParentAdmission(creation.parentPageId, user.id)"
  );
  const transactionIndex = create.indexOf("const page = await transaction");
  const replayIndex = create.indexOf("return getPageResponse(assessment.pageId, user.id, client);");
  const parentLockIndex = create.indexOf(
    "await assertOwnedParentPage(creation.parentPageId, user.id, client, true)"
  );
  const currentAccessIndex = create.indexOf(
    "await getPageAccess(parentPage.id, user.id, client, { lockPage: true })"
  );
  const generationFenceIndex = create.indexOf(
    "assertPageCreateParentAdmission(parentAdmission, currentParentAccess)"
  );
  const insertIndex = create.indexOf("INSERT INTO pages");

  assert.ok(captureIndex >= 0 && captureIndex < transactionIndex);
  assert.ok(replayIndex > transactionIndex && replayIndex < parentLockIndex);
  assert.ok(
    parentLockIndex < currentAccessIndex
      && currentAccessIndex < generationFenceIndex
      && generationFenceIndex < insertIndex,
    "fresh collaborator creation must recheck the exact grant generation after locking the parent and before insertion"
  );
});

test("combined archive plus move performs both post-commit collaboration cleanups", () => {
  const pages = source("src/routes/page.routes.ts");
  const update = section(pages, 'pageRouter.patch("/:pageId"', 'pageRouter.delete(\n  "/:pageId"');
  const cleanupStart = update.lastIndexOf("if (updates.isArchived === true)");
  assert.ok(cleanupStart >= 0);
  const cleanup = update.slice(cleanupStart);

  assert.match(cleanup, /await disconnectArchivedPageCollaboratorsIfCurrent/);
  assert.match(cleanup, /\n    if \(updates\.parentPageId !== undefined\) \{/);
  assert.match(cleanup, /disconnectPageCollaboratorsForDocumentEpoch/);
  assert.doesNotMatch(cleanup, /else if \(updates\.parentPageId !== undefined\)/);
});

test("race model reproduces the stale shared-parent create and combined cleanup regressions", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-create-restore-and-cleanup-races.mjs", import.meta.url))],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);

  assert.deepEqual(result.staleCollaboratorPageCreate, {
    vulnerable: { outcome: "committed", createdPages: 1 },
    fixed: { outcome: "rejected-access-generation", createdPages: 0 }
  });
  assert.deepEqual(result.sameGenerationCollaboratorPageCreate, {
    outcome: "committed",
    createdPages: 1
  });
  assert.deepEqual(result.replayAfterParentRemoval, {
    outcome: "replayed",
    createdPages: 0
  });
  assert.deepEqual(result.combinedArchiveAndMoveCleanup, {
    vulnerable: ["root-archived-room"],
    fixed: ["root-archived-room", "descendant-old-collection-room"]
  });
});
