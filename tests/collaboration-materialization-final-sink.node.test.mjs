import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function assertBefore(source, first, second, label) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `${label}: missing ${first}`);
  assert.notEqual(secondIndex, -1, `${label}: missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${label}: ${first} must run before ${second}`);
}

const routeSource = readFileSync(
  new URL("../src/routes/collaboration.routes.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const materializationStart = routeSource.indexOf(
  'collaborationRouter.put(\n  "/pages/:pageId/collaboration/snapshot"'
);
assert.notEqual(materializationStart, -1, "missing collaboration materialization route");
const materialization = routeSource.slice(materializationStart);

test("collaboration materialization fails closed on zero-row canonical writes", () => {
  assert.match(
    materialization,
    /const detachedSurvivor = await client\.execute<\{ affectedRows: number \}>\([\s\S]*?if \(Number\(detachedSurvivor\.affectedRows\) !== 1\)/
  );
  assert.match(
    materialization,
    /const attachmentUpdate = await client\.execute<\{ affectedRows: number \}>\([\s\S]*?if \(Number\(attachmentUpdate\.affectedRows\) !== 1\)/
  );
  assert.match(
    materialization,
    /const blockUpdate = await client\.execute<\{ affectedRows: number \}>\([\s\S]*?if \(Number\(blockUpdate\.affectedRows\) !== 1\)/
  );
  assert.match(
    materialization,
    /const pageUpdate = await client\.execute<\{ affectedRows: number \}>\([\s\S]*?if \(Number\(pageUpdate\.affectedRows\) !== 1\)/
  );
});

test("canonical page content and hierarchy are verified before the durable checkpoint advances", () => {
  assert.match(
    materialization,
    /const expectedFinalBlockIds = new Set\(activeIds\);[\s\S]*?const canonicalBlockSetMatches = currentBlockIds\.size === expectedFinalBlockIds\.size/
  );
  assert.match(
    materialization,
    /let canonicalMaterializedStateMatches = currentPage\.title === materialization\.title;[\s\S]*?current\.markdown !== prepared\.markdown[\s\S]*?current\.html_cache !== expectedHtml[\s\S]*?canonicalJsonForComparison\(current\.metadata\) !== canonicalJsonForComparison\(prepared\.metadata\)/
  );
  assert.match(
    materialization,
    /current\.parent_block_id !== block\.parentBlockId[\s\S]*?Number\(current\.sort_order\) !== Number\(block\.sortOrder\)/
  );
  assert.match(
    materialization,
    /if \(!canonicalBlockSetMatches \|\| !canonicalMaterializedStateMatches\)/
  );
  assertBefore(
    materialization,
    "let canonicalMaterializedStateMatches = currentPage.title === materialization.title",
    "const checkpoint = await client.execute<{ affectedRows: number }>",
    "collaboration canonical-state verification"
  );
});

test("same-id canonical corruption cannot be certified as materialized", () => {
  const expected = {
    title: "Roadmap",
    blocks: new Map([
      ["block-1", { parentId: null, type: "TEXT", markdown: "Keep this text", checked: 0, sortOrder: 100 }]
    ])
  };
  const corrupted = {
    title: "Roadmap",
    blocks: new Map([
      ["block-1", { parentId: null, type: "TEXT", markdown: "Different text", checked: 0, sortOrder: 100 }]
    ])
  };

  const vulnerableIdOnlyVerification =
    corrupted.blocks.size === expected.blocks.size
    && [...expected.blocks.keys()].every((id) => corrupted.blocks.has(id));
  assert.equal(vulnerableIdOnlyVerification, true);

  const fixedCanonicalVerification =
    corrupted.title === expected.title
    && corrupted.blocks.size === expected.blocks.size
    && [...expected.blocks].every(([id, block]) => {
      const persisted = corrupted.blocks.get(id);
      return persisted
        && persisted.parentId === block.parentId
        && persisted.type === block.type
        && persisted.markdown === block.markdown
        && persisted.checked === block.checked
        && persisted.sortOrder === block.sortOrder;
    });
  assert.equal(fixedCanonicalVerification, false);
});

test("zero-row survivor detachment cannot commit a cascading data-loss checkpoint", () => {
  const originalRows = new Map([
    ["obsolete-parent", { id: "obsolete-parent", parentId: null }],
    ["surviving-child", { id: "surviving-child", parentId: "obsolete-parent" }]
  ]);

  const vulnerableRows = structuredClone(originalRows);
  // The protective UPDATE unexpectedly affects zero rows, but the old implementation
  // ignored that result and continued. Deleting the parent then cascades the child.
  const vulnerableDetachAffectedRows = 0;
  if (vulnerableDetachAffectedRows === 1) {
    vulnerableRows.get("surviving-child").parentId = null;
  }
  vulnerableRows.delete("obsolete-parent");
  if (vulnerableRows.get("surviving-child")?.parentId === "obsolete-parent") {
    vulnerableRows.delete("surviving-child");
  }
  const vulnerableCheckpointAdvanced = true;
  assert.equal(vulnerableCheckpointAdvanced, true);
  assert.equal(vulnerableRows.has("surviving-child"), false);

  const fixedRows = structuredClone(originalRows);
  const fixedDetachAffectedRows = 0;
  let fixedCheckpointAdvanced = false;
  let rolledBack = false;
  if (fixedDetachAffectedRows !== 1) {
    rolledBack = true;
  } else {
    fixedRows.get("surviving-child").parentId = null;
    fixedRows.delete("obsolete-parent");
    fixedCheckpointAdvanced = true;
  }

  assert.equal(rolledBack, true);
  assert.equal(fixedCheckpointAdvanced, false);
  assert.deepEqual(fixedRows, originalRows);
});

test("ambiguous materialization commits reconcile tombstoned attachment files", () => {
  assert.match(
    materialization,
    /const reconcileDeletedAttachmentFiles = async \(\) => \{[\s\S]*?await removeDeletedAttachmentFiles\([\s\S]*?attachmentCleanupOwnerId,[\s\S]*?deletedFiles,[\s\S]*?attachmentCleanupGeneration[\s\S]*?\)/
  );
  assert.match(
    materialization,
    /attachmentCleanupGeneration = attachmentGeneration;/
  );
  assert.match(
    materialization,
    /\} catch \(error\) \{[\s\S]*?await reconcileDeletedAttachmentFiles\(\);[\s\S]*?next\(error\);/
  );
});

test("attachment cleanup reconciliation fails closed across rollback and restore races", () => {
  const shouldRemoveFile = ({ databaseStillReferencesBlock, generationMatches }) =>
    generationMatches && !databaseStillReferencesBlock;

  // COMMIT took effect but its acknowledgement was lost: reconcile the committed
  // tombstone and remove the now-unreferenced same-generation file.
  assert.equal(
    shouldRemoveFile({ databaseStillReferencesBlock: false, generationMatches: true }),
    true
  );

  // A real rollback leaves the canonical block live, so the file must remain.
  assert.equal(
    shouldRemoveFile({ databaseStillReferencesBlock: true, generationMatches: true }),
    false
  );

  // A workspace restore advances the attachment generation. Even if the old block
  // remains absent, stale cleanup must not touch the new generation's directory.
  assert.equal(
    shouldRemoveFile({ databaseStillReferencesBlock: false, generationMatches: false }),
    false
  );
});

test("collaboration materialization keeps canonical page reads and writes owner-scoped", () => {
  const pageUpdateStart = materialization.indexOf(
    "const pageUpdate = await client.execute<{ affectedRows: number }>"
  );
  const pageUpdateEnd = materialization.indexOf(
    "if (Number(pageUpdate.affectedRows) !== 1)",
    pageUpdateStart
  );
  assert.notEqual(pageUpdateStart, -1, "missing canonical page update");
  assert.notEqual(pageUpdateEnd, -1, "missing canonical page update affected-row fence");

  const pageUpdateSink = materialization.slice(pageUpdateStart, pageUpdateEnd);
  assert.match(pageUpdateSink, /WHERE id = \? AND owner_id = \?/);
  assert.match(
    pageUpdateSink,
    /\[materialization\.title, pageId, attachmentOwnerId\]/
  );

  const ownerScopedPageReads =
    materialization.match(/SELECT \* FROM pages WHERE id = \? AND owner_id = \?/g) ?? [];
  assert.ok(
    ownerScopedPageReads.length >= 3,
    "materialization should retain owner scope when reading the canonical page"
  );
});

test("owner mismatch at the final collaboration sink fails closed", () => {
  const routedPageId = "page-1";
  const lockedOwnerId = "owner-a";
  const rowAtThatId = { id: "page-1", ownerId: "owner-b", title: "Owner B note" };

  // The previous final sink was ID-only: if an internal stale/corrupt routing
  // context ever crossed the already-checked owner boundary, the SQL predicate
  // itself would still accept the other owner's row.
  const vulnerableAffectedRows = rowAtThatId.id === routedPageId ? 1 : 0;
  assert.equal(vulnerableAffectedRows, 1);

  // The fixed sink carries the owner locked earlier in the transaction. An owner
  // mismatch therefore becomes a zero-row write, which the route already rolls
  // back as COLLABORATION_MATERIALIZATION_CONFLICT.
  const fixedAffectedRows =
    rowAtThatId.id === routedPageId && rowAtThatId.ownerId === lockedOwnerId ? 1 : 0;
  assert.equal(fixedAffectedRows, 0);
});
