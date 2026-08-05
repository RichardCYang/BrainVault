import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createPageCoverOperationGuard,
  isPageCoverPositionDraftForPage
} from "../public/page-cover-operation.js";

test("page-cover operations remain bound to their originating page and latest intent", () => {
  const guard = createPageCoverOperationGuard();
  const first = guard.begin("page-one");
  assert.equal(guard.isCurrent(first, "page-one"), true);
  assert.equal(guard.isCurrent(first, "page-two"), false);

  const replacement = guard.begin("page-one");
  assert.equal(guard.isCurrent(first, "page-one"), false);
  assert.equal(guard.isCurrent(replacement, "page-one"), true);

  guard.invalidate();
  assert.equal(guard.isCurrent(replacement, "page-one"), false);
});

test("page-cover position drafts remain bound to their originating page", () => {
  const draft = { pageId: "page-one", x: 75, y: 25 };
  assert.equal(isPageCoverPositionDraftForPage(draft, "page-one"), true);
  assert.equal(isPageCoverPositionDraftForPage(draft, "page-two"), false);
  assert.equal(isPageCoverPositionDraftForPage(null, "page-one"), false);
});

test("custom cover preparation and PATCH responses are guarded against stale page state", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(app, /const pageId = state\.selectedPage\?\.id \?\? null;[\s\S]*?pageCoverOperationGuard\.begin\(pageId\)/);
  assert.match(app, /prepareCustomCoverDataUrl\(file\);[\s\S]*?!pageCoverOperationGuard\.isCurrent\(operation, state\.selectedPage\?\.id\)/);
  assert.match(app, /const expectedVersion = state\.selectedPage\.version;[\s\S]*?state\.selectedPage\?\.id === pageId[\s\S]*?pageCoverOperationGuard\.isCurrent\(activeOperation, pageId\)/);
  assert.match(app, /catch \(error\) \{[\s\S]*?renderPageCover\(state\.selectedPage\)/);
  assert.match(app, /elements\.pageCoverDialog\.addEventListener\("cancel", \(event\) => \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?closePageCoverDialog\(\);/);
  assert.match(app, /pageCoverPositionDraft && !isPageCoverPositionDraftForPage\(pageCoverPositionDraft, page\?\.id\)[\s\S]*?closePageCoverPositionEditor\(\);/);
  assert.match(app, /if \(!isPageCoverPositionDraftForPage\(draft, state\.selectedPage\?\.id\)\) \{[\s\S]*?return;/);

  const cancelHandler = app.slice(app.indexOf('elements.pageCoverImage.addEventListener("pointercancel"'));
  assert.doesNotMatch(cancelHandler.split("\n", 4).join("\n"), /updatePageCoverPositionFromPointer/);
});

test("standalone reproduction demonstrates canceled-dialog and cross-page draft failures", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-cover-operation-scope.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));
  assert.equal(result.vulnerable.dialogCancelWouldStillApply, true);
  assert.equal(result.fixed.dialogCancelWouldStillApply, false);
  assert.equal(result.vulnerable.crossPagePositionSaveAccepted, true);
  assert.equal(result.fixed.crossPagePositionSaveAccepted, false);
});
