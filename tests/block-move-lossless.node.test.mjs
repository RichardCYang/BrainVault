import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [routes, app, index, i18n, baseline, migration] = await Promise.all([
  readFile(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/i18n.js", import.meta.url), "utf8"),
  readFile(new URL("../migrations/001_init.sql", import.meta.url), "utf8"),
  readFile(new URL("../migrations/063_block_move_mutation_receipts.sql", import.meta.url), "utf8")
]);

function moveRouteSource() {
  const normalizedRoutes = routes.replace(/\r\n/g, "\n");
  const start = normalizedRoutes.indexOf('blockRouter.post(\n  "/blocks/:blockId/move"');
  const end = normalizedRoutes.indexOf('blockRouter.delete(\n  "/blocks/:blockId"', start);
  assert.ok(start >= 0, "block move route must exist");
  assert.ok(end > start, "block move route must be bounded before delete route");
  return normalizedRoutes.slice(start, end);
}

test("block handle menu exposes an accessible move-to-page dialog", () => {
  assert.match(index, /data-action="move-block-to-page"/);
  assert.match(index, /id="block-move-dialog"/);
  assert.match(index, /id="block-move-page-select"/);
  assert.match(index, /data-i18n="menu\.moveBlock"/);
  assert.match(i18n, /moveBlock: "다른 페이지로 이동하기"/);
  assert.match(i18n, /title: "다른 페이지로 이동하기"/);
});

test("client move flow drains writers, snapshots the whole subtree, and retries idempotently", () => {
  assert.match(app, /withPagePersistenceTransition\(pageId, "block-move"/);
  assert.match(app, /getBlockVersionSnapshot\(blockId, \{ includeDescendants: true \}\)/);
  assert.match(app, /assertNoPendingLocalBlockDrafts\(/);
  assert.match(app, /pendingBlockMoveTasks/);
  assert.match(app, /submitWithFreshMutationIdOnReuse\(task/);
  assert.match(app, /\/api\/blocks\/\$\{encodeURIComponent\(task\.blockId\)\}\/move/);
  assert.match(app, /!isPageOwner\(state\.selectedPage\) \|\| isCollaborativePage\(state\.selectedPage\)/);
});

test("server moves existing rows atomically instead of delete-and-recreate", () => {
  const move = moveRouteSource();
  assert.doesNotMatch(move, /DELETE\s+FROM\s+blocks/i);
  assert.doesNotMatch(move, /INSERT\s+INTO\s+blocks/i);

  const authBoundary = move.indexOf("assertCurrentAuthSessionBoundary");
  const detach = move.indexOf("UPDATE blocks SET parent_block_id = NULL");
  const changePage = move.indexOf("UPDATE blocks SET page_id = ?");
  const restoreHierarchy = move.indexOf("SET parent_block_id = ?, sort_order = ?");
  const integrityCheck = move.indexOf("assertMovedBlockDataPreserved(");
  assert.ok(authBoundary >= 0 && detach > authBoundary, "auth/session boundary must be revalidated before durable move writes");
  assert.ok(detach >= 0 && changePage > detach, "subtree must detach before page_id changes");
  assert.ok(restoreHierarchy > changePage, "hierarchy must be restored only after every row is on the target page");
  assert.ok(integrityCheck > restoreHierarchy, "server must verify preserved data after hierarchy restoration");

  assert.match(move, /sourceAccess\.page\.owner_id !== targetAccess\.page\.owner_id/);
  assert.match(move, /assertDirectBlockMutationAllowed\(sourceAccess\)/);
  assert.match(move, /assertDirectBlockMutationAllowed\(targetAccess\)/);
  assert.match(move, /source: "BLOCK_MOVE_OUT"/);
  assert.match(move, /source: "BLOCK_MOVE_IN"/);
  assert.match(move, /INSERT INTO block_move_mutations/);
  const receiptCheck = move.indexOf("FROM block_move_mutations");
  const currentIdentity = move.indexOf("const currentIdentity = await assertAccessibleBlock");
  const samePageGuard = move.indexOf("BLOCK_MOVE_SAME_PAGE");
  assert.ok(receiptCheck >= 0 && currentIdentity > receiptCheck && samePageGuard > receiptCheck,
    "response-loss replay must resolve its receipt before inspecting the block's new page");
});

test("post-move integrity guard compares authoritative content and hierarchy", () => {
  assert.match(routes, /contentFields = \["type", "markdown", "html_cache", "checked", "created_at"\]/);
  assert.match(routes, /comparableBlockMetadata\(after!\.metadata\) === comparableBlockMetadata\(before\.metadata\)/);
  assert.match(routes, /after!\.page_id === targetPageId/);
  assert.match(routes, /after!\.parent_block_id === expectedParentId/);
  assert.match(routes, /after!\.edit_version \?\? 1\) === Number\(before\.edit_version \?\? 1\) \+ 1/);
});

test("mutation receipts survive page recreation and do not cascade with page deletion", () => {
  for (const sql of [baseline, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS block_move_mutations/i);
    assert.match(sql, /PRIMARY KEY \(actor_id, mutation_id\)/i);
    assert.match(sql, /moved_block_ids JSON NOT NULL/i);
    assert.match(sql, /fk_block_move_mutations_actor[\s\S]*REFERENCES users\(id\) ON DELETE CASCADE/i);
    const table = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS block_move_mutations"));
    assert.doesNotMatch(table.split("ENGINE=InnoDB", 1)[0], /REFERENCES pages\(id\)/i);
  }
});
