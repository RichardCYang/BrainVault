import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPageDeletionSnapshot } from "../src/lib/page-delete-snapshot.ts";

const pages = [{
  id: "page_1",
  parent_page_id: null,
  edit_version: 4,
  content_version: 9
}];
const blocks = [{
  id: "block_1",
  page_id: "page_1",
  edit_version: 3
}];
const shares = [{
  page_id: "page_1",
  user_id: "user_collaborator",
  permission: "EDIT",
  generation: "share_generation_1"
}];
const collaborationStates = [{
  page_id: "page_1",
  document_epoch: "document_epoch_1"
}];

function hashCommentBody(body) {
  return createHash("sha256").update(body).digest("hex");
}

function comment(values) {
  return {
    edit_version: 1,
    ...values,
    body_hash: hashCommentBody(values.body)
  };
}

function snapshot(comments) {
  return createPageDeletionSnapshot(
    pages,
    blocks,
    shares,
    collaborationStates,
    comments.map(comment)
  );
}

test("a comment committed after deletion preview invalidates the stale hard delete", () => {
  const previewSnapshot = snapshot([]);
  const committedComment = {
    id: "comment_1",
    page_id: "page_1",
    user_id: "user_collaborator",
    body: "Do not delete this newer discussion"
  };

  assert.notEqual(
    snapshot([committedComment]),
    previewSnapshot,
    "the post-preview comment must change the destructive snapshot"
  );
  assert.notEqual(
    snapshot([{ ...committedComment, body: "Edited after preview", edit_version: 2 }]),
    snapshot([committedComment]),
    "a post-preview comment edit must also invalidate the destructive snapshot"
  );
  assert.notEqual(
    snapshot([{ ...committedComment, edit_version: 2 }]),
    snapshot([committedComment]),
    "even an edit that returns to identical text must advance the destructive generation"
  );
});

test("comment snapshot hashing is order-independent and identity-bound", () => {
  const first = {
    id: "comment_1",
    page_id: "page_1",
    user_id: "user_a",
    body: "First"
  };
  const second = {
    id: "comment_2",
    page_id: "page_1",
    user_id: "user_b",
    body: "Second\nline"
  };

  assert.equal(snapshot([first, second]), snapshot([second, first]));
  assert.notEqual(snapshot([first]), snapshot([{ ...first, user_id: "user_b" }]));
  assert.notEqual(snapshot([first]), snapshot([{ ...first, page_id: "page_2" }]));
});

test("page deletion reads, locks, and validates discussion rows before its delete sink", () => {
  const route = readFileSync(
    new URL("../src/routes/page.routes.ts", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const snapshotRouteStart = route.indexOf('pageRouter.get(\n  "/:pageId/deletion-snapshot"');
  const patchRouteStart = route.indexOf('pageRouter.patch("/:pageId"', snapshotRouteStart);
  const deleteRouteStart = route.indexOf('pageRouter.delete(\n  "/:pageId"');
  const tagRouteStart = route.indexOf('pageRouter.put("/:pageId/tags"', deleteRouteStart);
  assert.ok(snapshotRouteStart >= 0 && patchRouteStart > snapshotRouteStart);
  assert.ok(deleteRouteStart >= 0 && tagRouteStart > deleteRouteStart);

  const snapshotRoute = route.slice(snapshotRouteStart, patchRouteStart);
  const deleteRoute = route.slice(deleteRouteStart, tagRouteStart);
  assert.match(
    route,
    /async function getPageDeletionComments\([\s\S]*SELECT id, page_id, user_id, edit_version, SHA2\(body, 256\) AS body_hash[\s\S]*FROM page_comments/
  );
  assert.match(snapshotRoute, /getPageDeletionComments\(client, subtreeRows\)/);
  assert.match(snapshotRoute, /comments: commentRows\.length/);

  assert.match(
    deleteRoute,
    /const commentRows = await getPageDeletionComments\(client, subtreeRows, true\);/
  );
  const lockIndex = deleteRoute.indexOf("getPageDeletionComments(client, subtreeRows, true)");
  const validationIndex = deleteRoute.indexOf("assertPageDeletionSnapshot(", lockIndex);
  const deleteIndex = deleteRoute.indexOf('DELETE FROM pages WHERE id = ? AND owner_id = ?', validationIndex);
  assert.ok(lockIndex >= 0 && validationIndex > lockIndex && deleteIndex > validationIndex);
  assert.match(deleteRoute.slice(validationIndex, deleteIndex), /commentRows/);
});
