import assert from "node:assert/strict";
import test from "node:test";
import {
  assessInitialCollaborationBootstrap,
  CollaborationBootstrapStateError
} from "../src/lib/collaboration-bootstrap.ts";

function storedBlock(overrides = {}) {
  return {
    id: "block-1",
    page_id: "page-1",
    parent_block_id: null,
    type: "MARKDOWN",
    markdown: "critical note",
    html_cache: "<p>critical note</p>",
    checked: 0,
    sort_order: 0,
    metadata: JSON.stringify({ z: 1, nested: { b: true, a: "value" } }),
    created_at: "2026-07-30 00:00:00",
    updated_at: "2026-07-30 00:00:00",
    ...overrides
  };
}

function candidateBlock(overrides = {}) {
  return {
    id: "block-1",
    type: "MARKDOWN",
    markdown: "critical note",
    checked: false,
    parentBlockId: null,
    sortOrder: 0,
    metadata: { nested: { a: "value", b: true }, z: 1 },
    ...overrides
  };
}

function assess({ title = "Canonical page", blocks = [candidateBlock()], deletedAttachmentIds = [], stored = [storedBlock()] } = {}) {
  return assessInitialCollaborationBootstrap({
    pageTitle: "Canonical page",
    storedBlocks: stored,
    candidate: { title, blocks, deletedAttachmentIds }
  });
}

test("an exact first Yjs document is accepted independent of block and metadata key order", () => {
  const secondStored = storedBlock({
    id: "block-2",
    parent_block_id: "block-1",
    sort_order: 10,
    markdown: "child",
    metadata: null
  });
  const secondCandidate = candidateBlock({
    id: "block-2",
    parentBlockId: "block-1",
    sortOrder: 10,
    markdown: "child",
    metadata: null
  });

  assert.deepEqual(assess({
    stored: [secondStored, storedBlock()],
    blocks: [candidateBlock(), secondCandidate]
  }), { accepted: true });
});

test("a syntactically valid but incomplete bootstrap is rejected before durability", () => {
  const result = assess({ blocks: [] });
  assert.equal(result.accepted, false);
  assert.deepEqual(result.summary, {
    invalidCandidate: false,
    titleMismatch: false,
    canonicalBlockCount: 1,
    candidateBlockCount: 0,
    missingBlockCount: 1,
    extraBlockCount: 0,
    changedBlockCount: 0,
    attachmentTombstoneCount: 0
  });
});

test("changed content, extra blocks, and bootstrap attachment tombstones are rejected", () => {
  const result = assess({
    blocks: [
      candidateBlock({ markdown: "truncated" }),
      candidateBlock({ id: "unexpected", markdown: "extra" })
    ],
    deletedAttachmentIds: ["attachment-1"]
  });
  assert.equal(result.accepted, false);
  assert.equal(result.summary.changedBlockCount, 1);
  assert.equal(result.summary.extraBlockCount, 1);
  assert.equal(result.summary.attachmentTombstoneCount, 1);
});

test("a changed title is rejected even when every block matches", () => {
  const result = assess({ title: "Stale page" });
  assert.equal(result.accepted, false);
  assert.equal(result.summary.titleMismatch, true);
});

test("invalid relational metadata fails closed instead of being normalized away", () => {
  assert.throws(
    () => assess({ stored: [storedBlock({ metadata: "{not-json" })] }),
    (error) => error instanceof CollaborationBootstrapStateError
  );
});
