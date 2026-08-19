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

test("durable note mutations bind auth, device session, and workspace generation under row locks", () => {
  const sessions = source("src/lib/auth-sessions.ts");
  assert.match(
    sessions,
    /export async function assertCurrentAuthSessionBoundary\([\s\S]*SELECT auth_version, attachment_generation FROM users WHERE id = \? FOR UPDATE/
  );
  assert.match(
    sessions,
    /assertCurrentAuthSessionBoundary[\s\S]*Number\(account\.auth_version \?\? 1\) !== authVersion/
  );
  assert.match(
    sessions,
    /assertCurrentAuthSessionBoundary[\s\S]*isAuthSessionActive\(userId, sessionId, authVersion, client, \{ lock: true \}\)/
  );
  assert.match(
    sessions,
    /currentWorkspaceGeneration !== workspaceGeneration[\s\S]*"WORKSPACE_RESTORED"/
  );

  const middleware = source("src/middleware/auth.ts");
  assert.match(middleware, /attachment_generation/);
  assert.match(middleware, /req\.auth = \{ authVersion, workspaceGeneration \}/);
  assert.match(middleware, /export function requireRequestAuthScope\(req: Request\)/);
  assert.match(middleware, /return Object\.freeze\(\{ authVersion, workspaceGeneration, sessionId \}\)/);
});

test("page create, history reset, update, archive/delete, and tags revalidate request auth inside transactions", () => {
  const pages = source("src/routes/page.routes.ts");

  const create = section(pages, 'pageRouter.post("/",', 'pageRouter.get("/:pageId/cover"');
  assert.match(create, /const authScope = requireRequestAuthScope\(req\)/);
  assert.match(create, /transaction\(async \(client\) => \{\s+await assertCurrentAuthSessionBoundary\(user\.id, authScope, client\)/);

  const reset = section(pages, 'pageRouter.delete(\n  "/:pageId/versions"', 'pageRouter.get(\n  "/:pageId/versions/:versionId"');
  assert.match(reset, /const authScope = requireRequestAuthScope\(req\)/);
  assert.match(reset, /transaction\(async \(client\) => \{[\s\S]*await assertCurrentAuthSessionBoundary\(user\.id, authScope, client\)/);

  const update = section(pages, 'pageRouter.patch("/:pageId"', 'pageRouter.delete(\n  "/:pageId"');
  assert.match(update, /const authScope = requireRequestAuthScope\(req\)/);
  assert.match(update, /transaction\(async \(client\) => \{\s+await assertCurrentAuthSessionBoundary\(user\.id, authScope, client\)/);

  const deletion = section(pages, 'pageRouter.delete(\n  "/:pageId"', 'pageRouter.put("/:pageId/tags"');
  assert.match(deletion, /const authScope = requireRequestAuthScope\(req\)/);
  assert.equal(
    (deletion.match(/await assertCurrentAuthSessionBoundary\(user\.id, authScope, client\)/g) ?? []).length,
    2,
    "both permanent-delete and archive transactions must fence the initiating auth session"
  );

  const tags = section(pages, 'pageRouter.put("/:pageId/tags"', 'function escapeHtmlAttribute');
  assert.match(tags, /const authScope = requireRequestAuthScope\(req\)/);
  assert.match(tags, /transaction\(async \(client\) => \{\s+await assertCurrentAuthSessionBoundary\(user\.id, authScope, client\)/);
});

test("block attachment/create/update/delete/reorder mutations revalidate request auth before durable changes", () => {
  const blocks = source("src/routes/block.routes.ts");

  const attachment = section(blocks, 'blockRouter.post(\n  "/pages/:pageId/attachments"', 'blockRouter.get("/blocks/:blockId/attachment"');
  assert.match(attachment, /const authScope = requireRequestAuthScope\(req\)/);
  const allUsersLock = attachment.indexOf("await lockBlockCreateUsers(client, [user.id, ownerId])");
  const authFence = attachment.indexOf("await assertCurrentAuthSessionBoundary(user.id, authScope, client)");
  const pageLock = attachment.indexOf("getPageAccess(pageId, user.id, client, { lockPage: true })");
  assert.ok(allUsersLock >= 0 && allUsersLock < authFence && authFence < pageLock);

  const create = section(blocks, 'blockRouter.post("/pages/:pageId/blocks"', 'blockRouter.patch("/blocks/:blockId"');
  assert.match(create, /const authScope = requireRequestAuthScope\(req\)/);
  assert.match(create, /lockBlockCreateUsers\(client, \[user\.id, ownerId\]\);\s+await assertCurrentAuthSessionBoundary\(user\.id, authScope, client\)/);

  const update = section(blocks, 'blockRouter.patch("/blocks/:blockId"', 'blockRouter.delete(\n  "/blocks/:blockId"');
  assert.match(update, /transaction\(async \(client\) => \{\s+await assertCurrentAuthSessionBoundary\(user\.id, authScope, client\)/);

  const deletion = section(blocks, 'blockRouter.delete(\n  "/blocks/:blockId"', 'blockRouter.post(\n  "/pages/:pageId/blocks/reorder"');
  assert.match(deletion, /const authScope = requireRequestAuthScope\(req\)/);
  assert.match(deletion, /lockUserAttachmentGeneration\(client, user\.id\)[\s\S]*await assertCurrentAuthSessionBoundary\(user\.id, authScope, client\)/);

  const reorder = section(blocks, 'blockRouter.post(\n  "/pages/:pageId/blocks/reorder"', null);
  assert.match(reorder, /const authScope = requireRequestAuthScope\(req\)/);
  assert.match(reorder, /transaction\(async \(client\) => \{\s+await assertCurrentAuthSessionBoundary\(user\.id, authScope, client\)/);
});

test("race reproducer shows pre-fix commits and post-fix rejects after credential/session revocation", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-note-mutation-auth-boundary.mjs", import.meta.url))],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);
  assert.deepEqual(result.versionRotation, {
    vulnerableOutcome: "committed",
    vulnerableMutations: 1,
    fixedOutcome: "rejected",
    fixedMutations: 0
  });
  assert.deepEqual(result.sessionRevocation, {
    vulnerableOutcome: "committed",
    vulnerableMutations: 1,
    fixedOutcome: "rejected",
    fixedMutations: 0
  });
});
