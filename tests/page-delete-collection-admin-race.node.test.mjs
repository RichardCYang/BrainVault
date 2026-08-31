import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const route = readFileSync(path.join(root, "src/routes/page.routes.ts"), "utf8").replace(/\r\n/g, "\n");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("permanent collection-admin deletion authorizes only after current page locking", () => {
  const helper = section(route, "async function lockPageDeleteUsers", "type PageDeletionPageRow");
  assert.match(helper, /\[\.\.\.new Set\(userIds\)\]\.sort\(\)/);
  assert.match(helper, /ORDER BY id ASC[\s\S]*FOR UPDATE/);

  const deleteRoute = section(
    route,
    'pageRouter.delete(\n  "/:pageId"',
    'pageRouter.put("/:pageId/tags"'
  );
  const ownerHint = deleteRoute.indexOf("const pageOwnerHint = await db.queryOne");
  const transactionStart = deleteRoute.indexOf("const deletion = await transaction");
  const userLocks = deleteRoute.indexOf("await lockPageDeleteUsers", transactionStart);
  const receiptLookup = deleteRoute.indexOf("FROM page_delete_mutations", transactionStart);
  const missingHintCheck = deleteRoute.indexOf('if (!pageOwnerHint) throw notFound("Page")', transactionStart);
  const lockedAuthorization = deleteRoute.indexOf(
    "getPageAccess(pageId, user.id, client, { lockPage: true })",
    transactionStart
  );

  assert.ok(ownerHint >= 0 && ownerHint < transactionStart, "owner preflight must stay outside the RR transaction");
  assert.ok(userLocks > transactionStart && userLocks < receiptLookup, "all user rows must be locked before receipt/page work");
  assert.ok(receiptLookup < missingHintCheck, "a committed deletion receipt must replay even after the page is gone");
  assert.ok(missingHintCheck < lockedAuthorization, "a fresh deletion must perform current locked authorization");
  assert.equal(
    deleteRoute.slice(transactionStart, lockedAuthorization).includes('"SELECT owner_id FROM pages WHERE id = ?"'),
    false,
    "no plain page read may establish a stale authorization snapshot inside the transaction"
  );
  assert.match(deleteRoute, /workspaceOwnerId !== pageOwnerHint\.owner_id/);
  assert.match(deleteRoute, /assertPageCanAdminister\(deletionAccess\)/);
});

test("race reproducer rejects stale ADMIN and eliminates reciprocal user-lock cycles", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(root, "scripts/reproduce-page-delete-collection-admin-races.mjs")],
    { encoding: "utf8" }
  );
  const report = JSON.parse(output);
  assert.equal(report.authorizationRace.vulnerable.authorized, true);
  assert.equal(report.authorizationRace.fixed.authorized, false);
  assert.equal(report.authorizationRace.fixed.currentGrant, null);
  assert.equal(report.reciprocalAdminDeletes.vulnerable.deadlock, true);
  assert.equal(report.reciprocalAdminDeletes.fixed.deadlock, false);
  assert.deepEqual(
    report.reciprocalAdminDeletes.fixed.firstDelete,
    report.reciprocalAdminDeletes.fixed.secondDelete
  );
});
