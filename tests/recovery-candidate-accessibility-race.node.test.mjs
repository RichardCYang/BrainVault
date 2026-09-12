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

  assert.doesNotMatch(
    reconciliation,
    /const accessiblePageIds = new Set\(/,
    "a pre-upload accessibility snapshot must not authorize later local recovery deletion"
  );
  assert.match(
    reconciliation,
    /const isCurrentlySafeToRemoveLocalRecovery = \(pageId\) => \([\s\S]*state\.user\?\.id === accountId[\s\S]*state\.allPages\.some[\s\S]*state\.selectedPage\?\.id !== pageId/,
    "cleanup must re-check the current account and current page visibility"
  );

  const uploadIndex = reconciliation.indexOf("await uploadServerRecoveryCandidate({");
  const cleanupCheckIndex = reconciliation.indexOf(
    "if (isCurrentlySafeToRemoveLocalRecovery(record.pageId))",
    uploadIndex
  );
  assert.ok(uploadIndex >= 0 && cleanupCheckIndex > uploadIndex, "cleanup authorization must occur after upload settles");
});

test("race model preserves local recovery when a page is restored during upload", () => {
  const accountId = "usr-a";
  const pageId = "page-1";
  const state = { user: { id: accountId }, allPages: [], selectedPage: null };
  const staleAccessiblePageIds = new Set(state.allPages.map((page) => page.id));

  // The page is restored/recreated while the server candidate upload is in flight.
  state.allPages.push({ id: pageId });

  const vulnerableWouldRemove = !staleAccessiblePageIds.has(pageId);
  const fixedWouldRemove = (
    state.user?.id === accountId
    && !state.allPages.some((page) => page.id === pageId)
    && state.selectedPage?.id !== pageId
  );

  assert.equal(vulnerableWouldRemove, true);
  assert.equal(fixedWouldRemove, false);
});
