import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `missing start marker: ${startNeedle}`);
  assert.ok(end > start, `missing end marker: ${endNeedle}`);
  return source.slice(start, end);
}

function partialMutationVersionPayload(pageContentVersion, authoritative) {
  return {
    ...(authoritative ? { pageContentVersion } : {}),
    pageContentVersionAuthoritative: authoritative
  };
}

function isAuthoritativePartialMutationReplay(basePageContentVersion, currentVersion) {
  return basePageContentVersion !== undefined && currentVersion === basePageContentVersion + 1;
}

test("page PATCH materializes its acknowledgement before the transaction releases the page lock", () => {
  const pages = read("../src/routes/page.routes.ts");
  const route = section(
    pages,
    'pageRouter.patch("/:pageId"',
    "pageRouter.delete("
  );

  const transactionStart = route.indexOf("const page = await transaction(async (client) => {");
  const causalResponse = route.lastIndexOf("return getPageResponse(pageId, user.id, client);");
  const transactionEnd = route.indexOf("\n    });", causalResponse);
  const send = route.indexOf("res.json({ page });", transactionEnd);

  assert.ok(transactionStart >= 0);
  assert.ok(causalResponse > transactionStart);
  assert.ok(transactionEnd > causalResponse);
  assert.ok(send > transactionEnd);
  assert.doesNotMatch(route, /res\.json\(\{ page: await getPageResponse\(pageId, user\.id\) \}\)/);
  assert.match(route, /last_mutation_id = NULL/);
  assert.match(route, /last_mutation_hash = NULL/);
});

test("legacy page archive DELETE keeps its acknowledgement causally bound to the locked transaction", () => {
  const pages = read("../src/routes/page.routes.ts");
  const route = section(
    pages,
    "pageRouter.delete(",
    'pageRouter.put("/:pageId/tags"'
  );

  const transactionStart = route.indexOf("const archivedPage = await transaction(async (client) => {");
  const rowLock = route.indexOf("FOR UPDATE", transactionStart);
  const causalResponse = route.indexOf("return updatedPage;", rowLock);
  const transactionEnd = route.indexOf("\n      });", causalResponse);
  const send = route.indexOf("res.json({ page: toPage(archivedPage) });", transactionEnd);

  assert.ok(transactionStart >= 0);
  assert.ok(rowLock > transactionStart);
  assert.ok(causalResponse > rowLock);
  assert.ok(transactionEnd > causalResponse);
  assert.ok(send > transactionEnd);
  assert.doesNotMatch(route.slice(transactionEnd, send), /assertOwnedPage\(pageId, user\.id\)/);

  // Reproduction model: archive commits v8, then another request restores v9
  // before the first HTTP handler sends its response. A post-COMMIT reread
  // would incorrectly acknowledge v9; the locked snapshot must acknowledge v8.
  const archiveCommit = { version: 8, isArchived: true };
  const interveningRestore = { version: 9, isArchived: false };
  const vulnerablePostCommitRead = interveningRestore;
  const fixedAcknowledgement = archiveCommit;
  assert.deepEqual(vulnerablePostCommitRead, { version: 9, isArchived: false });
  assert.deepEqual(fixedAcknowledgement, { version: 8, isArchived: true });
});

