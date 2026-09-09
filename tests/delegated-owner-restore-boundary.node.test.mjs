import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing section end after: ${start}`);
  return text.slice(startIndex, endIndex);
}

test("delegated page creation captures and fences the page owner's workspace generation", () => {
  const pages = source("src/routes/page.routes.ts");
  const admission = section(
    pages,
    "type PageCreateParentAdmission",
    "async function assertOwnedParentPage("
  );
  assert.match(admission, /ownerWorkspaceGeneration: number/);
  assert.match(admission, /u\.attachment_generation/);
  assert.match(admission, /INNER JOIN users u ON u\.id = p\.owner_id/);
  assert.match(admission, /lockUserAttachmentGeneration\(client, admission\.ownerId\)/);
  assert.match(admission, /"WORKSPACE_RESTORED"/);

  const create = section(pages, 'pageRouter.post("/",', 'pageRouter.get("/:pageId/cover"');
  const userLocksIndex = create.indexOf(
    "lockPageDeleteUsers(client, [user.id, parentAdmission?.ownerId ?? user.id])"
  );
  const authIndex = create.indexOf("assertCurrentAuthSessionBoundary(user.id, authScope, client)");
  const ownerFenceIndex = create.indexOf(
    "assertPageCreateOwnerWorkspaceGeneration(parentAdmission, user.id, client)"
  );
  const receiptIndex = create.indexOf("INSERT INTO page_create_mutations");
  const pageLockIndex = create.indexOf(
    "await assertOwnedParentPage(creation.parentPageId, user.id, client, true)"
  );
  const insertIndex = create.indexOf("INSERT INTO pages");
  assert.ok(
    userLocksIndex >= 0
      && authIndex > userLocksIndex
      && ownerFenceIndex > authIndex
      && receiptIndex > ownerFenceIndex
      && pageLockIndex > ownerFenceIndex
      && insertIndex > pageLockIndex,
    "owner generation must be fenced before receipt/page mutation and before locking the delegated parent"
  );
});

test("comment mutations bind the page owner's generation before the page lock", () => {
  const collaboration = source("src/routes/collaboration.routes.ts");
  const admission = section(
    collaboration,
    "type PageCommentMutationAdmission",
    "const shareUserSchema"
  );
  assert.match(admission, /ownerWorkspaceGeneration: number/);
  assert.match(admission, /u\.attachment_generation/);
  assert.match(admission, /INNER JOIN users u ON u\.id = p\.owner_id/);
  assert.match(admission, /lockUserAttachmentGeneration\(client, admission\.ownerId\)/);
  assert.match(admission, /"WORKSPACE_RESTORED"/);

  const commentRoutes = section(
    collaboration,
    'collaborationRouter.post(\n  "/pages/:pageId/comments"',
    'collaborationRouter.get(\n  "/pages/:pageId/shares"'
  );
  assert.equal(
    (commentRoutes.match(/assertPageCommentOwnerWorkspaceGeneration\(admission, user\.id, client\)/g) ?? []).length,
    3,
    "create/edit/delete comment paths must all fence the owner generation"
  );
  for (const routeStart of [
    'collaborationRouter.post(\n  "/pages/:pageId/comments"',
    'collaborationRouter.patch(\n  "/pages/:pageId/comments/:commentId"',
    'collaborationRouter.delete(\n  "/pages/:pageId/comments/:commentId"'
  ]) {
    const start = commentRoutes.indexOf(routeStart);
    assert.ok(start >= 0, `missing comment route: ${routeStart}`);
    const route = commentRoutes.slice(start, start + 6500);
    const fence = route.indexOf("assertPageCommentOwnerWorkspaceGeneration(admission, user.id, client)");
    const pageLock = route.indexOf("getPageAccess(pageId, user.id, client, { lockPage: true, lockAccess: true })");
    assert.ok(fence >= 0 && pageLock > fence, "owner generation fence must precede the page lock");
  }
});

test("delegated collection-share mutations fence the collection owner's workspace generation", () => {
  const sharing = source("src/routes/collection-sharing.routes.ts");
  const admission = section(
    sharing,
    "type CollectionManagementAdmission",
    "async function lockCollectionDocumentPages"
  );
  assert.match(admission, /ownerWorkspaceGeneration: number/);
  assert.match(admission, /u\.attachment_generation/);
  assert.match(admission, /INNER JOIN users u ON u\.id = p\.owner_id/);
  assert.match(admission, /lockUserAttachmentGeneration\(client, admission\.ownerId\)/);
  assert.match(admission, /"WORKSPACE_RESTORED"/);

  assert.equal(
    (sharing.match(/assertCollectionOwnerWorkspaceGeneration\(managementAdmission, actor\.id, client\)/g) ?? []).length,
    3,
    "create/update/delete collection-share paths must all fence the owner generation"
  );
});

test("race model rejects stale delegated mutations even when stable IDs and grants reappear", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-delegated-owner-restore-races.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  for (const kind of ["page-create", "comment-create", "collection-share"]) {
    assert.equal(result.staleRestoreRace[kind].vulnerable.outcome, "committed");
    assert.equal(result.staleRestoreRace[kind].fixed.outcome, "rejected-owner-generation");
    assert.equal(result.staleRestoreRace[kind].fixed.pageCreates, 0);
    assert.equal(result.staleRestoreRace[kind].fixed.comments, 0);
    assert.equal(result.staleRestoreRace[kind].fixed.collectionShareChanges, 0);
  }
  assert.deepEqual(result.sameGenerationAdmission, {
    vulnerableAccepted: true,
    fixedAccepted: true
  });
});
