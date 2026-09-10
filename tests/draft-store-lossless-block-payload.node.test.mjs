import assert from "node:assert/strict";
import test from "node:test";
import { createPageDraftStore } from "../public/draft-store.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function createRawDraft(payload) {
  return JSON.stringify({
    schemaVersion: 2,
    userId: "user-1",
    pageId: "page-1",
    sourceId: "tab-a",
    updatedAt: 1,
    title: null,
    blockOrder: null,
    blocks: {
      "block-1": {
        revision: 1,
        expectedVersion: 7,
        updatedAt: 1,
        payload
      }
    }
  });
}

test("direct recovery rejects incomplete block payloads without overwriting their raw evidence", () => {
  const storage = new MemoryStorage();
  const key = "brainvault.pageDraft.v2:user-1:page-1:tab-a";
  const raw = createRawDraft({ type: "MARKDOWN", checked: false, metadata: null });
  storage.setItem(key, raw);

  const store = createPageDraftStore(storage, { sourceId: "tab-a" });
  const inspection = store.inspectPageDrafts("user-1", "page-1");

  assert.equal(inspection.reliable, true);
  assert.deepEqual(inspection.records, []);
  assert.deepEqual(inspection.unreadableKeys, [key]);
  assert.equal(storage.getItem(key), raw);
});

test("direct recovery rejects invalid metadata and unknown payload fields losslessly", () => {
  for (const payload of [
    { type: "DATABASE", markdown: "important", checked: false, metadata: "damaged" },
    { type: "MARKDOWN", markdown: "important", checked: false, metadata: null, futureField: "preserve-me" }
  ]) {
    const storage = new MemoryStorage();
    const key = "brainvault.pageDraft.v2:user-1:page-1:tab-a";
    const raw = createRawDraft(payload);
    storage.setItem(key, raw);

    const store = createPageDraftStore(storage, { sourceId: "tab-a" });
    const inspection = store.inspectPageDrafts("user-1", "page-1");

    assert.deepEqual(inspection.records, []);
    assert.deepEqual(inspection.unreadableKeys, [key]);
    assert.equal(storage.getItem(key), raw);
  }
});

test("valid complete block recovery payloads remain readable", () => {
  const storage = new MemoryStorage();
  const key = "brainvault.pageDraft.v2:user-1:page-1:tab-a";
  const payload = {
    type: "MARKDOWN",
    markdown: "keep this note",
    checked: false,
    metadata: null
  };
  storage.setItem(key, createRawDraft(payload));

  const store = createPageDraftStore(storage, { sourceId: "tab-a" });
  const inspection = store.inspectPageDrafts("user-1", "page-1");

  assert.equal(inspection.unreadableKeys.length, 0);
  assert.equal(inspection.records.length, 1);
  assert.deepEqual(inspection.records[0].blocks["block-1"].payload, payload);
});
