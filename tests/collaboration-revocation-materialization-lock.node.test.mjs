import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const direct = readFileSync(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const collection = readFileSync(new URL("../src/routes/collection-sharing.routes.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const quarantine = readFileSync(new URL("../src/lib/collaboration-quarantine.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function directRemovalSection() {
  const start = direct.indexOf('collaborationRouter.delete(\n  "/pages/:pageId/shares/:userId"');
  const end = direct.indexOf('collaborationRouter.post(\n  "/recovery/pages/:pageId/candidates"', start);
  assert.ok(start >= 0 && end > start, "direct share removal route must be present");
  return direct.slice(start, end);
}

test("final direct-share revocation is no longer conditional on successful materialization", () => {
  const section = directRemovalSection();
  assert.doesNotMatch(section, /COLLABORATION_CHANGES_PENDING/);
  assert.doesNotMatch(section, /COLLABORATION_MATERIALIZATION_VERSION_UNSUPPORTED/);
  const revoke = section.indexOf("DELETE FROM page_shares");
  const quarantineIndex = section.indexOf("quarantineCollaborationHistoryForOwner");
  assert.ok(revoke >= 0 && quarantineIndex > revoke, "authorization must be revoked before content quarantine is evaluated");
  assert.match(section, /if \(!quarantined\) \{[\s\S]*return \{[\s\S]*remaining,/);
});

test("final collection-share teardown quarantines pending history without rolling access revocation back", () => {
  const start = collection.indexOf("async function teardownCollaborationIfFinalShare(");
  const end = collection.indexOf("\ncollectionSharingRouter.get(", start);
  assert.ok(start >= 0 && end > start, "collection final-share teardown must be present");
  const section = collection.slice(start, end);
  assert.doesNotMatch(section, /COLLABORATION_CHANGES_PENDING/);
  assert.match(section, /quarantineCollaborationHistoryForOwner/);
  assert.match(section, /if \(!quarantined\) return 0;/);
});

test("server quarantine stores a bounded canonical Yjs recovery candidate for the owner", () => {
  assert.match(quarantine, /assessCollaborationHistoryReplay/);
  assert.match(quarantine, /collaborationRecoveryPool\.replayHistory/);
  assert.match(quarantine, /maxStateBytes:\s*maxCollaborationDocumentBytes/);
  assert.match(quarantine, /grantYjsPageRecovery/);
  assert.match(quarantine, /storeRecoveryCandidate/);
  assert.match(quarantine, /kind:\s*"YJS_UPDATE"/);
  assert.match(quarantine, /RECOVERY_VAULT_QUOTA_EXCEEDED/);
});
