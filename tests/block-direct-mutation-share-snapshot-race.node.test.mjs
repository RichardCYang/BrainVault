import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(text, start, end = null) {
  const startIndex = text.indexOf(start);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  const endIndex = end === null ? text.length : text.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing section end after: ${start}`);
  return text.slice(startIndex, endIndex);
}

test("locking page access can refresh every mutable authorization/scope dependency", () => {
  const access = source("src/lib/page-access.ts");
  const getAccess = section(access, "export async function getPageAccess(", "export async function getOwnedPage(");

  assert.match(
    getAccess,
    /\{ lockPage = false, lockAccess = false \}: \{ lockPage\?: boolean; lockAccess\?: boolean \}/
  );
  assert.match(
    getAccess,
    /FROM page_collection_memberships\s+WHERE page_id = \?\$\{lockAccess \? " FOR UPDATE" : ""\}/
  );
  assert.match(
    getAccess,
    /FROM collection_shares\s+WHERE collection_id = \? AND user_id = \?\$\{lockAccess \? " FOR UPDATE" : ""\}/
  );
  assert.match(
    getAccess,
    /FROM page_shares\s+WHERE page_id = \? AND user_id = \? AND permission = 'EDIT'\$\{lockAccess \? " FOR UPDATE" : ""\}/
  );
  assert.match(
    getAccess,
    /getEffectivePageShareCount\(pageId, client, collectionId, \{ lock: lockAccess \}\)/
  );
});

test("direct block update and delete refresh authorization after taking the current page lock", () => {
  const routes = source("src/routes/block.routes.ts");
  const update = section(
    routes,
    'blockRouter.patch("/blocks/:blockId"',
    'blockRouter.post(\n  "/blocks/:blockId/move"'
  );
  const deletion = section(routes, 'blockRouter.delete(\n  "/blocks/:blockId"');

  assert.match(
    update,
    /getPageAccess\(identity\.page_id, user\.id, client, \{ lockPage: true, lockAccess: true \}\)/
  );
  assert.match(
    deletion,
    /getPageAccess\(block\.page_id, user\.id, client, \{ lockPage: true, lockAccess: true \}\)/
  );
});

test("cross-page block move locks all page rows before current grant rows", () => {
  const routes = source("src/routes/block.routes.ts");
  const helper = section(routes, "async function lockMovePages(", "blockRouter.post(\n  \"/pages/:pageId/attachments\"");

  const pageLockIndex = helper.indexOf("SELECT id FROM pages");
  const accessIndex = helper.indexOf("await getPageAccess(");
  assert.ok(pageLockIndex >= 0 && accessIndex > pageLockIndex);
  assert.match(helper, /ORDER BY id ASC\s+FOR UPDATE/);
  assert.match(
    helper,
    /getPageAccess\(pageId, userId, client, \{ lockPage: true, lockAccess: true \}\)/
  );
});

test("reproduction model: stale share mode can admit a direct write, while current locking access rejects it", () => {
  const decide = ({ canEdit, shareCount }) => canEdit && shareCount === 0 ? "MUTATED" : "REJECTED";

  const privateSnapshot = { canEdit: true, shareCount: 0 };
  const afterConcurrentShare = { canEdit: true, shareCount: 1 };
  assert.equal(decide(privateSnapshot), "MUTATED");
  assert.equal(decide(afterConcurrentShare), "REJECTED");

  // Refreshing only the share count would create a second hazard after a
  // collaborator's sole grant is revoked: stale EDITOR + current zero shares.
  const staleRevokedRoleWithCurrentShareCount = { canEdit: true, shareCount: 0 };
  const currentRevokedAccess = { canEdit: false, shareCount: 0 };
  assert.equal(decide(staleRevokedRoleWithCurrentShareCount), "MUTATED");
  assert.equal(decide(currentRevokedAccess), "REJECTED");
});
