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
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  const endIndex = end ? text.indexOf(end, startIndex + start.length) : text.length;
  assert.ok(endIndex > startIndex, `missing section end after: ${start}`);
  return text.slice(startIndex, endIndex);
}

test("delegated page creation locks actor and owner before auth/workspace fences", () => {
  const pages = source("src/routes/page.routes.ts");
  const create = section(pages, 'pageRouter.post("/",', 'pageRouter.get("/:pageId/cover"');
  const lockIndex = create.indexOf(
    "await lockPageDeleteUsers(client, [user.id, parentAdmission?.ownerId ?? user.id])"
  );
  const authIndex = create.indexOf(
    "await assertCurrentAuthSessionBoundary(user.id, authScope, client)"
  );
  const ownerIndex = create.indexOf(
    "await assertPageCreateOwnerWorkspaceGeneration(parentAdmission, user.id, client)"
  );
  assert.ok(lockIndex >= 0 && authIndex > lockIndex && ownerIndex > authIndex);

  const helper = section(pages, "async function lockPageDeleteUsers", "type PageDeletionPageRow");
  assert.match(helper, /\[\.\.\.new Set\(userIds\)\]\.sort\(\)/);
  assert.match(helper, /ORDER BY id ASC\s+FOR UPDATE/);
});

test("collection-share mutations deterministically lock actor, owner, and affected user", () => {
  const sharing = source("src/routes/collection-sharing.routes.ts");
  const helper = section(sharing, "async function lockCollectionSharingMutationUsers", "async function getCollectionShareRows");
  assert.match(helper, /\[\.\.\.new Set\(userIds\)\]\.sort\(\)/);
  assert.match(helper, /ORDER BY id ASC FOR UPDATE/);

  const create = section(
    sharing,
    'collectionSharingRouter.post(\n  "/collections/:collectionId/shares"',
    'collectionSharingRouter.patch(\n  "/collections/:collectionId/shares/:userId"'
  );
  const hintIndex = create.indexOf("const targetHint = await db.queryOne<{ id: string }>");
  const lockIndex = create.indexOf("await lockCollectionSharingMutationUsers(client, [");
  const authIndex = create.indexOf("await assertCurrentAuthSessionBoundary(actor.id, authScope, client)");
  assert.ok(hintIndex >= 0 && lockIndex > hintIndex && authIndex > lockIndex);
  assert.match(create, /managementAdmission\.ownerId,[\s\S]*targetHint\.id/);
  assert.match(create, /WHERE u\.id = \? AND u\.username = \? AND u\.id <> \?/);

  for (const routeStart of [
    'collectionSharingRouter.patch(\n  "/collections/:collectionId/shares/:userId"',
    'collectionSharingRouter.delete(\n  "/collections/:collectionId/shares/:userId"'
  ]) {
    const route = section(sharing, routeStart, routeStart.includes("patch")
      ? 'collectionSharingRouter.delete(\n  "/collections/:collectionId/shares/:userId"'
      : null);
    const participantLock = route.indexOf(
      "await lockCollectionSharingMutationUsers(client, [actor.id, managementAdmission.ownerId, sharedUserId])"
    );
    const authFence = route.indexOf(
      "await assertCurrentAuthSessionBoundary(actor.id, authScope, client)"
    );
    assert.ok(participantLock >= 0 && authFence > participantLock);
  }
});

test("direct page sharing locks owner/actor/target before auth and binds target identity", () => {
  const collaboration = source("src/routes/collaboration.routes.ts");
  const create = section(
    collaboration,
    'collaborationRouter.post(\n  "/pages/:pageId/shares"',
    'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"'
  );
  const admissionIndex = create.indexOf(
    "const administrationAdmission = await capturePageShareAdministrationAdmission(pageId, actor.id)"
  );
  const hintIndex = create.indexOf("const targetHint = await db.queryOne<{ id: string }>");
  const lockIndex = create.indexOf("await lockCollaborationMutationUsers(client, [");
  const authIndex = create.indexOf("await assertCurrentAuthSessionBoundary(actor.id, authScope, client)");
  const accessIndex = create.indexOf(
    "getPageAccess(pageId, actor.id, client, { lockPage: true, lockAccess: true })"
  );
  assert.ok(admissionIndex >= 0 && hintIndex > admissionIndex && lockIndex > hintIndex);
  assert.ok(authIndex > lockIndex && accessIndex > authIndex);
  assert.match(create, /administrationAdmission\.ownerId,[\s\S]*targetHint\.id/);
  assert.match(create, /WHERE u\.id = \? AND u\.username = \? AND u\.id <> \?/);

  const remove = section(
    collaboration,
    'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"',
    'collaborationRouter.post(\n  "/recovery/pages/:pageId/candidates"'
  );
  const removeLock = remove.indexOf(
    "await lockCollaborationMutationUsers(client, [actor.id, administrationAdmission.ownerId, sharedUserId])"
  );
  const removeAuth = remove.indexOf(
    "await assertCurrentAuthSessionBoundary(actor.id, authScope, client)"
  );
  assert.ok(removeLock >= 0 && removeAuth > removeLock);
});

test("race model shows reciprocal actor-first locks cycle while sorted locks do not", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-note-user-lock-order-races.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));
  for (const race of Object.values(result)) {
    assert.equal(race.vulnerable.cycleRisk, true);
    assert.equal(race.fixed.cycleRisk, false);
    assert.deepEqual(race.fixed.first, race.fixed.second);
  }
});
