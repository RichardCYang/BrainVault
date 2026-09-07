import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("comment writes bind to the collaborator grant generation admitted before a lineage change", () => {
  const source = readFileSync(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");

  const admission = section(
    source,
    "type PageCommentMutationAdmission",
    "const shareUserSchema"
  );
  assert.match(admission, /LEFT JOIN page_collection_memberships pcm/);
  assert.match(admission, /LEFT JOIN collection_shares cs/);
  assert.match(admission, /LEFT JOIN page_shares ps/);
  assert.match(admission, /WHEN cs\.user_id IS NOT NULL THEN cs\.generation[\s\S]*ELSE ps\.generation/);
  assert.match(admission, /currentAccess\.shareGeneration === admission\.shareGeneration/);
  assert.match(admission, /"PAGE_COMMENT_ACCESS_CHANGED"/);

  const routes = [
    section(
      source,
      'collaborationRouter.post(\n  "/pages/:pageId/comments"',
      'collaborationRouter.patch(\n  "/pages/:pageId/comments/:commentId"'
    ),
    section(
      source,
      'collaborationRouter.patch(\n  "/pages/:pageId/comments/:commentId"',
      'collaborationRouter.delete(\n  "/pages/:pageId/comments/:commentId"'
    ),
    source.slice(source.indexOf('collaborationRouter.delete(\n  "/pages/:pageId/comments/:commentId"'))
  ];

  for (const route of routes) {
    const captureIndex = route.indexOf("capturePageCommentMutationAdmission(pageId, user.id)");
    const transactionIndex = route.indexOf("transaction(async (client)");
    const authFenceIndex = route.indexOf("assertCurrentAuthSessionBoundary(user.id, authScope, client)");
    const pageLockIndex = route.indexOf(
      "getPageAccess(pageId, user.id, client, { lockPage: true, lockAccess: true })"
    );
    const generationFenceIndex = route.indexOf("assertPageCommentMutationAdmission(admission, access)");
    const mutationIndexes = ["INSERT INTO page_comments", "UPDATE page_comments", "DELETE FROM page_comments"]
      .map((needle) => route.indexOf(needle))
      .filter((index) => index >= 0);
    const firstMutationIndex = mutationIndexes.length ? Math.min(...mutationIndexes) : -1;

    assert.ok(
      captureIndex >= 0
        && captureIndex < transactionIndex
        && authFenceIndex > transactionIndex
        && pageLockIndex > authFenceIndex
        && generationFenceIndex > pageLockIndex
        && firstMutationIndex > generationFenceIndex,
      "each comment write must compare admitted grant lineage with current locked access before writing"
    );
  }
});

test("race model rejects comment create/edit/delete requests that cross a replaced collaborator grant", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-comment-create-restore-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);

  for (const action of ["create-comment", "edit-comment", "delete-comment"]) {
    assert.deepEqual(result.staleGrantMutations[action], {
      vulnerable: { action, outcome: "committed" },
      fixed: { action, outcome: "rejected-access-generation" }
    });
    assert.deepEqual(result.sameGenerationMutations[action], { action, outcome: "committed" });
  }
});
