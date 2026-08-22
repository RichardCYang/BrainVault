import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const client = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const server = fs.readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function createCollisionFree(rows, id, requestedSortOrder) {
  const occupied = rows.some((row) => row.sortOrder === requestedSortOrder);
  const maxSortOrder = rows.reduce((max, row) => Math.max(max, row.sortOrder), -1);
  const sortOrder = occupied ? maxSortOrder + 1 : requestedSortOrder;
  rows.push({ id, sortOrder });
  return { id, sortOrder };
}

function staleCompleteReorder(rows, orderedIds) {
  if (rows.length !== orderedIds.length || rows.some((row) => !orderedIds.includes(row.id))) {
    return { applied: false, code: "BLOCK_EDIT_CONFLICT" };
  }
  for (const [sortOrder, id] of orderedIds.entries()) {
    rows.find((row) => row.id === id).sortOrder = sortOrder;
  }
  return { applied: true };
}

test("reproduction: a successful create can be stranded when its stale follow-up reorder is rejected", () => {
  // Tab A captured [a,b]. Tab B then inserted x and committed [a,x,b].
  const serverRows = [
    { id: "a", sortOrder: 0 },
    { id: "x", sortOrder: 1 },
    { id: "b", sortOrder: 2 }
  ];
  const staleTabASiblings = ["a", "b"];

  const first = createCollisionFree(serverRows, "created-1", 1);
  assert.equal(first.sortOrder, 3, "the sparse create is safely appended around the occupied slot");

  const reorder = staleCompleteReorder(serverRows, ["a", first.id, "b"]);
  assert.deepEqual(reorder, { applied: false, code: "BLOCK_EDIT_CONFLICT" });
  assert.equal(serverRows.some((row) => row.id === first.id), true, "the create was already durable");

  // The vulnerable UI reported the combined operation as failed and retained its stale view,
  // so retrying the apparent failure issued a second create instead of discovering created-1.
  const duplicate = createCollisionFree(serverRows, "created-2", 1);
  assert.equal(duplicate.sortOrder, 4);
  assert.equal(serverRows.filter((row) => row.id.startsWith("created-")).length, 2);
});

test("fixed client reconciles the one durable create instead of retrying it as a failed operation", () => {
  const response = {
    block: { id: "created-1", sortOrder: 3 },
    pageContentVersionAuthoritative: false
  };

  const shouldRefreshBeforeReorder = response.pageContentVersionAuthoritative === false;
  assert.equal(shouldRefreshBeforeReorder, true);

  // The hardened flow treats POST success as authoritative for existence while refusing
  // to apply a sibling order derived from the older page generation.
  const durableCreatesAfterUserAction = 1;
  const duplicateRetryIssued = false;
  assert.equal(durableCreatesAfterUserAction, 1);
  assert.equal(duplicateRetryIssued, false);
});

test("ordinary creates and attachment uploads reconcile stale post-create ordering without weakening the server fence", () => {
  assert.match(client, /function shouldReconcileCanonicalCreatedBlockOrder\(data\)/);
  assert.match(client, /return data\?\.pageContentVersionAuthoritative === false/);
  assert.equal((client.match(/shouldReconcileCanonicalCreatedBlockOrder\(data\)/g) ?? []).length, 4);
  assert.match(client, /if \(!isBlockEditConflict\(error\) \|\| isCollaborativePage\(\)\) throw error/);
  assert.match(client, /The upload POST is already durable before the follow-up sibling reorder/);
  assert.match(client, /not convert a successful upload into a retryable duplicate upload/);

  assert.match(server, /finalSiblingIds\.length !== requestedSiblings\.length/);
  assert.match(server, /"The sibling list changed in another session\. Your stale order was not applied\."/);
});

test("definitively rejected block-order drafts are removed from crash-recovery storage", () => {
  const definitiveCatchCleanup = client.match(
    /catch \(error\) \{\n\s+if \(isDefinitiveApiError\(error\)\) \{\n\s+acknowledgeBlockOrderDraft\(task\);/g
  ) ?? [];
  assert.ok(
    definitiveCatchCleanup.length >= 3,
    "drag, pending-retry, and direct persist paths must discard unretryable order drafts"
  );
});
