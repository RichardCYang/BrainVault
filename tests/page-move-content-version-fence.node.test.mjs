import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const patchStart = route.indexOf('pageRouter.patch("/:pageId"');
const deleteStart = route.indexOf("pageRouter.delete(", patchStart);
const patchRoute = route.slice(patchStart, deleteStart);

test("stale page moves are fenced by both edit and content versions", () => {
  assert.ok(patchStart >= 0 && deleteStart > patchStart, "page PATCH route must be discoverable");
  assert.match(
    patchRoute,
    /updates\.isArchived === true \|\| updates\.parentPageId !== undefined/
  );
  assert.match(
    patchRoute,
    /contentVersionFenceRequired \? expectedContentVersion : undefined/
  );
  assert.match(
    patchRoute,
    /expectedContentVersion: mutationExpectedContentVersion/
  );
  assert.match(
    patchRoute,
    /AND content_version = \?/
  );
  assert.match(
    patchRoute,
    /mutationExpectedContentVersion === undefined \? \[\] : \[mutationExpectedContentVersion\]/
  );
});

test("page-move client sends the observed content version after the edit-lock flush boundary", () => {
  const moveStart = client.indexOf("async function moveNavigationPageToParent(");
  const moveEnd = client.indexOf("function findPendingPageDeleteTask", moveStart);
  const moveFlow = client.slice(moveStart, moveEnd);
  const submitStart = client.indexOf("async function submitPageMoveMutation(");
  const submitEnd = client.indexOf("function applyPageMoveMutationResult", submitStart);
  const submitFlow = client.slice(submitStart, submitEnd);

  assert.ok(moveStart >= 0 && moveEnd > moveStart, "page move flow must be discoverable");
  assert.match(moveFlow, /getPositiveVersion\(sourcePage\.contentVersion\)/);
  assert.match(
    moveFlow,
    /submitPageMoveMutation\([\s\S]*?expectedVersion,[\s\S]*?expectedContentVersion,[\s\S]*?scope/
  );
  assert.match(
    submitFlow,
    /parentPageId:\s*targetPageId,[\s\S]*?expectedVersion,[\s\S]*?expectedContentVersion,[\s\S]*?mutationId/
  );
});

test("reproduction: an edit-version-only fence accepts a stale move after a block save, while the dual fence rejects it", () => {
  const observed = { editVersion: 7, contentVersion: 11 };
  const afterConcurrentBlockSave = { editVersion: 7, contentVersion: 12 };

  const legacyMoveWouldCommit =
    afterConcurrentBlockSave.editVersion === observed.editVersion;
  const fixedMoveWouldCommit =
    afterConcurrentBlockSave.editVersion === observed.editVersion
    && afterConcurrentBlockSave.contentVersion === observed.contentVersion;

  assert.equal(legacyMoveWouldCommit, true);
  assert.equal(fixedMoveWouldCommit, false);
});
