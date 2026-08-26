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

test("page create resolves durable replays before validating mutable parent state", async () => {
  const route = (await readFile(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const createRoute = section(route, 'pageRouter.post("/",', 'pageRouter.get("/:pageId/cover"');

  const transactionIndex = createRoute.indexOf("const page = await transaction");
  const replayIndex = createRoute.indexOf("return getPageResponse(assessment.pageId, user.id, client);");
  const parentValidationIndex = createRoute.indexOf(
    "await assertOwnedParentPage(creation.parentPageId, user.id, client, true);"
  );
  const insertIndex = createRoute.indexOf("INSERT INTO pages");

  assert.ok(transactionIndex >= 0, "page creation must use a transaction");
  assert.ok(replayIndex > transactionIndex, "the receipt replay must be resolved inside the transaction");
  assert.ok(
    parentValidationIndex > replayIndex,
    "an exact committed replay must not depend on the original parent still existing"
  );
  assert.ok(
    parentValidationIndex < insertIndex,
    "fresh page creation must revalidate its parent before inserting the page"
  );
  assert.doesNotMatch(
    createRoute.slice(0, transactionIndex),
    /await assertOwnedParentPage\(/,
    "mutable parent state must not be validated before receipt replay is checked"
  );

  const helper = section(
    route,
    "async function assertOwnedParentPage(",
    "async function getPageTags("
  );
  assert.match(helper, /\$\{lock \? " FOR UPDATE" : ""\}/);
  assert.match(helper, /SELECT id, is_archived, is_collection FROM pages/);
  assert.match(helper, /if \(parent\.is_archived\)/);
  assert.match(helper, /PARENT_PAGE_ARCHIVED/);
  assert.match(helper, /if \(parent\.is_collection\)/);
  assert.match(helper, /A collection cannot be used as a page-create destination/);
});

test("response-loss replay stays idempotent after the original parent is removed", () => {
  const mutationId = "create-child-1";
  const pageId = "pag_child";
  const requestHash = "same-request";
  const state = {
    parents: new Set(),
    pages: new Set([pageId]),
    receipts: new Map([[mutationId, { pageId, requestHash }]])
  };

  function vulnerableReplay() {
    if (!state.parents.has("pag_parent")) throw new Error("INVALID_PARENT_PAGE");
    const receipt = state.receipts.get(mutationId);
    return receipt?.requestHash === requestHash ? receipt.pageId : null;
  }

  function fixedReplay() {
    const receipt = state.receipts.get(mutationId);
    if (receipt?.requestHash === requestHash && state.pages.has(receipt.pageId)) return receipt.pageId;
    if (!state.parents.has("pag_parent")) throw new Error("INVALID_PARENT_PAGE");
    return null;
  }

  assert.throws(vulnerableReplay, /INVALID_PARENT_PAGE/);
  assert.equal(fixedReplay(), pageId);
});
