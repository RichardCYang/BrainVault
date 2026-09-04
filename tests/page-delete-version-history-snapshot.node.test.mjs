import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPageDeletionSnapshot } from "../src/lib/page-delete-snapshot.ts";

const pages = [{
  id: "page_1",
  parent_page_id: null,
  edit_version: 7,
  content_version: 11
}];
const blocks = [{
  id: "block_1",
  page_id: "page_1",
  edit_version: 3
}];

function rowHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function history(values) {
  return {
    ...values,
    row_hash: rowHash(values)
  };
}

function snapshot(versionHistory) {
  return createPageDeletionSnapshot(
    pages,
    blocks,
    [],
    [],
    [],
    [],
    versionHistory
  );
}

test("a history reset after deletion preview invalidates stale permanent deletion", () => {
  // Reproduction:
  // 1. Tab A previews permanent deletion while revision 12 exists.
  // 2. Tab B resets history. That route replaces page_versions with revision 1
  //    while deliberately leaving page edit/content versions at 7 and 11.
  // 3. Tab A submits the old snapshot. The newly reset history must survive via
  //    a 409 conflict rather than being erased by the page FK cascade.
  const beforeReset = history({
    id: "41",
    page_id: "page_1",
    revision: "12",
    source: "PAGE_UPDATE"
  });
  const afterReset = history({
    id: "42",
    page_id: "page_1",
    revision: "1",
    source: "RESET"
  });

  assert.notEqual(
    snapshot([afterReset]),
    snapshot([beforeReset]),
    "replacement history must change destructive intent even when live page versions are unchanged"
  );
  assert.notEqual(
    snapshot([]),
    snapshot([afterReset]),
    "adding or removing cascading history must invalidate a stale snapshot"
  );
});

test("version-history snapshot hashing is deterministic and content-bound", () => {
  const first = history({
    id: "41",
    page_id: "page_1",
    revision: "11",
    source: "BLOCK_UPDATE"
  });
  const second = history({
    id: "42",
    page_id: "page_1",
    revision: "12",
    source: "PAGE_UPDATE"
  });

  assert.equal(snapshot([first, second]), snapshot([second, first]));
  assert.notEqual(
    snapshot([first]),
    snapshot([{ ...first, row_hash: rowHash({ changed: true }) }]),
    "an in-place history-row change must invalidate the snapshot"
  );
  assert.notEqual(
    snapshot([first]),
    snapshot([{ ...first, page_id: "other_page" }]),
    "history identity must remain bound to its page"
  );
});

test("permanent deletion reads, locks, and validates history before its delete sink", () => {
  const route = readFileSync(
    new URL("../src/routes/page.routes.ts", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const snapshotSource = readFileSync(
    new URL("../src/lib/page-delete-snapshot.ts", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const historySource = readFileSync(
    new URL("../src/lib/page-version-history.ts", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");

  assert.match(
    route,
    /async function getPageDeletionVersionHistory\([\s\S]*SHA2\([\s\S]*JSON_ARRAY\([\s\S]*page_edit_version[\s\S]*page_content_version[\s\S]*actors[\s\S]*change_summary[\s\S]*changes[\s\S]*created_at[\s\S]*FROM page_versions/
  );
  assert.match(snapshotSource, /`history\\0\$\{JSON\.stringify\(\[/);

  const snapshotRouteStart = route.indexOf('pageRouter.get(\n  "/:pageId/deletion-snapshot"');
  const patchRouteStart = route.indexOf('pageRouter.patch("/:pageId"', snapshotRouteStart);
  const deleteRouteStart = route.indexOf('pageRouter.delete(\n  "/:pageId"');
  const tagRouteStart = route.indexOf('pageRouter.put("/:pageId/tags"', deleteRouteStart);
  assert.ok(snapshotRouteStart >= 0 && patchRouteStart > snapshotRouteStart);
  assert.ok(deleteRouteStart >= 0 && tagRouteStart > deleteRouteStart);

  const snapshotRoute = route.slice(snapshotRouteStart, patchRouteStart);
  const deleteRoute = route.slice(deleteRouteStart, tagRouteStart);
  assert.match(
    snapshotRoute,
    /const versionHistoryRows = await getPageDeletionVersionHistory\(client, subtreeRows\);/
  );
  assert.match(
    snapshotRoute,
    /createPageDeletionSnapshot\([\s\S]*membershipRows,[\s\S]*versionHistoryRows[\s\S]*\)/
  );

  const historyLock = deleteRoute.indexOf(
    "getPageDeletionVersionHistory(client, subtreeRows, true)"
  );
  const validation = deleteRoute.indexOf("assertPageDeletionSnapshot(", historyLock);
  const destructiveDelete = deleteRoute.indexOf(
    'DELETE FROM pages WHERE id = ? AND owner_id = ?',
    validation
  );
  assert.ok(historyLock >= 0);
  assert.ok(validation > historyLock, "history rows must be locked before stale-delete validation");
  assert.ok(destructiveDelete > validation, "history validation must precede page deletion");
  assert.match(deleteRoute.slice(validation, destructiveDelete), /versionHistoryRows/);

  const resetStart = historySource.indexOf("export async function resetPageVersionHistory");
  const resetEnd = historySource.indexOf("\nexport function mapPageVersionListRow", resetStart);
  const resetSource = historySource.slice(resetStart, resetEnd);
  assert.match(resetSource, /DELETE FROM page_versions WHERE page_id = \?/);
  assert.match(resetSource, /source: "RESET"/);
  assert.doesNotMatch(
    resetSource,
    /UPDATE pages/,
    "the reset intentionally does not advance live page concurrency tokens"
  );
});
