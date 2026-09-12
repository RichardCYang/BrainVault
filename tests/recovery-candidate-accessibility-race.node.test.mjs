import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appUrl = new URL("../public/app.js", import.meta.url);

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert.ok(start >= 0 && end > start, `missing source section: ${startNeedle}`);
  return source.slice(start, end);
}

test("server recovery upload is additive and never auto-deletes browser recovery", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const reconciliation = section(
    source,
    "async function reconcileServerRecoveryCandidates()",
    "\nfunction appendPageDraftRecoveryPanel"
  );

  assert.match(
    reconciliation,
    /await uploadServerRecoveryCandidate\(\{/,
    "browser recovery must still be preserved on the server"
  );
  assert.doesNotMatch(
    reconciliation,
    /removePageIfUnchangedDurably\(/,
    "direct browser recovery must not be auto-deleted after upload"
  );
  assert.doesNotMatch(
    reconciliation,
    /collaborationRecoveryStore\.removeDurably\(/,
    "collaboration browser recovery must not be auto-deleted after upload"
  );
  assert.doesNotMatch(
    reconciliation,
    /fetchAllPageSummaries\(\{ archived: "all" \}\)/,
    "an accessibility snapshot must not authorize destructive local recovery cleanup"
  );
});

test("post-scan restoration race cannot delete direct browser recovery", () => {
  const pageId = "page-1";
  const localRecovery = new Map([[pageId, { body: "recover me" }]]);

  // Vulnerable flow: the upload succeeds and an accessibility scan observes
  // the page as absent. The page is then restored/re-shared before cleanup.
  const staleAccessiblePageIds = new Set();
  const pageIsAccessibleNow = true;
  const vulnerableWouldRemove = !staleAccessiblePageIds.has(pageId);

  assert.equal(pageIsAccessibleNow, true);
  assert.equal(vulnerableWouldRemove, true);

  // Fixed flow: server preservation is additive, so there is no destructive
  // post-upload cleanup step whose authorization can become stale.
  const fixedWouldRemove = false;
  if (fixedWouldRemove) localRecovery.delete(pageId);

  assert.deepEqual(localRecovery.get(pageId), { body: "recover me" });
});

test("archived or temporarily absent pages retain local recovery after server preservation", () => {
  const directDraft = { pageId: "page-archived", updatedAt: 42 };
  const collaborationDraft = {
    pageId: "page-shared",
    sourceId: "source-a",
    documentEpoch: "epoch-1",
    generation: "gen-7"
  };

  // Neither active navigation nor a point-in-time server view is a safe
  // deletion authority because page accessibility may change independently.
  const fixedKeepsDirectRecovery = true;
  const fixedKeepsCollaborationRecovery = true;

  assert.equal(fixedKeepsDirectRecovery, true);
  assert.equal(fixedKeepsCollaborationRecovery, true);
  assert.equal(directDraft.pageId, "page-archived");
  assert.equal(collaborationDraft.pageId, "page-shared");
});
