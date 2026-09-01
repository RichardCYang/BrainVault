import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageAccess = readFileSync(new URL("../src/lib/page-access.ts", import.meta.url), "utf8");
const token = readFileSync(new URL("../src/lib/collaboration-token.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/lib/collaboration-server.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8");

test("effective page access carries the exact authoritative share generation", () => {
  assert.match(pageAccess, /shareGeneration: string \| null/);
  assert.match(pageAccess, /SELECT permission, generation\s+FROM collection_shares/);
  assert.match(pageAccess, /shareGeneration = collectionGrant\.generation/);
  assert.match(pageAccess, /SELECT generation\s+FROM page_shares/);
  assert.match(pageAccess, /shareGeneration = pageGrant\.generation/);
});

test("collaboration tickets require a grant lineage", () => {
  assert.match(token, /shareGeneration: string \| null/);
  assert.match(token, /decoded\.shareGeneration !== null/);
  assert.match(route, /shareGeneration: session\.access\.shareGeneration/);
});

test("revocation disconnects only the generation that was actually removed", () => {
  assert.match(route, /removedShareGeneration: existingShare\.generation/);
  assert.match(
    route,
    /disconnectSharedUserGrant\(\s*pageId,\s*sharedUserId,\s*result\.removedShareGeneration/
  );
  assert.doesNotMatch(route, /disconnectRemovedSharedUserIfCurrent/);
  assert.match(server, /client\.user\.id === userId && client\.shareGeneration === shareGeneration/);
});

test("live and queued collaboration writes revalidate grant generation", () => {
  assert.match(server, /assertCurrentCollaborationGrant\(access, payload\.shareGeneration\)/);
  assert.match(server, /assertCurrentCollaborationGrant\(currentAccess, payload\.shareGeneration\)/);
  assert.match(server, /assertCurrentCollaborationGrant\(access, client\.shareGeneration\)/);

  const persistenceStart = server.indexOf("private async persistUpdate");
  const persistence = server.slice(
    persistenceStart,
    server.indexOf("private async recheckAccess", persistenceStart)
  );
  assert.match(
    persistence,
    /getPageAccess\(room\.pageId, client\.user\.id, dbClient, \{ lockPage: true \}\);\s*assertCurrentCollaborationGrant\(access, client\.shareGeneration\)/
  );
});

test("revoke then re-add reproducer rejects the old grant and accepts the replacement", () => {
  const output = execFileSync(
    process.execPath,
    [new URL("../scripts/reproduce-collaboration-share-generation-revival.mjs", import.meta.url).pathname],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);
  assert.equal(result.vulnerable.staleWriteAccepted, true);
  assert.equal(result.fixed.oldGrantAcceptedAfterReAdd, false);
  assert.equal(result.fixed.replacementGrantAccepted, true);
  assert.equal(result.verified, true);
});
test("attachment uploads stay bound to the collaborator grant admitted before multipart intake", () => {
  const blockRoute = readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");

  const admissionStart = blockRoute.indexOf("async function capturePageMutationAdmission");
  const admissionEnd = blockRoute.indexOf("function assertPageOwnerWorkspaceGeneration", admissionStart);
  const admission = blockRoute.slice(admissionStart, admissionEnd);
  assert.match(admission, /access_share_generation/);
  assert.match(admission, /WHEN cs\.user_id IS NOT NULL THEN cs\.generation/);
  assert.match(admission, /ELSE ps\.generation/);
  assert.match(admission, /actorShareGeneration/);

  const uploadStart = blockRoute.indexOf('"/pages/:pageId/attachments"');
  const uploadEnd = blockRoute.indexOf('blockRouter.get("/blocks/:blockId/attachment"', uploadStart);
  const upload = blockRoute.slice(uploadStart, uploadEnd);
  const pageLock = upload.indexOf("getPageAccess(pageId, user.id, client, { lockPage: true })");
  const grantFence = upload.indexOf("lockedAccess.shareGeneration !== target.actorShareGeneration");
  const fileMove = upload.indexOf("moveAttachmentFile(file.path, ownerId, id)");
  const insert = upload.indexOf("INSERT INTO blocks");

  assert.ok(pageLock >= 0, "attachment creation must re-resolve page access under the page lock");
  assert.ok(
    grantFence > pageLock && fileMove > grantFence && insert > grantFence,
    "the admitted collaborator grant must be revalidated before moving a file or inserting a block"
  );
});

test("attachment revoke-then-readd reproducer rejects the stale upload grant", () => {
  const output = execFileSync(
    process.execPath,
    [new URL("../scripts/reproduce-attachment-share-generation-revival.mjs", import.meta.url).pathname],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);
  assert.equal(result.vulnerable.staleUploadAccepted, true);
  assert.equal(result.fixed.staleUploadAccepted, false);
  assert.equal(result.fixed.replacementUploadAccepted, true);
  assert.equal(result.verified, true);
});
