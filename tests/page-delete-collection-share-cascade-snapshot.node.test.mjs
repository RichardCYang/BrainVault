import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function legacyCollectionRows(page, memberships, shares) {
  const membership = memberships.find((row) => row.page_id === page.id);
  if (!membership) return [];
  return shares
    .filter((share) => share.collection_id === membership.collection_id)
    .map((share) => ({
      page_id: page.id,
      user_id: share.user_id,
      permission: `COLLECTION:${share.permission}`,
      generation: share.generation
    }));
}

function directCollectionRows(page, shares) {
  if (!page.is_collection) return [];
  return shares
    .filter((share) => share.collection_id === page.id)
    .map((share) => ({
      page_id: page.id,
      user_id: share.user_id,
      permission: `COLLECTION:${share.permission}`,
      generation: share.generation
    }));
}

test("collection grants remain visible to deletion snapshots when self-membership is missing", () => {
  // Reproduction:
  // 1. A legacy/inconsistent collection page exists without its self-membership row.
  // 2. The owner creates a collection grant; collection_shares still references pages(id) directly.
  // 3. A permanent-delete preview taken before that grant is later submitted.
  // 4. Join-only grant discovery sees no membership and therefore no grant change, while
  //    deleting the collection page cascades the newly committed grant.
  const collection = { id: "collection_a", is_collection: true };
  const memberships = [];
  const grants = [{
    collection_id: "collection_a",
    user_id: "user_2",
    permission: "WRITE",
    generation: "cshare_new"
  }];

  assert.deepEqual(legacyCollectionRows(collection, memberships, grants), []);
  assert.deepEqual(directCollectionRows(collection, grants), [{
    page_id: "collection_a",
    user_id: "user_2",
    permission: "COLLECTION:WRITE",
    generation: "cshare_new"
  }]);
});

test("page deletion reads collection-root grants directly as a cascading dependency", () => {
  const route = readFileSync(
    new URL("../src/routes/page.routes.ts", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const start = route.indexOf("async function getPageDeletionShares(");
  const end = route.indexOf("async function getPageDeletionCollaborationStates(", start);
  assert.ok(start >= 0 && end > start);
  const helper = route.slice(start, end);

  assert.match(helper, /page\.is_collection/);
  assert.match(helper, /FROM collection_shares cs/);
  assert.match(helper, /WHERE cs\.collection_id = \?/);
  assert.match(helper, /FROM page_collection_memberships pcm/);
  assert.match(helper, /\$\{lock \? " FOR UPDATE" : ""\}/);
});
