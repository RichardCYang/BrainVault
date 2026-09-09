import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const route = fs
  .readFileSync(path.join(root, "src/routes/collaboration.routes.ts"), "utf8")
  .replace(/\r\n/g, "\n");

function section(source, start, end) {
  const begin = source.indexOf(start);
  assert.notEqual(begin, -1, `missing section start: ${start}`);
  const finish = source.indexOf(end, begin + start.length);
  assert.notEqual(finish, -1, `missing section end: ${end}`);
  return source.slice(begin, finish);
}

function assertActorOwnerLockOrder(source, label) {
  const orderedLock = source.indexOf(
    "await lockCollaborationMutationUsers(client, [user.id, admission.ownerId]);"
  );
  const actorBoundary = source.indexOf(
    "await assertCurrentAuthSessionBoundary(user.id, authScope, client);"
  );
  const ownerBoundary = source.indexOf(
    "await assertPageCommentOwnerWorkspaceGeneration(admission, user.id, client);"
  );
  assert.ok(orderedLock >= 0, `${label} must lock actor and owner together`);
  assert.ok(actorBoundary > orderedLock, `${label} must establish ordered user locks before actor validation`);
  assert.ok(ownerBoundary > actorBoundary, `${label} must validate owner generation after ordered locks`);
}

test("comment create/edit/delete acquire actor and owner rows in one deterministic order", () => {
  const createRoute = section(
    route,
    'collaborationRouter.post(\n  "/pages/:pageId/comments"',
    'collaborationRouter.patch(\n  "/pages/:pageId/comments/:commentId"'
  );
  const editRoute = section(
    route,
    'collaborationRouter.patch(\n  "/pages/:pageId/comments/:commentId"',
    'collaborationRouter.delete(\n  "/pages/:pageId/comments/:commentId"'
  );
  const deleteRoute = section(
    route,
    'collaborationRouter.delete(\n  "/pages/:pageId/comments/:commentId"',
    'collaborationRouter.get(\n  "/pages/:pageId/shares"'
  );

  assertActorOwnerLockOrder(createRoute, "comment create");
  assertActorOwnerLockOrder(editRoute, "comment edit");
  assertActorOwnerLockOrder(deleteRoute, "comment delete");
});

test("the shared user-lock helper sorts and de-duplicates ids before FOR UPDATE", () => {
  const helper = section(
    route,
    "async function lockCollaborationMutationUsers",
    "type PageCommentMutationAdmission"
  );
  assert.match(helper, /\[\.\.\.new Set\(userIds\)\]\.sort\(\)/);
  assert.match(helper, /ORDER BY id ASC FOR UPDATE/);
});
