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

test("server recovery upload re-checks live accessibility before deleting local recovery", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const reconciliation = section(
    source,
    "async function reconcileServerRecoveryCandidates()",
    "\nfunction appendPageDraftRecoveryPanel"
  );

  const firstUploadIndex = reconciliation.indexOf("await uploadServerRecoveryCandidate({");
  assert.ok(firstUploadIndex >= 0, "recovery upload must be present");
  assert.doesNotMatch(
    reconciliation.slice(0, firstUploadIndex),
    /const accessiblePageIds = new Set\(/,
    "a pre-upload accessibility snapshot must not authorize later local recovery deletion"
  );
  assert.match(
    reconciliation,
    /const isCurrentlySafeToRemoveLocalRecovery = \(pageId\) => \([\s\S]*state\.user\?\.id === accountId[\s\S]*!accessiblePageIds\.has\(pageId\)[\s\S]*state\.allPages\.some[\s\S]*state\.selectedPage\?\.id !== pageId/,
    "cleanup must require an archive-independent accessibility snapshot plus the current UI state"
  );
  assert.match(
    reconciliation,
    /fetchAllPageSummaries\(\{ archived: "all" \}\)/,
    "cleanup must include archived pages when establishing current accessibility"
  );

  const uploadIndex = reconciliation.indexOf("await uploadServerRecoveryCandidate({");
  const accessibilityScanIndex = reconciliation.indexOf('fetchAllPageSummaries({ archived: "all" })', uploadIndex);
  const cleanupCheckIndex = reconciliation.indexOf(
    "if (!isCurrentlySafeToRemoveLocalRecovery(record.pageId)) continue;",
    accessibilityScanIndex
  );
  assert.ok(
    uploadIndex >= 0 && accessibilityScanIndex > uploadIndex && cleanupCheckIndex > accessibilityScanIndex,
    "authoritative accessibility must be checked after upload settles and before local cleanup"
  );
});

test("race model preserves local recovery when a page is restored during upload", () => {
  const accountId = "usr-a";
  const pageId = "page-1";
  const state = { user: { id: accountId }, allPages: [], selectedPage: null };
  const staleAccessiblePageIds = new Set(state.allPages.map((page) => page.id));

  // The page is restored/recreated while the server candidate upload is in flight.
  state.allPages.push({ id: pageId });

  const vulnerableWouldRemove = !staleAccessiblePageIds.has(pageId);
  const accessiblePageIds = new Set();
  const fixedWouldRemove = (
    state.user?.id === accountId
    && !accessiblePageIds.has(pageId)
    && !state.allPages.some((page) => page.id === pageId)
    && state.selectedPage?.id !== pageId
  );

  assert.equal(vulnerableWouldRemove, true);
  assert.equal(fixedWouldRemove, false);
});

test("race model preserves local recovery for a live archived page omitted from active navigation", () => {
  const accountId = "usr-a";
  const pageId = "page-archived";
  const state = { user: { id: accountId }, allPages: [], selectedPage: null };

  // Active navigation intentionally excludes archived pages. An archive-independent
  // server scan still reports this page as accessible to the current principal.
  const accessiblePageIds = new Set([pageId]);

  const vulnerableWouldRemove = (
    state.user?.id === accountId
    && !state.allPages.some((page) => page.id === pageId)
    && state.selectedPage?.id !== pageId
  );
  const fixedWouldRemove = (
    state.user?.id === accountId
    && !accessiblePageIds.has(pageId)
    && !state.allPages.some((page) => page.id === pageId)
    && state.selectedPage?.id !== pageId
  );

  assert.equal(vulnerableWouldRemove, true);
  assert.equal(fixedWouldRemove, false);
});
