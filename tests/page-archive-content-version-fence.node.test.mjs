import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("archive preconditions include the content generation that direct block saves advance", () => {
  const pages = read("../src/routes/page.routes.ts");
  const blocks = read("../src/routes/block.routes.ts");
  const client = read("../public/app.js");

  const blockVersionHelper = section(
    blocks,
    "async function advancePageContentVersion(",
    "function partialMutationVersionPayload"
  );
  assert.match(
    blockVersionHelper,
    /UPDATE pages SET content_version = content_version \+ 1 WHERE id = \? AND owner_id = \?/
  );
  assert.doesNotMatch(blockVersionHelper, /edit_version = edit_version \+ 1/);

  const patchRoute = section(
    pages,
    'pageRouter.patch("/:pageId"',
    "pageRouter.delete("
  );
  assert.match(
    patchRoute,
    /updates\.isArchived === true \|\| updates\.parentPageId !== undefined/
  );
  assert.match(
    patchRoute,
    /contentVersionFenceRequired \? expectedContentVersion : undefined/
  );
  assert.match(
    patchRoute,
    /" AND content_version = \?"/
  );
  assert.match(
    patchRoute,
    /expectedContentVersion: mutationExpectedContentVersion/
  );

  const legacyArchiveStart = pages.lastIndexOf("pageRouter.delete(");
  assert.ok(legacyArchiveStart >= 0, "missing legacy archive DELETE route");
  const legacyArchiveEnd = pages.indexOf('pageRouter.put("/:pageId/tags"', legacyArchiveStart);
  assert.ok(legacyArchiveEnd > legacyArchiveStart, "missing legacy archive DELETE route end");
  const legacyArchive = pages.slice(legacyArchiveStart, legacyArchiveEnd);
  assert.match(
    legacyArchive,
    /!body\.expectedVersion \|\| !body\.expectedContentVersion/
  );
  assert.match(
    legacyArchive,
    /edit_version = \? AND content_version = \? AND edit_version < \?/
  );

  const archiveClient = section(
    client,
    "async function archivePageIdempotently(",
    'elements.archivePageButton.addEventListener("click"'
  );
  assert.match(archiveClient, /expectedContentVersion/);
  assert.match(
    archiveClient,
    /body:\s*\{\s*isArchived: true,\s*expectedVersion,\s*expectedContentVersion,/
  );

  const archiveClick = section(
    client,
    'elements.archivePageButton.addEventListener("click"',
    'for (const eventName of ["focusin", "input", "keyup", "mouseup", "change"])'
  );
  const flush = archiveClick.indexOf("await flushPendingPageEdits");
  const capture = archiveClick.indexOf(
    "const expectedContentVersion = state.selectedPage.contentVersion"
  );
  const submit = archiveClick.indexOf("archivePageWithReconciliation", capture);
  assert.ok(flush >= 0 && capture > flush && submit > capture);
  assert.match(
    archiveClick.slice(submit, submit + 320),
    /expectedContentVersion/
  );
});

test("reproduction: edit-version-only archive accepts a stale destructive intent after a direct block save", () => {
  const viewed = {
    editVersion: 7,
    contentVersion: 11
  };

  // Another tab commits a direct block edit. That operation advances only the
  // page's content generation, so the metadata edit generation remains 7.
  const current = {
    editVersion: 7,
    contentVersion: 12,
    archived: false
  };

  const vulnerableArchive = (
    page,
    expectedEditVersion
  ) => page.editVersion === expectedEditVersion;

  const fencedArchive = (
    page,
    expectedEditVersion,
    expectedContentVersion
  ) => (
    page.editVersion === expectedEditVersion
    && page.contentVersion === expectedContentVersion
  );

  assert.equal(
    vulnerableArchive(current, viewed.editVersion),
    true,
    "the old route would archive a page even though unseen block content was saved"
  );
  assert.equal(
    fencedArchive(current, viewed.editVersion, viewed.contentVersion),
    false,
    "the fixed route rejects the stale archive after the content generation changes"
  );
});
