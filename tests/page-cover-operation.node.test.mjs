import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPageCoverOperationGuard } from "../public/page-cover-operation.js";

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

test("custom cover preparation and PATCH responses are guarded against stale page state", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(app, /const pageId = state\.selectedPage\?\.id \?\? null;[\s\S]*?pageCoverOperationGuard\.begin\(pageId\)/);
  assert.match(app, /prepareCustomCoverDataUrl\(file\);[\s\S]*?!pageCoverOperationGuard\.isCurrent\(operation, state\.selectedPage\?\.id\)/);
  assert.match(app, /const expectedVersion = state\.selectedPage\.version;[\s\S]*?state\.selectedPage\?\.id === pageId[\s\S]*?pageCoverOperationGuard\.isCurrent\(activeOperation, pageId\)/);
  assert.match(app, /catch \(error\) \{[\s\S]*?renderPageCover\(state\.selectedPage\)/);

  const cancelHandler = app.slice(app.indexOf('elements.pageCoverImage.addEventListener("pointercancel"'));
  assert.doesNotMatch(cancelHandler.split("\n", 4).join("\n"), /updatePageCoverPositionFromPointer/);
});
