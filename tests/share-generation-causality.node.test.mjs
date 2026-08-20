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

test("stale collaborator revocation cannot delete a replacement grant", () => {
  // Reproduction model:
  // 1. Tab A reads grant G1 and starts a delayed remove request.
  // 2. Tab B removes G1 and re-adds the same user as G2.
  // 3. A delete keyed only by page/user removes G2; a generation-fenced delete does not.
  const pageId = "page_1";
  const userId = "user_1";
  const delayedIntent = { pageId, userId, generation: "share_g1" };
  let currentGrant = { pageId, userId, generation: "share_g2" };

  const vulnerableMatches =
    currentGrant.pageId === delayedIntent.pageId
    && currentGrant.userId === delayedIntent.userId;
  assert.equal(vulnerableMatches, true);
  if (vulnerableMatches) currentGrant = null;
  assert.equal(currentGrant, null, "the old page/user-only predicate deletes the replacement grant");

  currentGrant = { pageId, userId, generation: "share_g2" };
  const fixedMatches =
    currentGrant.pageId === delayedIntent.pageId
    && currentGrant.userId === delayedIntent.userId
    && currentGrant.generation === delayedIntent.generation;
  assert.equal(fixedMatches, false);
  assert.deepEqual(currentGrant, { pageId, userId, generation: "share_g2" });
});

test("share removal is owner-scoped and generation-fenced before destructive recovery work", () => {
  const source = read("../src/routes/collaboration.routes.ts");
  const route = section(
    source,
    'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"',
    'collaborationRouter.post(\n  "/recovery/pages/:pageId/candidates"'
  );

  assert.match(route, /validate\(\{ params: shareParamsSchema, body: removeShareSchema \}\)/);
  assert.match(route, /const expectedGeneration = String\(req\.body\.expectedGeneration\)/);

  const ownerLock = route.indexOf("SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE");
  const shareLock = route.indexOf("SELECT user_id, generation FROM page_shares");
  const generationFence = route.indexOf("existingShare.generation !== expectedGeneration");
  const recoveryGrant = route.indexOf("await grantDirectPageRecovery");
  const destructiveDelete = route.indexOf("DELETE FROM page_shares");

  assert.ok(ownerLock >= 0, "page ownership must be rechecked server-side");
  assert.ok(shareLock > ownerLock, "share lookup must happen only after owner-scoped page lock");
  assert.ok(generationFence > shareLock, "current grant generation must be compared");
  assert.ok(recoveryGrant > generationFence, "stale intents must fail before recovery side effects");
  assert.ok(destructiveDelete > recoveryGrant);
  assert.match(route, /permission = 'EDIT' AND generation = \?/);
  assert.match(route, /\[pageId, sharedUserId, expectedGeneration\]/);
  assert.match(route, /"PAGE_SHARE_GENERATION_CHANGED"/);
});

test("new and restored shares receive fresh generations, and clients send the displayed generation", () => {
  const routeSource = read("../src/routes/collaboration.routes.ts");
  const transferSource = read("../src/lib/data-transfer.ts");
  const appSource = read("../public/app.js");
  const migration = read("../migrations/061_page_share_generation.sql");

  assert.match(routeSource, /const shareGeneration = createId\("share"\)/);
  assert.match(routeSource, /sharedAt: row\.shared_at,\n\s+generation: row\.share_generation/);
  assert.match(
    transferSource,
    /INSERT INTO page_shares \(page_id, user_id, permission, shared_by, generation, created_at\)/
  );
  assert.match(
    transferSource,
    /\[share\.pageId, share\.userId, share\.permission, userId, createId\("share"\), share\.createdAt\]/
  );

  assert.match(appSource, /remove\.dataset\.generation = share\.generation \?\? ""/);
  assert.match(appSource, /body: \{ expectedGeneration \}/);

  assert.match(migration, /ADD COLUMN IF NOT EXISTS generation VARCHAR\(64\) NULL/);
  assert.match(migration, /WHERE generation IS NULL OR generation = ''/);
  assert.match(migration, /MODIFY COLUMN generation VARCHAR\(64\) NOT NULL/);
});

test("workspace restore fingerprint treats share generation as causal state", () => {
  const transferSource = read("../src/lib/data-transfer.ts");
  const snapshot = section(
    transferSource,
    "async function createWorkspaceRestoreSnapshot",
    "function invalidBackup("
  );

  assert.match(snapshot, /ps\.shared_by, ps\.generation,/);
  assert.match(
    snapshot,
    /`share\\0\$\{share\.page_id\}\\0\$\{share\.user_id\}\\0\$\{share\.permission\}\\0\$\{share\.shared_by\}\\0\$\{share\.generation\}\\0\$\{share\.shared_at\}\\n`/
  );

  // Reproduction model: a grant can be replaced without changing legacy fingerprint fields.
  // The generation is the causal identity that must make the restore snapshot change.
  const base = {
    pageId: "page_1",
    userId: "user_1",
    permission: "EDIT",
    sharedBy: "owner_1",
    sharedAt: "2026-08-20 23:28:01.123000",
  };
  const before = { ...base, generation: "share_g1" };
  const after = { ...base, generation: "share_g2" };
  const legacyKey = (share) =>
    [share.pageId, share.userId, share.permission, share.sharedBy, share.sharedAt].join("\\0");
  const fixedKey = (share) =>
    [share.pageId, share.userId, share.permission, share.sharedBy, share.generation, share.sharedAt].join("\\0");

  assert.equal(legacyKey(before), legacyKey(after));
  assert.notEqual(fixedKey(before), fixedKey(after));
});

test("share UI continues to use safe text sinks for collaborator-controlled labels", () => {
  const appSource = read("../public/app.js");
  const render = section(
    appSource,
    "function renderSharePageList()",
    "function isCurrentSharePageRequest("
  );

  assert.match(render, /name\.textContent = share\.user\?\.name/);
  assert.match(render, /meta\.textContent = `@\$\{share\.user\?\.username\}/);
  assert.doesNotMatch(render, /\.innerHTML\s*=/);
  assert.doesNotMatch(render, /insertAdjacentHTML/);
});
