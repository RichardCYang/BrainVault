import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageAccess = readFileSync(new URL("../src/lib/page-access.ts", import.meta.url), "utf8");
const token = readFileSync(new URL("../src/lib/collaboration-token.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/lib/collaboration-server.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8");

test("editor page access carries the exact share generation", () => {
  assert.match(pageAccess, /shareGeneration: string \| null/);
  assert.match(pageAccess, /ps\.generation AS access_share_generation/);
  assert.match(pageAccess, /shareGeneration = sharedPage\?\.access_share_generation \?\? null/);
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
