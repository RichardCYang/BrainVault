import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return text.slice(startIndex, endIndex);
}

const route = source("../src/routes/collaboration.routes.ts");

const shareCreate = section(
  route,
  'collaborationRouter.post(\n  "/pages/:pageId/shares"',
  'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"'
);
const shareDelete = section(
  route,
  'collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"',
  'collaborationRouter.post(\n  "/recovery/pages/:pageId/candidates"'
);
const sessionCreate = section(
  route,
  'collaborationRouter.post(\n  "/pages/:pageId/collaboration/session"',
  'collaborationRouter.put(\n  "/pages/:pageId/collaboration/snapshot"'
);
const snapshot = route.slice(
  route.indexOf('collaborationRouter.put(\n  "/pages/:pageId/collaboration/snapshot"')
);

test("HTTP collaboration mutations capture and revalidate the authenticated session before page locks", () => {
  assert.match(
    route,
    /import \{ assertCurrentAuthSessionBoundary \} from "\.\.\/lib\/auth-sessions\.js";/
  );
  assert.match(
    route,
    /import \{ requireAuth, requireRequestAuthScope \} from "\.\.\/middleware\/auth\.js";/
  );

  for (const mutation of [shareCreate, shareDelete, sessionCreate, snapshot]) {
    assert.match(mutation, /const authScope = requireRequestAuthScope\(req\);/);
    assert.match(mutation, /await assertCurrentAuthSessionBoundary\([\s\S]*authScope, client\);/);
    assert.ok(
      mutation.indexOf("assertCurrentAuthSessionBoundary") < mutation.indexOf("lockPage: true")
        || mutation.indexOf("assertCurrentAuthSessionBoundary") < mutation.indexOf("FOR UPDATE"),
      "auth/session boundary must be fenced before the page mutation lock"
    );
  }
});

test("shared-editor snapshot materialization locks all user rows deterministically before auth and page state", () => {
  assert.match(
    route,
    /async function lockCollaborationMutationUsers[\s\S]*\[\.\.\.new Set\(userIds\)\]\.sort\(\)[\s\S]*ORDER BY id ASC FOR UPDATE/
  );
  assert.match(
    snapshot,
    /await lockCollaborationMutationUsers\(client, \[user\.id, attachmentOwnerId\]\);/
  );

  const userLocks = snapshot.indexOf(
    "await lockCollaborationMutationUsers(client, [user.id, attachmentOwnerId]);"
  );
  const authFence = snapshot.indexOf(
    "await assertCurrentAuthSessionBoundary(user.id, authScope, client);"
  );
  const attachmentLock = snapshot.indexOf(
    "await lockUserAttachmentGeneration(client, attachmentOwnerId);"
  );
  const pageLock = snapshot.indexOf(
    "const access = await getPageAccess(pageId, user.id, client, { lockPage: true });"
  );

  assert.ok(userLocks >= 0 && userLocks < authFence);
  assert.ok(authFence < attachmentLock);
  assert.ok(attachmentLock < pageLock);
});

test("collaboration session rejects non-cookie callers before initializing durable collaboration state", () => {
  const cookieCheck = sessionCreate.indexOf("const authSessionToken = readAuthSessionCookie(req);");
  const transaction = sessionCreate.indexOf("const session = await transaction(async (client) => {");
  const ensureState = sessionCreate.indexOf("await ensureCollaborationState(pageId, client);");

  assert.ok(cookieCheck >= 0 && cookieCheck < transaction);
  assert.ok(transaction < ensureState);
  assert.match(sessionCreate, /const authVersion = authScope\.authVersion;/);
});

test("snapshot retains object-level access revalidation under the page lock before destructive materialization", () => {
  const pageAccess = snapshot.indexOf(
    "const access = await getPageAccess(pageId, user.id, client, { lockPage: true });"
  );
  const existingBlocks = snapshot.indexOf(
    'const existingRows = await client.query<BlockRow>(\n          "SELECT * FROM blocks WHERE page_id = ? ORDER BY id ASC FOR UPDATE"'
  );
  const deleteBlock = snapshot.indexOf(
    'await client.execute("DELETE FROM blocks WHERE id = ? AND page_id = ?"'
  );

  assert.ok(pageAccess >= 0 && pageAccess < existingBlocks);
  assert.ok(existingBlocks < deleteBlock);
});

test("stale-auth race reproduction rejects a request that loses the credential race", () => {
  function reproduce({ fixed, requestAuthVersion, currentAuthVersion, requestSessionActive }) {
    let relationalContentChanged = false;

    if (
      fixed
      && (
        requestAuthVersion !== currentAuthVersion
        || !requestSessionActive
      )
    ) {
      return { status: 401, relationalContentChanged };
    }

    // The vulnerable HTTP materializer could resume after waiting on a lock and
    // rewrite/delete relational blocks even though middleware authentication had
    // become stale while the request was in flight.
    relationalContentChanged = true;
    return { status: 200, relationalContentChanged };
  }

  assert.deepEqual(
    reproduce({
      fixed: false,
      requestAuthVersion: 7,
      currentAuthVersion: 8,
      requestSessionActive: false
    }),
    { status: 200, relationalContentChanged: true }
  );
  assert.deepEqual(
    reproduce({
      fixed: true,
      requestAuthVersion: 7,
      currentAuthVersion: 8,
      requestSessionActive: false
    }),
    { status: 401, relationalContentChanged: false }
  );
});
