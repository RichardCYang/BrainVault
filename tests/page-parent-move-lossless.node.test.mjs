import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8");
const patchStart = route.indexOf('pageRouter.patch("/:pageId"');
const deleteStart = route.indexOf('pageRouter.delete(', patchStart);
const patchRoute = route.slice(patchStart, deleteStart);

test("page parent move is an in-place hierarchy mutation guarded by owner-wide row locks and optimistic versioning", () => {
  assert.ok(patchStart >= 0 && deleteStart > patchStart, "page PATCH route must be discoverable");
  assert.match(patchRoute, /fields\.push\("parent_page_id = \?"\)/);
  assert.match(patchRoute, /values\.push\(updates\.parentPageId\)/);
  assert.match(patchRoute, /getOwnedPageTreeRows\(user\.id, client, true\)/);
  assert.match(patchRoute, /assertPageParentFromLockedRows\(pageId, updates\.parentPageId, lockedRows\)/);
  assert.ok(
    patchRoute.indexOf("isMatchingMutationReplay") < patchRoute.indexOf("assertPageParentFromLockedRows"),
    "exact response-loss replays must resolve before mutable destination validation"
  );
  assert.match(patchRoute, /WHERE id = \? AND owner_id = \? AND edit_version = \?/);
  assert.match(patchRoute, /edit_version = edit_version \+ 1/);
});

test("page parent move does not rewrite page content or child records", () => {
  assert.doesNotMatch(patchRoute, /UPDATE\s+blocks\b/i);
  assert.doesNotMatch(patchRoute, /DELETE\s+FROM\s+blocks\b/i);
  assert.doesNotMatch(patchRoute, /INSERT\s+INTO\s+blocks\b/i);
  assert.doesNotMatch(patchRoute, /UPDATE\s+page_shares\b/i);
  assert.doesNotMatch(patchRoute, /DELETE\s+FROM\s+page_shares\b/i);
  assert.doesNotMatch(patchRoute, /UPDATE\s+pages\s+SET[\s\S]*?WHERE\s+parent_page_id\s*=\s*\?/i);
  assert.match(patchRoute, /recordPageVersion\(client, \{/);
});

test("server rejects invalid page-move destinations before applying a parent update", () => {
  assert.match(route, /throw new ApiError\(400, "INVALID_PARENT_PAGE", "Parent page does not exist"\)/);
  assert.match(route, /if \(parent\.is_archived\)/);
  assert.match(
    route,
    /throw new ApiError\(409, "PARENT_PAGE_ARCHIVED", "Restore the destination page before moving this page"\)/
  );
  assert.match(route, /if \(parent\.is_collection\)/);
  assert.match(
    route,
    /throw new ApiError\(400, "INVALID_PARENT_PAGE", "A collection cannot be used as a page-move destination"\)/
  );
  assert.match(route, /throw new ApiError\(400, "INVALID_PARENT_PAGE", "Page hierarchy cannot contain a cycle"\)/);
  assert.match(route, /if \(existingPage\.is_collection && updates\.parentPageId\)/);
});
