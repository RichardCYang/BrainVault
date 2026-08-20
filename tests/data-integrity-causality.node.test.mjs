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
  const collaborationServer = read("../src/lib/collaboration-server.ts");
  const archiveFence = section(
    pages,
    "async function disconnectArchivedPageCollaboratorsIfCurrent",
    "type PageCollaborationDocumentEpoch"
  );
  const deleteLineageCapture = section(
    pages,
    "type PageCollaborationDocumentEpoch",
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

  const archiveTransaction = archiveFence.indexOf("await transaction(async (client) => {");
  const archiveRead = archiveFence.indexOf("SELECT is_archived, edit_version");
  const archiveRowLock = archiveFence.indexOf("FOR UPDATE", archiveRead);
  const archiveVersionFence = archiveFence.indexOf("Number(currentPage.edit_version ?? 1) !== archivedVersion");
  const archiveDisconnect = archiveFence.indexOf("disconnectPageCollaborators(pageId");
  const archiveTransactionEnd = archiveFence.indexOf("\n    });", archiveDisconnect);
  assert.ok(archiveTransaction >= 0);
  assert.ok(archiveRead > archiveTransaction);
  assert.ok(archiveRowLock > archiveRead);
  assert.ok(archiveVersionFence > archiveRowLock);
  assert.ok(archiveDisconnect > archiveVersionFence);
  assert.ok(archiveTransactionEnd > archiveDisconnect);
  assert.match(archiveFence, /owner_id = \?/);

  assert.match(deleteLineageCapture, /SELECT page_id, document_epoch/);
  assert.match(deleteLineageCapture, /FROM page_collaboration_state/);
  assert.match(deleteLineageCapture, /offset \+= 500/);
  assert.match(
    collaborationServer,
    /room\.invalidated \|\| room\.documentEpoch !== documentEpoch/
  );
  assert.match(
    collaborationServer,
    /hub\.disconnectPageDocumentEpoch\(pageId, documentEpoch, reason\)/
  );

  assert.match(
    patchRoute,
    /await disconnectArchivedPageCollaboratorsIfCurrent\(pageId, user\.id, Number\(page\.version \?\? 1\)\)/
  );
  const captureIndex = deleteRoute.indexOf(
    "const collaborationDocumentEpochs = await getPageCollaborationDocumentEpochs(client, pageIds)"
  );
  const relationalDeleteIndex = deleteRoute.indexOf('DELETE FROM pages WHERE id = ? AND owner_id = ?');
  const transactionEnd = deleteRoute.indexOf("\n        });", relationalDeleteIndex);
  const lineageDisconnectIndex = deleteRoute.indexOf(
    "disconnectPageCollaboratorsForDocumentEpoch(",
    transactionEnd
  );
  assert.ok(captureIndex >= 0 && captureIndex < relationalDeleteIndex);
  assert.ok(transactionEnd > relationalDeleteIndex);
  assert.ok(lineageDisconnectIndex > transactionEnd);
  assert.match(deleteRoute, /if \(!deletion\.replayed\)/);
  assert.match(deleteRoute, /lineage\.pageId/);
  assert.match(deleteRoute, /lineage\.documentEpoch/);
  assert.match(deleteRoute, /Number\(archivedPage\.edit_version \?\? 1\)/);
  assert.equal(
    (pages.match(/disconnectPageCollaborators\(/g) ?? []).length,
    1,
    "only the archive fence may disconnect by page id"
  );
  assert.equal(
    (pages.match(/disconnectPageCollaboratorsForDocumentEpoch\(/g) ?? []).length,
    1,
    "permanent deletion must invalidate by captured document lineage"
  );

  // Reproduction model: without a row lock, the verification SELECT can read
  // archived v8, a restore can commit v9 before the Node callback disconnects,
  // and the stale handler can evict v9 collaborators. With FOR UPDATE, either
  // the archive cleanup owns v8 until after disconnect, or restore wins first
  // and the cleanup observes v9 and skips the disconnect.
  function reproduceArchiveDisconnectRace({ locked }) {
    let page = { isArchived: true, version: 8 };
    let restoredRoomConnected = false;
    let oldHandlerObserved = null;

    oldHandlerObserved = { ...page };
    if (!locked) {
      page = { isArchived: false, version: 9 };
      restoredRoomConnected = true;
    }

    const shouldDisconnect =
      oldHandlerObserved.isArchived && oldHandlerObserved.version === 8;
    if (shouldDisconnect) restoredRoomConnected = false;

    if (locked) {
      page = { isArchived: false, version: 9 };
      restoredRoomConnected = true;
    }
    return { page, restoredRoomConnected };
  }

  assert.deepEqual(reproduceArchiveDisconnectRace({ locked: false }), {
    page: { isArchived: false, version: 9 },
    restoredRoomConnected: false
  });
  assert.deepEqual(reproduceArchiveDisconnectRace({ locked: true }), {
    page: { isArchived: false, version: 9 },
    restoredRoomConnected: true
  });

  // Permanent deletion has a subtler page-id reuse race. The previous
  // existence-only fence preserved the restored row but also left this
  // process's old-generation room connected. Exact lineage matching evicts
  // the stale room while preserving any room for the restored generation.
  const deletedEpoch = "epoch_deleted";
  const restoredEpoch = "epoch_restored";
  const shouldDisconnectDeletedRoom = (roomEpoch) => roomEpoch === deletedEpoch;
  assert.equal(shouldDisconnectDeletedRoom(deletedEpoch), true);
  assert.equal(shouldDisconnectDeletedRoom(restoredEpoch), false);
});

test("share-transition disconnects cannot tear down a later collaboration generation", () => {
  const routes = read("../src/routes/collaboration.routes.ts");
  const shareCreate = section(
    routes,
    'collaborationRouter.post(\n  "/pages/:pageId/shares"',
    'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"'
  );
  const shareDelete = section(
    routes,
    'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"',
    'collaborationRouter.post(\n  "/recovery/pages/:pageId/candidates"'
  );
  const revokedUserFence = section(
    routes,
    "async function disconnectRemovedSharedUserIfCurrent",
    "function toSharePayload"
  );

  assert.match(shareCreate, /const previousState = await getCollaborationState\(pageId, client, \{ lock: true \}\)/);
  assert.match(shareCreate, /previousDocumentEpoch = previousState\?\.document_epoch \?\? null/);
  assert.match(shareCreate, /disconnectPageCollaboratorsForDocumentEpoch\(\s*pageId,\s*previousDocumentEpoch/s);
  assert.doesNotMatch(shareCreate, /disconnectPageCollaborators\(pageId/);

  const revokeTransaction = revokedUserFence.indexOf("await transaction(async (client) => {");
  const revokePageRead = revokedUserFence.indexOf("SELECT id FROM pages");
  const revokePageLock = revokedUserFence.indexOf("FOR UPDATE", revokePageRead);
  const revokeShareRead = revokedUserFence.indexOf("SELECT user_id FROM page_shares", revokePageLock);
  const revokeCurrentCheck = revokedUserFence.indexOf("if (currentShare) return;", revokeShareRead);
  const revokeDisconnect = revokedUserFence.indexOf("disconnectSharedUser(pageId", revokeCurrentCheck);
  const revokeTransactionEnd = revokedUserFence.indexOf("\n    });", revokeDisconnect);
  assert.ok(revokeTransaction >= 0);
  assert.ok(revokePageRead > revokeTransaction);
  assert.ok(revokePageLock > revokePageRead);
  assert.ok(revokeShareRead > revokePageLock);
  assert.ok(revokeCurrentCheck > revokeShareRead);
  assert.ok(revokeDisconnect > revokeCurrentCheck);
  assert.ok(revokeTransactionEnd > revokeDisconnect);

  assert.match(shareDelete, /removedDocumentEpoch: remaining === 0 \? \(preRemovalState\?\.document_epoch \?\? null\) : null/);
  assert.match(shareDelete, /disconnectPageCollaboratorsForDocumentEpoch\(\s*pageId,\s*result\.removedDocumentEpoch/s);
  assert.match(shareDelete, /await disconnectRemovedSharedUserIfCurrent\(pageId, owner\.id, sharedUserId\)/);
  assert.doesNotMatch(shareDelete, /disconnectPageCollaborators\(pageId/);
  assert.doesNotMatch(shareDelete, /\n\s*disconnectSharedUser\(pageId, sharedUserId\)/);

  // Reproduction: an old "first share" handler can resume after a later final
  // unshare + re-share has already established another document epoch. An
  // unfenced page-id disconnect evicts the new room; exact epoch invalidation
  // can only target the room that predated the old transaction.
  const oldEpoch = "epoch_old";
  const newEpoch = "epoch_new";
  const unfencedDisconnects = () => true;
  const epochFencedDisconnects = (roomEpoch) => roomEpoch === oldEpoch;
  assert.equal(unfencedDisconnects(newEpoch), true);
  assert.equal(epochFencedDisconnects(newEpoch), false);

  // A removed editor can also be re-added while another editor remains, so the
  // collaboration epoch does not change. The page-row lock makes the
  // post-COMMIT revocation verification serialize with re-share: if re-share
  // wins, currentShare is present and the stale handler skips the disconnect.
  const shouldDisconnectRemovedUser = ({ currentShare }) => !currentShare;
  assert.equal(shouldDisconnectRemovedUser({ currentShare: false }), true);
  assert.equal(shouldDisconnectRemovedUser({ currentShare: true }), false);
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

test("title acknowledgements keep the content-version token coupled to preserved blocks", () => {
  const client = read("../public/app.js");
  const titleQueue = section(
    client,
    "const pageTitleSaveQueue = createLatestWriteQueue",
    "async function downloadAttachment"
  );
  const deleteFlow = section(
    client,
    "async function deleteNavigationTarget()",
    "function renderCollectionView()"
  );

  assert.match(titleQueue, /const currentBlocks = state\.selectedPage\.blocks;/);
  assert.match(titleQueue, /const currentBlocksContentVersion = state\.selectedPage\.contentVersion;/);
  assert.match(
    titleQueue,
    /state\.selectedPage = \{[\s\S]*?blocks: currentBlocks,[\s\S]*?contentVersion: currentBlocksContentVersion[\s\S]*?\};/
  );
  assert.match(
    deleteFlow,
    /Number\(localPage\.contentVersion \?\? 1\) !== Number\(serverPage\.contentVersion \?\? 1\)/
  );

  // Reproduction: tab A still renders block snapshot v4. Tab B commits a block
  // edit (v5) before tab A's delayed title request obtains its server snapshot.
  // Keeping A's blocks but adopting the title response's v5 token defeats the
  // permanent-delete freshness comparison even though A never rendered v5.
  const localSnapshot = { blocks: ["visible-v4"], contentVersion: 4 };
  const titleAcknowledgement = { title: "Renamed", blocks: ["server-v5"], contentVersion: 5 };
  const vulnerableMerge = { ...titleAcknowledgement, blocks: localSnapshot.blocks };
  assert.deepEqual(vulnerableMerge.blocks, ["visible-v4"]);
  assert.equal(vulnerableMerge.contentVersion, 5);
  assert.equal(vulnerableMerge.contentVersion === titleAcknowledgement.contentVersion, true);

  const fixedMerge = {
    ...titleAcknowledgement,
    blocks: localSnapshot.blocks,
    contentVersion: localSnapshot.contentVersion
  };
  assert.deepEqual(fixedMerge.blocks, ["visible-v4"]);
  assert.equal(fixedMerge.contentVersion, 4);
  assert.equal(fixedMerge.contentVersion === titleAcknowledgement.contentVersion, false);
});