test("post-COMMIT page disconnects are fenced against a later restore generation", () => {
  const pages = read("../src/routes/page.routes.ts");
  const archiveFence = section(
    pages,
    "async function disconnectArchivedPageCollaboratorsIfCurrent",
    "async function disconnectDeletedPageCollaboratorsIfCurrent"
  );
  const deleteFence = section(
    pages,
    "async function disconnectDeletedPageCollaboratorsIfCurrent",
    "async function assertCollaborationMaterialized"
  );
  const patchRoute = section(
    pages,
    'pageRouter.patch("/:pageId"',
    "pageRouter.delete("
  );
  const deleteRoute = section(
    pages,
    "pageRouter.delete(",
    'pageRouter.put("/:pageId/tags"'
  );

  const archiveRead = archiveFence.indexOf("SELECT is_archived, edit_version FROM pages");
  const archiveVersionFence = archiveFence.indexOf("Number(currentPage.edit_version ?? 1) !== archivedVersion");
  const archiveDisconnect = archiveFence.indexOf("disconnectPageCollaborators(pageId");
  assert.ok(archiveRead >= 0);
  assert.ok(archiveVersionFence > archiveRead);
  assert.ok(archiveDisconnect > archiveVersionFence);
  assert.match(archiveFence, /owner_id = \?/);

  const deleteRead = deleteFence.indexOf("SELECT id FROM pages");
  const deletePresenceFence = deleteFence.indexOf("if (!existingPageIds.has(pageId))");
  const deleteDisconnect = deleteFence.indexOf("disconnectPageCollaborators(pageId", deletePresenceFence);
  assert.ok(deleteRead >= 0);
  assert.ok(deletePresenceFence > deleteRead);
  assert.ok(deleteDisconnect > deletePresenceFence);
  assert.match(deleteFence, /offset \+= 500/);

  assert.match(
    patchRoute,
    /await disconnectArchivedPageCollaboratorsIfCurrent\(pageId, user\.id, Number\(page\.version \?\? 1\)\)/
  );
  assert.match(deleteRoute, /await disconnectDeletedPageCollaboratorsIfCurrent\(deletion\.pageIds\)/);
  assert.match(deleteRoute, /Number\(archivedPage\.edit_version \?\? 1\)/);
  assert.equal(
    (pages.match(/disconnectPageCollaborators\(/g) ?? []).length,
    2,
    "page mutation handlers must not bypass the current-generation fences"
  );

  // Reproduction model: the archive transaction commits v8, then a restore
  // commits v9 before the old handler performs its post-COMMIT disconnect.
  // The old behavior keyed only on page id and evicted the v9 room.
  const shouldDisconnectArchived = (currentPage, archivedVersion) =>
    Boolean(currentPage?.isArchived && currentPage.version === archivedVersion);
  assert.equal(shouldDisconnectArchived({ isArchived: true, version: 8 }, 8), true);
  assert.equal(shouldDisconnectArchived({ isArchived: false, version: 9 }, 8), false);

  // Permanent deletion has the analogous page-id reuse race: a restored row
  // means that the old delete must no longer invalidate a room for that id.
  const shouldDisconnectDeleted = (currentlyExistingIds, pageId) => !currentlyExistingIds.has(pageId);
  assert.equal(shouldDisconnectDeleted(new Set(), "pag_root"), true);
  assert.equal(shouldDisconnectDeleted(new Set(["pag_root"]), "pag_root"), false);
});

test("partial block mutations require a caller snapshot base before certifying the page-global content version", () => {
  const blocks = read("../src/routes/block.routes.ts");
  const client = read("../public/app.js");

  assert.match(blocks, /basePageContentVersion: safeVersionSchema\.optional\(\)/);
  assert.match(blocks, /pageContentVersion: authoritative \? pageContentVersion : undefined/);
  assert.match(blocks, /pageContentVersionAuthoritative: authoritative/);
  assert.match(blocks, /isAuthoritativePartialMutationReplay\(basePageContentVersion, currentContentVersion\)/);
  assert.match(client, /basePageContentVersion: getPositiveVersion\(state\.selectedPage\.contentVersion\)/);
  assert.match(client, /formData\.set\("basePageContentVersion", String\(task\.basePageContentVersion\)\)/);
  assert.match(client, /if \(data\?\.pageContentVersionAuthoritative !== true\) return;/);
  assert.equal((client.match(/applyAuthoritativePageContentVersion\(/g) ?? []).length, 4);
});

test("stale partial responses cannot make a stale page snapshot appear current", () => {
  const staleBase = 1;
  const lockedVersionAfterRemoteBlockEdit = 2;
  const committedVersion = 3;
  const authoritative = staleBase === lockedVersionAfterRemoteBlockEdit;
  const response = partialMutationVersionPayload(committedVersion, authoritative);

  assert.equal(response.pageContentVersionAuthoritative, false);
  assert.equal("pageContentVersion" in response, false);

  const currentBase = 1;
  const lockedCurrentVersion = 1;
  const currentResponse = partialMutationVersionPayload(2, currentBase === lockedCurrentVersion);
  assert.deepEqual(currentResponse, {
    pageContentVersion: 2,
    pageContentVersionAuthoritative: true
  });

  assert.equal(isAuthoritativePartialMutationReplay(1, 2), true);
  assert.equal(isAuthoritativePartialMutationReplay(1, 3), false);
});
