import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const normalize = (value) => value.replace(/\r\n/g, "\n");
const route = normalize(fs.readFileSync(path.join(root, "src/routes/collaboration.routes.ts"), "utf8"));
const client = normalize(fs.readFileSync(path.join(root, "public/app.js"), "utf8"));
const migration = normalize(
  fs.readFileSync(
    path.join(root, "migrations/072_page_comment_create_mutation_receipts.sql"),
    "utf8"
  )
);

function section(source, start, end) {
  const begin = source.indexOf(start);
  assert.notEqual(begin, -1, `missing section start: ${start}`);
  const finish = source.indexOf(end, begin + start.length);
  assert.notEqual(finish, -1, `missing section end: ${end}`);
  return source.slice(begin, finish);
}

test("comment creation reserves a durable receipt before inserting user data", () => {
  const createRoute = section(
    route,
    'collaborationRouter.post(\n  "/pages/:pageId/comments"',
    'collaborationRouter.patch(\n  "/pages/:pageId/comments/:commentId"'
  );

  assert.match(createRoute, /kind:\s*"PAGE_COMMENT_CREATE"/);
  assert.match(createRoute, /INSERT INTO page_comment_create_mutations/);
  assert.match(createRoute, /FROM page_comment_create_mutations[\s\S]*FOR UPDATE/);
  assert.match(createRoute, /MUTATION_ID_REUSED/);
  assert.match(createRoute, /PAGE_COMMENT_CREATE_REPLAY_SUPERSEDED/);
  assert.match(createRoute, /UPDATE page_comment_create_mutations[\s\S]*SET comment_id = \?/);

  const receiptInsert = createRoute.indexOf("INSERT INTO page_comment_create_mutations");
  const commentInsert = createRoute.indexOf("INSERT INTO page_comments");
  const receiptFinalize = createRoute.indexOf("UPDATE page_comment_create_mutations");
  assert.ok(receiptInsert >= 0 && commentInsert > receiptInsert);
  assert.ok(receiptFinalize > commentInsert);
});

test("comment-create receipts survive page replacement and carry both workspace generations", () => {
  assert.match(migration, /PRIMARY KEY \(actor_id, mutation_id\)/i);
  assert.match(migration, /actor_workspace_generation BIGINT UNSIGNED NOT NULL/i);
  assert.match(migration, /workspace_owner_id VARCHAR\(64\) NOT NULL/i);
  assert.match(migration, /owner_workspace_generation BIGINT UNSIGNED NOT NULL/i);
  assert.match(migration, /share_generation VARCHAR\(64\) NULL/i);
  assert.doesNotMatch(migration, /FOREIGN KEY \(page_id\)/i);
  assert.doesNotMatch(migration, /FOREIGN KEY \(comment_id\)/i);
});

test("the browser retries only the same comment intent with the same mutation id", () => {
  const submit = section(
    client,
    "async function submitPageComment()",
    "async function savePageCommentEdit(commentId)"
  );

  assert.match(submit, /pendingCreateTask/);
  assert.match(submit, /task\.pageId !== pageId/);
  assert.match(submit, /task\.body !== body/);
  assert.match(submit, /mutationId:\s*createMutationId\(\)/);
  assert.match(submit, /body:\s*\{\s*body,\s*mutationId:\s*task\.mutationId\s*\}/);
  assert.match(submit, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(submit, /isAmbiguousApiError\(error\)/);
  assert.match(submit, /state\.pageComments\.pendingCreateTask === task/);
});
