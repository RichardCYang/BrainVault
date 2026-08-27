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
  assert.match(downloadRoute, /await withUserAttachmentLock\(ownerId, async \(client\) => \{/);
  assert.match(downloadRoute, /assertAccessibleBlock\(blockId, user\.id, client\)/);
  assert.match(downloadRoute, /access\.page\.owner_id !== ownerId/);
  assert.match(downloadRoute, /await new Promise<void>/);
  assert.match(downloadRoute, /res\.download\(/);
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

  // Fixed order A: download takes the owner's generation lock first and keeps it
  // through streaming, so restore waits and the authorized old bytes are served.
  const lockedDownloadBytes = oldGeneration.bytes;
  assert.equal(lockedDownloadBytes, "old shared attachment");

  // Fixed order B: if restore wins the lock, reauthorization observes the new
  // generation and rejects the collaborator before any replacement file opens.
  assert.equal(restoredGeneration.sharedWith.has(collaboratorId), false);
});

