import assert from "node:assert/strict";
import test from "node:test";
import { reconcileCanonicalAttachment } from "../public/collaboration-attachment-reconcile.js";

const canonical = {
  id: "att_1",
  type: "ATTACHMENT",
  markdown: "canonical.pdf",
  checked: false,
  parentBlockId: "old_parent",
  sortOrder: 9,
  metadata: {
    attachment: {
      originalName: "canonical.pdf",
      mimeType: "application/pdf",
      size: 1234
    }
  }
};

const availableIds = new Set(["att_1", "old_parent", "new_parent"]);

test("an existing attachment keeps its durable Yjs position while canonical content wins", () => {
  const current = {
    ...canonical,
    markdown: "forged.txt",
    parentBlockId: "new_parent",
    sortOrder: 2,
    metadata: { attachment: { originalName: "forged.txt", mimeType: "text/plain", size: 1 } }
  };

  const merged = reconcileCanonicalAttachment(canonical, current, availableIds);

  assert.equal(merged.parentBlockId, "new_parent");
  assert.equal(merged.sortOrder, 2);
  assert.equal(merged.markdown, canonical.markdown);
  assert.deepEqual(merged.metadata, canonical.metadata);
  assert.equal(merged.type, "ATTACHMENT");
});

test("a genuinely missing attachment adopts the relational server position", () => {
  const merged = reconcileCanonicalAttachment(canonical, null, availableIds);

  assert.equal(merged.parentBlockId, "old_parent");
  assert.equal(merged.sortOrder, 9);
});

test("an existing attachment never falls back to a stale SQL parent", () => {
  const merged = reconcileCanonicalAttachment(
    canonical,
    { ...canonical, parentBlockId: "deleted_parent", sortOrder: 4 },
    availableIds
  );

  assert.equal(merged.parentBlockId, null);
  assert.equal(merged.sortOrder, 4);
});

test("self-parenting and invalid sort values are normalized fail-closed", () => {
  const merged = reconcileCanonicalAttachment(
    canonical,
    { ...canonical, parentBlockId: "att_1", sortOrder: Number.POSITIVE_INFINITY },
    availableIds
  );

  assert.equal(merged.parentBlockId, null);
  assert.equal(merged.sortOrder, 0);
});
