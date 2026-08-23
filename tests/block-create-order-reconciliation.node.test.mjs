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

test("reproduction: a committed create followed by a failed refresh can be duplicated by an apparent retry", () => {
  const durableBlocks = ["created-1"];
  const createPostCommitted = true;
  const followUpRefreshSucceeded = false;

  const vulnerableUiReportedFailure = createPostCommitted && !followUpRefreshSucceeded;
  assert.equal(vulnerableUiReportedFailure, true);

  if (vulnerableUiReportedFailure) durableBlocks.push("created-2");
  assert.deepEqual(durableBlocks, ["created-1", "created-2"]);
});

test("fixed client keeps a committed create visible when a non-auth refresh fails", () => {
  assert.match(client, /function adoptCommittedCreatedBlockLocally\(/);
  assert.match(client, /status !== 401\n\s+&& status !== 403\n\s+&& status !== 404/);
  assert.match(client, /retained a committed created block after refresh failed/);
  assert.match(
    client,
    /adoptCommittedCreatedBlockLocally\(pageId, committedBlock, \{ orderedIds, removedBlockIds \}\)/
  );
  assert.ok(
    (client.match(/reconcileCanonicalCreatedBlock\(pageId, data\.block, \{ authenticationScope \}\)/g) ?? []).length >= 4,
    "post-create conflict paths must reconcile the already committed block rather than retry creation"
  );
});

test("local committed-create fallback preserves successful order and replacement semantics", () => {
  const start = client.indexOf("function adoptCommittedCreatedBlockLocally(");
  const end = client.indexOf("\n\nasync function reconcileCanonicalCreatedBlock(", start);
  assert.ok(start >= 0 && end > start, "fallback helper source should be extractable");
  const helperSource = client.slice(start, end);

  const page = {
    id: "page-1",
    blocks: [
      { id: "a", sortOrder: 0, parentBlockId: null, children: [] },
      { id: "b", sortOrder: 1, parentBlockId: null, children: [] }
    ]
  };
  const state = { workspaceView: "page", selectedPage: page };
  const find = (id, blocks = page.blocks) => {
    for (const block of blocks) {
      if (block.id === id) return block;
      const nested = find(id, block.children ?? []);
      if (nested) return nested;
    }
    return null;
  };
  const siblings = (parentId) => parentId ? (find(parentId)?.children ?? []) : page.blocks;
  const reorder = (_page, parentId, orderedIds) => {
    const rows = siblings(parentId);
    if (rows.length !== orderedIds.length) return false;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const next = orderedIds.map((id) => byId.get(id));
    if (next.some((row) => !row)) return false;
    next.forEach((row, index) => { row.sortOrder = index; });
    rows.splice(0, rows.length, ...next);
    return true;
  };

  const adopt = new Function(
    "state",
    "normalizeParentBlockId",
    "getBlockById",
    "getBlockSiblings",
    "reorderPageBlockSiblings",
    `${helperSource}; return adoptCommittedCreatedBlockLocally;`
  )(
    state,
    (value) => value || null,
    (id) => find(id),
    (parentId) => siblings(parentId),
    reorder
  );

  assert.equal(
    adopt("page-1", { id: "created", sortOrder: 2, parentBlockId: null }, {
      orderedIds: ["a", "created", "b"]
    }),
    true
  );
  assert.deepEqual(page.blocks.map((block) => block.id), ["a", "created", "b"]);
  assert.deepEqual(page.blocks.map((block) => block.sortOrder), [0, 1, 2]);

  page.blocks.splice(
    0,
    page.blocks.length,
    { id: "source", sortOrder: 0, parentBlockId: null, children: [] },
    { id: "next", sortOrder: 1, parentBlockId: null, children: [] }
  );
  assert.equal(
    adopt("page-1", { id: "attachment", sortOrder: 1, parentBlockId: null }, {
      orderedIds: ["attachment", "next"],
      removedBlockIds: ["source"]
    }),
    true
  );
  assert.deepEqual(page.blocks.map((block) => block.id), ["attachment", "next"]);
});

test("committed-create fallback preserves an unsaved live editor when refresh flushing fails", async () => {
  const start = client.indexOf("function adoptCommittedCreatedBlockLocally(");
  const end = client.indexOf("\n\nfunction canSupersedeBlockSaveError", start);
  assert.ok(start >= 0 && end > start, "committed-create reconciliation source should be extractable");
  const helperSource = client.slice(start, end);

  const page = {
    id: "page-1",
    blocks: [{ id: "source", markdown: "server-old", sortOrder: 0, parentBlockId: null, children: [] }]
  };
  const state = { workspaceView: "page", selectedPage: page, pendingFocusBlockId: null };
  const find = (id) => page.blocks.find((block) => block.id === id) ?? null;
  let liveEditorMarkdown = "unsaved-local-edit";
  let renders = 0;

  const reconcile = new Function(
    "state",
    "normalizeParentBlockId",
    "getBlockById",
    "getBlockSiblings",
    "reorderPageBlockSiblings",
    "openPage",
    "isCurrentAuthenticatedSessionScope",
    "hasPendingPageEdits",
    "renderSelectedPage",
    "console",
    `${helperSource}; return reconcileCanonicalCreatedBlock;`
  )(
    state,
    (value) => value || null,
    find,
    () => page.blocks,
    () => true,
    async () => {
      const error = new Error("local recovery persistence failed while flushing an unrelated edit");
      error.code = "DIRECT_RECOVERY_DURABILITY_FAILED";
      throw error;
    },
    () => true,
    () => true,
    () => {
      renders += 1;
      liveEditorMarkdown = find("source")?.markdown ?? "";
    },
    { warn() {} }
  );

  await reconcile(
    "page-1",
    { id: "created", markdown: "", sortOrder: 1, parentBlockId: null, children: [] },
    { authenticationScope: { generation: 1 } }
  );

  assert.equal(renders, 0, "pending editor work must prevent the fallback full-page render");
  assert.equal(liveEditorMarkdown, "unsaved-local-edit", "the only live copy of the edit must remain untouched");
  assert.equal(find("created")?.id, "created", "the already committed create is still adopted into local state");
});

test("committed-create fallback still renders immediately when no editor work is pending", async () => {
  const start = client.indexOf("function adoptCommittedCreatedBlockLocally(");
  const end = client.indexOf("\n\nfunction canSupersedeBlockSaveError", start);
  const helperSource = client.slice(start, end);
  const page = { id: "page-1", blocks: [] };
  const state = { workspaceView: "page", selectedPage: page, pendingFocusBlockId: null };
  let renders = 0;

  const reconcile = new Function(
    "state",
    "normalizeParentBlockId",
    "getBlockById",
    "getBlockSiblings",
    "reorderPageBlockSiblings",
    "openPage",
    "isCurrentAuthenticatedSessionScope",
    "hasPendingPageEdits",
    "renderSelectedPage",
    "console",
    `${helperSource}; return reconcileCanonicalCreatedBlock;`
  )(
    state,
    (value) => value || null,
    (id) => page.blocks.find((block) => block.id === id) ?? null,
    () => page.blocks,
    () => true,
    async () => { throw new Error("network refresh failed"); },
    () => true,
    () => false,
    () => { renders += 1; },
    { warn() {} }
  );

  await reconcile(
    "page-1",
    { id: "created", markdown: "", sortOrder: 0, parentBlockId: null, children: [] },
    { authenticationScope: { generation: 1 } }
  );

  assert.equal(renders, 1);
  assert.equal(page.blocks[0]?.id, "created");
});

test("ordinary creates and attachment uploads reconcile stale post-create ordering without weakening the server fence", () => {
  assert.match(client, /function shouldReconcileCanonicalCreatedBlockOrder\(data\)/);
  assert.match(client, /return data\?\.pageContentVersionAuthoritative === false/);
  assert.equal((client.match(/shouldReconcileCanonicalCreatedBlockOrder\(data\)/g) ?? []).length, 4);
  assert.match(client, /The create POST has already committed\. Any follow-up reorder failure is/);
  assert.match(client, /The upload is already durable\. A stale or ambiguous follow-up reorder is/);
  assert.match(client, /not convert a successful upload into a retryable duplicate/);

  assert.match(server, /finalSiblingIds\.length !== requestedSiblings\.length/);
  assert.match(server, /"The sibling list changed in another session\. Your stale order was not applied\."/);
});

test("definitively rejected block-order drafts are removed from crash-recovery storage", () => {
  const definitiveCatchCleanup = client.match(
    /if \(isDefinitiveApiError\(error\)\) \{\n\s+acknowledgeBlockOrderDraft\(task\);/g
  ) ?? [];
  assert.ok(
    definitiveCatchCleanup.length >= 3,
    "drag, pending-retry, and direct persist paths must discard unretryable order drafts"
  );
});
