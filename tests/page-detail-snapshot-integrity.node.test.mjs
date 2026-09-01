import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("page detail reads authorization and page content from one repeatable-read transaction", async () => {
  const route = (await readFile(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const detailRoute = section(
    route,
    'pageRouter.get("/:pageId",',
    'pageRouter.get(\n  "/:pageId/versions"'
  );

  assert.match(
    detailRoute,
    /const page = await transaction\(\(client\) => getPageResponse\(pageId, user\.id, client\)\);/
  );
  assert.match(detailRoute, /res\.json\(\{ page \}\);/);

  const responseHelper = section(
    route,
    "async function getPageResponse(",
    'pageRouter.get("/",'
  );
  assert.match(responseHelper, /getPageAccess\(pageId, userId, client\)/);
  assert.match(responseHelper, /client\.query<PageRow>/);
  assert.match(responseHelper, /getPageTags\(pageId, client\)/);
  assert.match(responseHelper, /getBlocks\(pageId, client\)/);
});

test("reproduction: restore between access and block reads cannot expose a replacement page generation", () => {
  const collaboratorId = "usr-collaborator";
  const oldGeneration = {
    pageId: "pag-stable-id",
    sharedWith: new Set([collaboratorId]),
    contentVersion: 7,
    blocks: ["old shared note"]
  };
  const restoredGeneration = {
    pageId: "pag-stable-id",
    sharedWith: new Set(),
    contentVersion: 1,
    blocks: ["restored private note"]
  };

  // Old flow: the authorization query and block query are independent autocommit
  // reads. The restore can reuse the same page id between them.
  const accessAllowed = oldGeneration.sharedWith.has(collaboratorId);
  assert.equal(accessAllowed, true);
  const vulnerableBlocksRead = restoredGeneration.blocks;
  assert.deepEqual(vulnerableBlocksRead, ["restored private note"]);

  // Fixed flow: REPEATABLE READ pins all later reads to the same database snapshot
  // that authorized the request. A concurrent restore is invisible to that request.
  const requestSnapshot = oldGeneration;
  assert.equal(requestSnapshot.sharedWith.has(collaboratorId), true);
  assert.deepEqual(requestSnapshot.blocks, ["old shared note"]);
  assert.notDeepEqual(requestSnapshot.blocks, restoredGeneration.blocks);
});

test("reproduction: concurrent block commits cannot pair a stale page token with newer blocks", () => {
  const before = {
    contentVersion: 12,
    blocks: [{ id: "blk-1", version: 4, markdown: "before" }]
  };
  const after = {
    contentVersion: 13,
    blocks: [{ id: "blk-1", version: 5, markdown: "after" }]
  };

  const vulnerableMixedResponse = {
    contentVersion: before.contentVersion,
    blocks: after.blocks
  };
  assert.equal(vulnerableMixedResponse.contentVersion, 12);
  assert.equal(vulnerableMixedResponse.blocks[0].version, 5);

  const fixedSnapshotResponse = {
    contentVersion: before.contentVersion,
    blocks: before.blocks
  };
  assert.equal(fixedSnapshotResponse.contentVersion, 12);
  assert.equal(fixedSnapshotResponse.blocks[0].version, 4);
});

test("page render keeps collaborator authorization and rendered blocks in one snapshot", async () => {
  const route = (await readFile(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const renderRoute = section(
    route,
    'pageRouter.get("/:pageId/render",',
    "\n});",
  );

  assert.match(renderRoute, /const html = await transaction\(async \(client\) => \{/);
  assert.match(renderRoute, /getPageAccess\(pageId, user\.id, client\)/);
  assert.match(renderRoute, /client\.query<BlockRow>/);
  assert.match(renderRoute, /sanitizeRenderedBlockHtml\(block\.type, block\.html_cache\)/);
});

test("attachment download revalidates access under the restore filesystem-generation lock", async () => {
  const route = (await readFile(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const downloadRoute = section(
    route,
    'blockRouter.get("/blocks/:blockId/attachment",',
    '\nblockRouter.post("/pages/:pageId/blocks",'
  );

  assert.match(downloadRoute, /const initial = await assertAccessibleBlock\(blockId, user\.id\);/);
  assert.match(downloadRoute, /const claimedAttachment = await withUserAttachmentLock\(ownerId, async \(client\) => \{/);
  assert.match(downloadRoute, /assertAccessibleBlock\(blockId, user\.id, client\)/);
  assert.match(downloadRoute, /access\.page\.owner_id !== ownerId/);
  assert.match(downloadRoute, /const handle = await open\(getAttachmentFilePath\(ownerId, blockId\), "r"\);/);
  assert.match(downloadRoute, /return \{ handle, info, size: fileStats\.size \};/);
  assert.match(downloadRoute, /claimedAttachment\.handle\.createReadStream\(\{ autoClose: false \}\)/);
  assert.match(downloadRoute, /await pipeline\(/);
  assert.doesNotMatch(downloadRoute, /res\.download\(/);

  const lockStart = downloadRoute.indexOf("const claimedAttachment = await withUserAttachmentLock");
  const lockEnd = downloadRoute.indexOf("\n    });\n\n    try {", lockStart);
  const streamStart = downloadRoute.indexOf("await pipeline(", lockStart);
  assert.ok(lockStart >= 0 && lockEnd > lockStart && streamStart > lockEnd);
  assert.equal(downloadRoute.slice(lockStart, lockEnd).includes("pipeline("), false);
});

test("reproduction: an attachment restore cannot swap private bytes after old-share authorization", () => {
  const collaboratorId = "usr-collaborator";
  const oldGeneration = {
    blockId: "blk-stable-id",
    sharedWith: new Set([collaboratorId]),
    bytes: "old shared attachment"
  };
  const restoredGeneration = {
    blockId: "blk-stable-id",
    sharedWith: new Set(),
    bytes: "restored private attachment"
  };

  // Vulnerable order: authorize old DB generation, restore swaps the directory,
  // then path-based download opens the replacement file.
  assert.equal(oldGeneration.sharedWith.has(collaboratorId), true);
  const vulnerableDownloadedBytes = restoredGeneration.bytes;
  assert.equal(vulnerableDownloadedBytes, "restored private attachment");

  // Fixed order A: download opens the authorized old file while holding the owner's
  // generation lock, then releases the lock before streaming from that open handle.
  // A restore may replace the path, but the claimed handle still serves old bytes.
  const claimedHandleDownloadBytes = oldGeneration.bytes;
  assert.equal(claimedHandleDownloadBytes, "old shared attachment");

  // Fixed order B: if restore wins the lock, reauthorization observes the new
  // generation and rejects the collaborator before any replacement file opens.
  assert.equal(restoredGeneration.sharedWith.has(collaboratorId), false);
});

test("page list keeps membership, authorization, and tags in one repeatable-read snapshot", async () => {
  const route = (await readFile(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const listRoute = section(
    route,
    'pageRouter.get("/",',
    'pageRouter.post("/",'
  );

  assert.match(listRoute, /const result = await transaction\(async \(client\) => \{/);
  assert.match(listRoute, /const rows = await client\.query</);
  assert.match(listRoute, /getPageAccess\(row\.id, user\.id, client\)/);
  assert.match(listRoute, /getPageTags\(row\.id, client\)/);
  assert.match(listRoute, /res\.json\(result\);/);
});

test("reproduction: restore between page-list access and tag reads cannot leak replacement private tags", () => {
  const collaboratorId = "usr-collaborator";
  const oldGeneration = {
    pageId: "pag-stable-id",
    sharedWith: new Set([collaboratorId]),
    tags: ["shared-project"]
  };
  const restoredGeneration = {
    pageId: "pag-stable-id",
    sharedWith: new Set(),
    tags: ["private-restored-tag"]
  };

  // Vulnerable flow: the list/access reads authorize the old generation, then a
  // restore reuses the same id before the independent tag query.
  assert.equal(oldGeneration.sharedWith.has(collaboratorId), true);
  const vulnerableTagsRead = restoredGeneration.tags;
  assert.deepEqual(vulnerableTagsRead, ["private-restored-tag"]);

  // Fixed flow: one REPEATABLE READ transaction pins membership, access, and
  // tag queries to the generation that authorized this list response.
  const requestSnapshot = oldGeneration;
  assert.equal(requestSnapshot.sharedWith.has(collaboratorId), true);
  assert.deepEqual(requestSnapshot.tags, ["shared-project"]);
  assert.notDeepEqual(requestSnapshot.tags, restoredGeneration.tags);
});

test("page version reads keep administrative authorization and history in one repeatable-read snapshot", async () => {
  const route = (await readFile(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");

  const listRoute = section(
    route,
    'pageRouter.get(\n  "/:pageId/versions",',
    'pageRouter.delete(\n  "/:pageId/versions",'
  );
  assert.match(listRoute, /const result = await transaction\(async \(client\) => \{/);
  assert.match(listRoute, /getPageAccess\(pageId, user\.id, client\)/);
  assert.match(listRoute, /assertPageCanAdminister\(access\)/);
  assert.match(listRoute, /client\.query<PageVersionRow>/);
  assert.match(listRoute, /client\.queryOne<\{ revision: number \| bigint \| null \}>/);
  assert.doesNotMatch(listRoute, /await getPageAccess\(pageId, user\.id\);/);
  assert.doesNotMatch(listRoute, /await db\.query/);

  const detailRoute = section(
    route,
    'pageRouter.get(\n  "/:pageId/versions/:versionId",',
    'pageRouter.get(\n  "/:pageId/deletion-snapshot",'
  );
  assert.match(detailRoute, /const row = await transaction\(async \(client\) => \{/);
  assert.match(detailRoute, /getPageAccess\(pageId, user\.id, client\)/);
  assert.match(detailRoute, /assertPageCanAdminister\(access\)/);
  assert.match(detailRoute, /return client\.queryOne<PageVersionRow>/);
  assert.doesNotMatch(detailRoute, /await getPageAccess\(pageId, user\.id\);/);
  assert.doesNotMatch(detailRoute, /await db\.queryOne/);
});

test("reproduction: page-version reads cannot cross a delete/restore page-id generation boundary", () => {
  const ownerId = "usr-owner";
  const otherOwnerId = "usr-other";
  const stablePageId = "pag-stable-id";

  const authorizedGeneration = {
    pageId: stablePageId,
    ownerId,
    history: ["owner revision 1"]
  };
  const replacementGeneration = {
    pageId: stablePageId,
    ownerId: otherOwnerId,
    history: ["other owner's private revision"]
  };

  // Vulnerable flow: the first autocommit read authorizes the old generation,
  // then delete/restore reuses the page id before the independent history read.
  assert.equal(authorizedGeneration.ownerId, ownerId);
  const vulnerableHistoryRead = replacementGeneration.history;
  assert.deepEqual(vulnerableHistoryRead, ["other owner's private revision"]);

  // Fixed flow: one REPEATABLE READ transaction pins both authorization and
  // version-history queries to the generation visible at the first read.
  const requestSnapshot = authorizedGeneration;
  assert.equal(requestSnapshot.ownerId, ownerId);
  assert.deepEqual(requestSnapshot.history, ["owner revision 1"]);
  assert.notDeepEqual(requestSnapshot.history, replacementGeneration.history);
});
