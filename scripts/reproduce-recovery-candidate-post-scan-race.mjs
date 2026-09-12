import assert from "node:assert/strict";

const pageId = "page-1";
const localRecovery = new Map([[pageId, { title: "unsaved local draft" }]]);

// Step 1: a deleted/unavailable page has local browser recovery.
// Step 2: the candidate upload to the server succeeds.
// Step 3: a point-in-time accessibility scan says the page is absent.
const staleAccessiblePageIds = new Set();

// Step 4: before IndexedDB cleanup runs, the page is restored/re-created or
// re-shared with the same principal.
const pageIsAccessibleNow = true;

// Old behavior: cleanup still trusts the stale scan and deletes local recovery.
const vulnerableWouldRemove = !staleAccessiblePageIds.has(pageId);
const vulnerableRecovery = new Map(localRecovery);
if (vulnerableWouldRemove) vulnerableRecovery.delete(pageId);

// Fixed behavior: server preservation is additive; no automatic local deletion
// follows the upload, so the access-change race has no destructive endpoint.
const fixedRecovery = new Map(localRecovery);

assert.equal(pageIsAccessibleNow, true);
assert.equal(vulnerableRecovery.has(pageId), false);
assert.equal(fixedRecovery.has(pageId), true);

console.log(JSON.stringify({
  scenario: "page access changes after recovery-candidate accessibility scan",
  vulnerable: {
    pageAccessibleAtCleanup: pageIsAccessibleNow,
    localRecoveryPreserved: vulnerableRecovery.has(pageId)
  },
  fixed: {
    pageAccessibleAtCleanup: pageIsAccessibleNow,
    localRecoveryPreserved: fixedRecovery.has(pageId)
  }
}, null, 2));
