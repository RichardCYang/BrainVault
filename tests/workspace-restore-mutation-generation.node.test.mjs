import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("durable HTTP mutations are fenced from a workspace restore generation change", async () => {
  const [auth, sessions, transfer, dataRoutes] = await Promise.all([
    read("src/middleware/auth.ts"),
    read("src/lib/auth-sessions.ts"),
    read("src/lib/data-transfer.ts"),
    read("src/routes/data.routes.ts")
  ]);

  assert.match(
    auth,
    /password_hash, vpn_block_enabled, auth_version, attachment_generation, created_at, updated_at/
  );
  assert.match(auth, /const workspaceGeneration = Number\(user\.attachment_generation \?\? 1\)/);
  assert.match(auth, /req\.auth = \{ authVersion, workspaceGeneration \}/);
  assert.match(
    auth,
    /return Object\.freeze\(\{ authVersion, workspaceGeneration, sessionId \}\)/
  );

  assert.match(
    sessions,
    /AuthSessionBoundaryScope = Readonly<\{\s*authVersion: number;\s*workspaceGeneration: number;\s*sessionId: string;/
  );
  const userLock = sessions.indexOf(
    '"SELECT auth_version, attachment_generation FROM users WHERE id = ? FOR UPDATE"'
  );
  const sessionLock = sessions.indexOf(
    "isAuthSessionActive(userId, sessionId, authVersion, client, { lock: true })",
    userLock
  );
  const generationFence = sessions.indexOf(
    "if (currentWorkspaceGeneration !== workspaceGeneration)",
    sessionLock
  );
  assert.ok(
    userLock >= 0 && sessionLock > userLock && generationFence > sessionLock,
    "auth/session must be validated under the user lock before the restore-generation fence"
  );
  assert.match(
    sessions,
    /409,\s*"WORKSPACE_RESTORED",\s*"The workspace was restored while this request was in progress\. Refresh before retrying\."/
  );

  assert.match(
    transfer,
    /attachment_generation = attachment_generation \+ 1/
  );
  assert.match(
    transfer,
    /assertCurrentDataRestoreAuthentication[\s\S]*assertCurrentAuthSessionBoundary\(userId, authScope, client\)/
  );
  assert.match(dataRoutes, /const authScope = requireRequestAuthScope\(req\)/);
  assert.match(dataRoutes, /importUserDataBackup\(user\.id, uploadPath, authScope\)/);
});

test("live collaboration is fenced from the collaborator's workspace restore generation", async () => {
  const [token, collaborationRoutes, collaborationServer] = await Promise.all([
    read("src/lib/collaboration-token.ts"),
    read("src/routes/collaboration.routes.ts"),
    read("src/lib/collaboration-server.ts")
  ]);

  assert.match(token, /workspaceGeneration: number/);
  assert.match(token, /Number\(decoded\.workspaceGeneration\)/);
  assert.match(collaborationRoutes, /workspaceGeneration: authScope\.workspaceGeneration/);

  assert.match(collaborationServer, /workspaceGeneration: number/);
  assert.match(
    collaborationServer,
    /SELECT auth_version, attachment_generation FROM users WHERE id = \?\$\{lock \? " FOR UPDATE" : ""\}/
  );
  assert.match(collaborationServer, /currentWorkspaceGeneration !== client\.workspaceGeneration/);
  assert.match(collaborationServer, /"WORKSPACE_RESTORED"/);
  assert.match(collaborationServer, /currentWorkspaceGeneration !== payload\.workspaceGeneration/);

  const durableFence = collaborationServer.indexOf(
    "await assertCurrentCollaborationAuthentication(client, dbClient, { lock: true });"
  );
  const pageLock = collaborationServer.indexOf(
    "await getPageAccess(room.pageId, client.user.id, dbClient, { lockPage: true });",
    durableFence
  );
  assert.ok(
    durableFence >= 0 && pageLock > durableFence,
    "the collaborator generation must be locked and revalidated before the durable shared-page write lock"
  );
});

test("race models reject stale post-restore writes without serializing same-generation concurrent creates", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-workspace-restore-mutation-generation.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.deepEqual(result.restoreRace.vulnerable, {
    outcome: "committed",
    staleBlocksCommitted: 1,
    workspaceGeneration: 13
  });
  assert.deepEqual(result.restoreRace.fixed, {
    outcome: "rejected",
    staleBlocksCommitted: 0,
    workspaceGeneration: 13
  });
  assert.deepEqual(result.collaborationRestoreRace.vulnerable, {
    outcome: "committed",
    staleUpdatesCommitted: 1,
    workspaceGeneration: 32
  });
  assert.deepEqual(result.collaborationRestoreRace.fixed, {
    outcome: "rejected",
    staleUpdatesCommitted: 0,
    workspaceGeneration: 32
  });
  assert.deepEqual(result.sameGenerationConcurrentCreates, {
    firstOutcome: "committed",
    secondOutcome: "committed",
    blocks: 2,
    pageContentVersion: 82
  });
});
