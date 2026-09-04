import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appUrl = new URL("../public/app.js", import.meta.url);

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `missing source section: ${startNeedle}`);
  return source.slice(start, end);
}

test("collection permission and removal mutations remain bound to their originating session and view", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const permissionChange = section(
    source,
    'elements.shareCollectionList.addEventListener("change"',
    'elements.shareCollectionList.addEventListener("click"'
  );
  const removal = section(
    source,
    'elements.shareCollectionList.addEventListener("click"',
    'document.addEventListener("keydown"'
  );

  for (const handler of [permissionChange, removal]) {
    assert.match(handler, /const requestGeneration = shareCollectionRequestGeneration;/);
    assert.match(handler, /const authenticationScope = captureAuthenticatedSessionScope\(\);/);
    assert.match(handler, /const isShareMutationCurrent = \(\) =>/);
    assert.match(handler, /isCurrentAuthenticatedSessionScope\(authenticationScope\)/);
    assert.match(handler, /isCurrentShareCollectionRequest\(requestGeneration, collectionId\)/);
    assert.match(handler, /if \(!isShareMutationCurrent\(\)\) return skippedApiRequest;/);
    assert.match(handler, /beforeFetch: isShareMutationCurrent/);
    assert.match(handler, /data === skippedApiRequest \|\| !isShareMutationCurrent\(\)/);
  }
});

test("write-revoking collection mutations use the owner-wide recovery barrier", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const permissionChange = section(
    source,
    'elements.shareCollectionList.addEventListener("change"',
    'elements.shareCollectionList.addEventListener("click"'
  );
  const removal = section(
    source,
    'elements.shareCollectionList.addEventListener("click"',
    'document.addEventListener("keydown"'
  );

  assert.match(permissionChange, /const nextPermission = select\.value;/);
  assert.match(permissionChange, /const revokesWriteAccess = previous\.permission !== "READ" && nextPermission === "READ";/);
  assert.match(permissionChange, /const data = revokesWriteAccess[\s\S]*withWorkspacePersistenceTransitionForOwner\([\s\S]*collection\.ownerId,[\s\S]*"collection-share-permission"/);
  assert.match(permissionChange, /assertNoPendingLocalCollaborationRecoveryForPages\(memberPageIds\);/);
  assert.match(permissionChange, /body: \{ permission: nextPermission, expectedGeneration \}/);

  assert.match(removal, /withWorkspacePersistenceTransitionForOwner\([\s\S]*collection\.ownerId,[\s\S]*"collection-share-remove"/);
  assert.match(removal, /assertNoPendingLocalCollaborationRecoveryForPages\(memberPageIds\);/);
  const recoveryCheck = removal.indexOf("assertNoPendingLocalCollaborationRecoveryForPages(memberPageIds);");
  const request = removal.indexOf('return api(`/api/collections/', recoveryCheck);
  assert.ok(recoveryCheck >= 0 && request > recoveryCheck);
});

test("reproduction: stale collection-sharing intents and unacknowledged Yjs recovery cannot release a revocation", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-collection-share-mutation-races.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.fetchPreflightGap.vulnerable.requestReachedFetch, true);
  assert.equal(result.fetchPreflightGap.fixed.requestReachedFetch, false);
  assert.equal(result.transitionWaitGap.vulnerable.requestWouldStart, true);
  assert.equal(result.transitionWaitGap.fixed.requestWouldStart, false);
  assert.equal(result.durableRecoveryMirrorGap.vulnerable.requestReachedFetch, true);
  assert.equal(result.durableRecoveryMirrorGap.fixed.blockedByRecovery, true);
  assert.equal(result.durableRecoveryMirrorGap.fixed.requestReachedFetch, false);
});
