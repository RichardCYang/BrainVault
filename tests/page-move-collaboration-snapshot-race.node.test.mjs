import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pages = readFileSync(path.join(root, "src/routes/page.routes.ts"), "utf8").replace(/\r\n/g, "\n");
const recovery = readFileSync(
  path.join(root, "src/lib/recovery-candidates.ts"),
  "utf8"
).replace(/\r\n/g, "\n");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("reproduction: an RR move snapshot can miss the descendant collaboration lineage admitted while it waits", () => {
  const descendantPageId = "page_child";
  const currentDocumentEpoch = "epoch_after_root_snapshot";

  // Transaction A authorizes/locks the moved root and establishes a consistent
  // REPEATABLE READ snapshot before it can lock a busy descendant.
  const rootAuthorizationSnapshot = [];

  // Transaction B, which already owns the descendant page lock, admits a live
  // collaboration session and commits before A acquires that descendant lock.
  const currentRowsAfterWait = [
    { pageId: descendantPageId, documentEpoch: currentDocumentEpoch }
  ];

  const vulnerableCapturedEpochs = new Set(
    rootAuthorizationSnapshot.map((row) => `${row.pageId}:${row.documentEpoch}`)
  );
  const fixedCapturedEpochs = new Set(
    currentRowsAfterWait.map((row) => `${row.pageId}:${row.documentEpoch}`)
  );

  assert.equal(
    vulnerableCapturedEpochs.has(`${descendantPageId}:${currentDocumentEpoch}`),
    false,
    "the old consistent snapshot misses the room that must be retired after the move"
  );
  assert.equal(
    fixedCapturedEpochs.has(`${descendantPageId}:${currentDocumentEpoch}`),
    true,
    "a locking/current read captures the lineage that existed at the scope-change boundary"
  );
});

test("collection-scope moves capture collaboration lineages with a current locking read", () => {
  const helper = section(
    pages,
    "async function getPageCollaborationDocumentEpochs(",
    "async function assertCollaborationMaterialized("
  );
  assert.match(helper, /\{ lock = false \}: \{ lock\?: boolean \} = \{\}/);
  assert.match(
    helper,
    /FROM page_collaboration_state[\s\S]*ORDER BY page_id ASC\$\{lock \? " FOR UPDATE" : ""\}/,
    "lineage capture must support a deterministic SELECT ... FOR UPDATE"
  );

  const patch = section(pages, 'pageRouter.patch("/:pageId"', 'pageRouter.delete(\n  "/:pageId"');
  const capture = patch.indexOf("const previousCollaborationLineages = await getPageCollaborationDocumentEpochs(");
  const lockingOption = patch.indexOf("{ lock: true }", capture);
  const rewrite = patch.indexOf("await replacePageSubtreeCollectionMembership(", capture);
  const stateRotation = patch.indexOf('DELETE FROM page_collaboration_state WHERE page_id = ?', rewrite);

  assert.ok(capture >= 0, "move must capture the pre-transition collaboration lineage");
  assert.ok(lockingOption > capture, "move lineage capture must request a current locking read");
  assert.ok(rewrite > lockingOption, "membership rewrite must stay after current lineage capture");
  assert.ok(stateRotation > rewrite, "collaboration state rotation must stay after membership rewrite");
});

test("reproduction: stale recovery reads can omit a newly admitted editor and document epoch", () => {
  const pageId = "page_child";
  const editorId = "user_editor";
  const documentEpoch = "epoch_current";

  const oldSnapshot = { states: [], editors: [] };
  const currentAtDestructiveBoundary = {
    states: [{ pageId, documentEpoch }],
    editors: [{ pageId, userId: editorId }]
  };

  function yjsRecoveryKeys(view) {
    const epochByPage = new Map(view.states.map((state) => [state.pageId, state.documentEpoch]));
    return new Set(
      view.editors
        .map((editor) => {
          const epoch = epochByPage.get(editor.pageId);
          return epoch ? `${editor.pageId}:${editor.userId}:yjs:${epoch}` : null;
        })
        .filter(Boolean)
    );
  }

  const expected = `${pageId}:${editorId}:yjs:${documentEpoch}`;
  assert.equal(
    yjsRecoveryKeys(oldSnapshot).has(expected),
    false,
    "plain RR reads can omit the recovery grant for the current editor/epoch"
  );
  assert.equal(
    yjsRecoveryKeys(currentAtDestructiveBoundary).has(expected),
    true,
    "current reads preserve recovery for the editor/epoch that actually existed before teardown"
  );
});

test("destructive recovery preservation uses current locking reads for state and effective editors", () => {
  const helper = section(
    recovery,
    "export async function preserveRecoveryGrantsForPages(",
    "export async function storeRecoveryCandidate("
  );

  assert.match(
    helper,
    /FROM page_collaboration_state[\s\S]*ORDER BY page_id ASC[\s\S]*FOR UPDATE/,
    "the collaboration document epoch must not come from an older RR snapshot"
  );
  assert.match(
    helper,
    /FROM page_shares[\s\S]*ORDER BY page_id ASC, user_id ASC[\s\S]*FOR UPDATE/,
    "direct editors must be captured with a current locking read"
  );
  assert.match(
    helper,
    /FROM page_collection_memberships pcm[\s\S]*INNER JOIN collection_shares cs[\s\S]*ORDER BY pcm\.page_id ASC, cs\.user_id ASC[\s\S]*FOR UPDATE/,
    "collection-derived editors must be captured with a current locking read"
  );
  assert.doesNotMatch(
    helper,
    /FROM \(\s*SELECT ps\.page_id, ps\.user_id[\s\S]*UNION[\s\S]*\) effective/,
    "the old plain derived-table read could be pinned to a stale consistent snapshot"
  );
});
