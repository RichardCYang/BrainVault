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

function assertPageAdministrationOrder(route, mutationMarker) {
  const admission = route.indexOf("capturePageAdministrationMutationAdmission(pageId, user.id)");
  const transaction = route.indexOf("transaction(async (client)");
  const userLocks = route.indexOf("lockPageDeleteUsers(client, [user.id, administrationAdmission.ownerId])");
  const auth = route.indexOf("assertCurrentAuthSessionBoundary(user.id, authScope, client)");
  const ownerFence = route.indexOf(
    "assertPageAdministrationOwnerWorkspaceGeneration(administrationAdmission, user.id, client)"
  );
  const pageLock = route.indexOf("{ lockPage: true, lockAccess: true }");
  const grantFence = route.indexOf(
    "assertPageAdministrationMutationAdmission(administrationAdmission, user.id"
  );
  const mutation = route.indexOf(mutationMarker);

  assert.ok(admission >= 0 && transaction > admission, "admission must be captured before the mutation transaction");
  assert.ok(
    userLocks > transaction
      && auth > userLocks
      && ownerFence > auth
      && pageLock > ownerFence
      && grantFence > pageLock
      && mutation > grantFence,
    "actor/owner, auth, owner-generation, grant, and page locks must fence the write in order"
  );
}

test("page administration admission binds owner generation and collection-admin grant", () => {
  const pages = source("src/routes/page.routes.ts");
  const admission = section(
    pages,
    "type PageAdministrationMutationAdmission",
    "async function assertOwnedParentPage("
  );

  assert.match(admission, /ownerWorkspaceGeneration: number/);
  assert.match(admission, /collectionId: string \| null/);
  assert.match(admission, /shareGeneration: string \| null/);
  assert.match(admission, /u\.attachment_generation/);
  assert.match(admission, /cs\.generation AS collection_share_generation/);
  assert.match(admission, /lockUserAttachmentGeneration\(client, admission\.ownerId\)/);
  assert.match(admission, /currentAccess\.collectionId === admission\.collectionId/);
  assert.match(admission, /currentAccess\.shareGeneration === admission\.shareGeneration/);
  assert.match(admission, /"WORKSPACE_RESTORED"/);
  assert.match(admission, /"PAGE_ADMIN_ACCESS_CHANGED"/);
});

test("page update, archive, and tag writes fence delegated administration before mutation", () => {
  const pages = source("src/routes/page.routes.ts");

  const update = section(
    pages,
    'pageRouter.patch("/:pageId"',
    'pageRouter.delete(\n  "/:pageId"'
  );
  assertPageAdministrationOrder(update, "UPDATE pages SET");

  const deletion = section(
    pages,
    'pageRouter.delete(\n  "/:pageId"',
    'pageRouter.put("/:pageId/tags"'
  );
  const archiveStart = deletion.indexOf(
    "const administrationAdmission = await capturePageAdministrationMutationAdmission(pageId, user.id)"
  );
  assert.ok(archiveStart >= 0, "missing archive admission");
  assertPageAdministrationOrder(deletion.slice(archiveStart), "SET is_archived = 1");

  const tags = section(
    pages,
    'pageRouter.put("/:pageId/tags"',
    'function escapeHtmlAttribute'
  );
  assertPageAdministrationOrder(tags, "replaceTags(client, pageId, tags)");
});

test("collection-admin direct-share removal fences owner restore and current admin grant", () => {
  const collaboration = source("src/routes/collaboration.routes.ts");
  const admission = section(
    collaboration,
    "type PageShareAdministrationAdmission",
    "const shareUserSchema"
  );
  assert.match(admission, /ownerWorkspaceGeneration: number/);
  assert.match(admission, /collectionId: string \| null/);
  assert.match(admission, /cs\.generation AS collection_share_generation/);
  assert.match(admission, /lockUserAttachmentGeneration\(client, admission\.ownerId\)/);
  assert.match(admission, /currentAccess\.collectionId === admission\.collectionId/);
  assert.match(admission, /currentAccess\.shareGeneration === admission\.shareGeneration/);
  assert.match(admission, /"WORKSPACE_RESTORED"/);
  assert.match(admission, /"PAGE_SHARE_ACCESS_CHANGED"/);

  const route = section(
    collaboration,
    'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"',
    'collaborationRouter.post(\n  "/recovery/pages/:pageId/candidates"'
  );
  const capture = route.indexOf("capturePageShareAdministrationAdmission(pageId, actor.id)");
  const transaction = route.indexOf("transaction(async (client)");
  const userLocks = route.indexOf(
    "lockCollaborationMutationUsers(client, [actor.id, administrationAdmission.ownerId])"
  );
  const auth = route.indexOf("assertCurrentAuthSessionBoundary(actor.id, authScope, client)");
  const ownerFence = route.indexOf(
    "assertPageShareAdministrationOwnerWorkspaceGeneration(administrationAdmission, actor.id, client)"
  );
  const pageLock = route.indexOf("{ lockPage: true, lockAccess: true }");
  const grantFence = route.indexOf(
    "assertPageShareAdministrationMutationAdmission(administrationAdmission, actor.id, access)"
  );
  const targetGenerationFence = route.indexOf("existingShare.generation !== expectedGeneration");
  const deletion = route.indexOf("DELETE FROM page_shares");

  assert.ok(capture >= 0 && transaction > capture);
  assert.ok(
    userLocks > transaction
      && auth > userLocks
      && ownerFence > auth
      && pageLock > ownerFence
      && grantFence > pageLock
      && targetGenerationFence > grantFence
      && deletion > targetGenerationFence,
    "share removal must validate both administrator and target-share lineages before deletion"
  );
});

test("race model rejects stale delegated page-admin writes while preserving same-generation writes", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-delegated-page-admin-restore-races.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  const counters = {
    "page-update": "pageUpdates",
    "page-archive": "pageArchives",
    "page-tags": "tagReplacements",
    "page-share-delete": "directShareRemovals"
  };

  for (const [kind, counter] of Object.entries(counters)) {
    assert.equal(result.staleRestoreRace[kind].vulnerable.outcome, "committed");
    assert.equal(result.staleRestoreRace[kind].vulnerable[counter], 1);
    assert.equal(result.staleRestoreRace[kind].fixed.outcome, "rejected-owner-generation");
    assert.equal(result.staleRestoreRace[kind].fixed[counter], 0);
    assert.equal(result.sameGenerationAdmission[kind], true);
  }
});
