import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isRestorablePageShareTarget } from "../src/lib/page-share-integrity.ts";

test("archived ordinary pages retain restorable sharing grants", () => {
  assert.equal(isRestorablePageShareTarget({ is_collection: 0 }), true);
  assert.equal(isRestorablePageShareTarget({ is_collection: false }), true);
  assert.equal(isRestorablePageShareTarget({ is_collection: 1 }), false);
  assert.equal(isRestorablePageShareTarget(undefined), false);
});

test("current and legacy restore paths use the same archived-page-safe policy", async () => {
  const source = (await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");

  assert.match(source, /if \(!isRestorablePageShareTarget\(page\)\)/);
  assert.match(source, /return isRestorablePageShareTarget\(page\);/);
  assert.doesNotMatch(source, /page\.is_collection \|\| page\.is_archived/);
  assert.doesNotMatch(source, /!page\.is_collection && !page\.is_archived/);
  assert.match(source, /Shared page cannot be a collection:/);
});
