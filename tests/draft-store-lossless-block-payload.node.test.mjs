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

test("direct recovery rejects malformed block writes before they can poison a recoverable record", () => {
  const storage = new MemoryStorage();
  const key = "brainvault.pageDraft.v2:user-1:page-1:tab-a";
  const store = createPageDraftStore(storage, { sourceId: "tab-a" });

  assert.equal(store.saveTitle({
    userId: "user-1",
    pageId: "page-1",
    value: "keep this title",
    expectedVersion: 4,
    revision: 1
  }), true);
  const original = storage.getItem(key);
  assert.equal(typeof original, "string");

  for (const payload of [
    { type: "MARKDOWN", markdown: "missing metadata", checked: false },
    { type: "MARKDOWN", markdown: "invalid metadata", checked: false, metadata: "damaged" },
    { type: "MARKDOWN", markdown: "unknown field", checked: false, metadata: null, futureField: true }
  ]) {
    assert.equal(store.saveBlock({
      userId: "user-1",
      pageId: "page-1",
      blockId: "block-1",
      payload,
      expectedVersion: 7,
      revision: 2
    }), false);
    assert.equal(storage.getItem(key), original);
    assert.equal(store.loadPage("user-1", "page-1")?.title?.value, "keep this title");
  }
});

test("direct recovery accepts complete block writes that remain readable", () => {
  const storage = new MemoryStorage();
  const store = createPageDraftStore(storage, { sourceId: "tab-a" });
  const payload = {
    type: "MARKDOWN",
    markdown: "durable unsaved note",
    checked: false,
    metadata: null
  };

  assert.equal(store.saveBlock({
    userId: "user-1",
    pageId: "page-1",
    blockId: "block-1",
    payload,
    expectedVersion: 7,
    revision: 2
  }), true);
  assert.deepEqual(
    store.loadPage("user-1", "page-1")?.blocks["block-1"]?.payload,
    payload
  );
});

test("direct recovery rejects JSON-lossy block metadata before modifying durable recovery state", () => {
  const storage = new MemoryStorage();
  const key = "brainvault.pageDraft.v2:user-1:page-1:tab-a";
  const store = createPageDraftStore(storage, { sourceId: "tab-a" });

  assert.equal(store.saveTitle({
    userId: "user-1",
    pageId: "page-1",
    value: "keep this title",
    expectedVersion: 4,
    revision: 1
  }), true);
  const original = storage.getItem(key);
  assert.equal(typeof original, "string");

  const cyclicMetadata = {};
  cyclicMetadata.self = cyclicMetadata;
  const sparseValues = [];
  sparseValues[1] = "survives";
  const hiddenValues = ["visible"];
  Object.defineProperty(hiddenValues, "hidden", {
    value: "must-not-be-dropped",
    enumerable: false
  });
  const throwingValues = [];
  Object.defineProperty(throwingValues, 0, {
    enumerable: true,
    get() {
      throw new Error("recovery validation must not invoke array getters");
    }
  });
  throwingValues.length = 1;
  const invalidMetadata = [
    { database: { rows: [{ id: "row-1", value: undefined }] } },
    { database: { score: Number.NaN } },
    { database: { score: Number.POSITIVE_INFINITY } },
    { database: { score: -0 } },
    { database: { value: 1n } },
    { database: { values: sparseValues } },
    { database: { values: hiddenValues } },
    { database: { values: throwingValues } },
    cyclicMetadata
  ];

  for (const metadata of invalidMetadata) {
    assert.equal(store.saveBlock({
      userId: "user-1",
      pageId: "page-1",
      blockId: "block-1",
      payload: { type: "DATABASE", markdown: "draft", checked: false, metadata },
      expectedVersion: 7,
      revision: 2
    }), false);
    assert.equal(storage.getItem(key), original);
    assert.equal(store.loadPage("user-1", "page-1")?.title?.value, "keep this title");
  }
});

test("direct recovery snapshots validated metadata before persistence so Proxy reads cannot change it", () => {
  const storage = new MemoryStorage();
  const store = createPageDraftStore(storage, { sourceId: "tab-a" });
  const target = { critical: "keep-me" };
  const metadata = new Proxy(target, {
    get(current, property, receiver) {
      if (property === "critical") return undefined;
      return Reflect.get(current, property, receiver);
    }
  });

  assert.equal(store.saveBlock({
    userId: "user-1",
    pageId: "page-1",
    blockId: "block-1",
    payload: { type: "DATABASE", markdown: "draft", checked: false, metadata },
    expectedVersion: 7,
    revision: 2
  }), true);
  assert.deepEqual(
    store.loadPage("user-1", "page-1")?.blocks["block-1"]?.payload.metadata,
    { critical: "keep-me" }
  );
});

test("direct recovery rejects hidden, symbolic, and accessor-backed payload fields without replacing good recovery", () => {
  const storage = new MemoryStorage();
  const key = "brainvault.pageDraft.v2:user-1:page-1:tab-a";
  const store = createPageDraftStore(storage, { sourceId: "tab-a" });

  assert.equal(store.saveTitle({
    userId: "user-1",
    pageId: "page-1",
    value: "keep this title",
    expectedVersion: 4,
    revision: 1
  }), true);
  const original = storage.getItem(key);

  const hidden = { type: "MARKDOWN", markdown: "draft", checked: false, metadata: null };
  Object.defineProperty(hidden, "futureField", {
    value: "must-not-be-dropped",
    enumerable: false
  });

  const symbolic = { type: "MARKDOWN", markdown: "draft", checked: false, metadata: null };
  symbolic[Symbol("futureField")] = "must-not-be-dropped";

  const accessor = { type: "MARKDOWN", checked: false, metadata: null };
  Object.defineProperty(accessor, "markdown", {
    enumerable: true,
    get() {
      return "must-not-be-invoked";
    }
  });

  for (const payload of [hidden, symbolic, accessor]) {
    assert.equal(store.saveBlock({
      userId: "user-1",
      pageId: "page-1",
      blockId: "block-1",
      payload,
      expectedVersion: 7,
      revision: 2
    }), false);
    assert.equal(storage.getItem(key), original);
    assert.equal(store.loadPage("user-1", "page-1")?.title?.value, "keep this title");
  }
});

test("direct recovery preserves nested JSON metadata exactly", () => {
  const storage = new MemoryStorage();
  const store = createPageDraftStore(storage, { sourceId: "tab-a" });
  const metadata = {
    database: {
      rows: [{ id: "row-1", value: null, cells: ["alpha", 2, false] }],
      nested: { enabled: true }
    }
  };
  const payload = { type: "DATABASE", markdown: "draft", checked: false, metadata };

  assert.equal(store.saveBlock({
    userId: "user-1",
    pageId: "page-1",
    blockId: "block-1",
    payload,
    expectedVersion: 7,
    revision: 2
  }), true);
  assert.deepEqual(store.loadPage("user-1", "page-1")?.blocks["block-1"].payload, payload);
});


test("direct recovery rejects unknown wrapper fields before a save or delete can project them away", () => {
  const key = "brainvault.pageDraft.v2:user-1:page-1:tab-a";
  const base = () => ({
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
        payload: {
          type: "MARKDOWN",
          markdown: "keep this unsaved note",
          checked: false,
          metadata: null
        }
      }
    }
  });

  const variants = [
    (record) => {
      record.futureRecord = { markdown: "future unsaved recovery data" };
    },
    (record) => {
      record.title = {
        value: "draft title",
        revision: 1,
        expectedVersion: 7,
        updatedAt: 1,
        futureTitleState: { value: "preserve me" }
      };
    },
    (record) => {
      record.blocks["block-1"].futureBlockState = { markdown: "preserve me" };
    },
    (record) => {
      record.blockOrder = {
        parentBlockId: null,
        orderedIds: ["block-1"],
        previousIds: ["block-1"],
        mutationId: "mutation-1",
        items: [{ id: "block-1", sortOrder: 0, parentBlockId: null, expectedVersion: 7 }],
        updatedAt: 1,
        futureOrderState: { value: "preserve me" }
      };
    },
    (record) => {
      record.blockOrder = {
        parentBlockId: null,
        orderedIds: ["block-1"],
        previousIds: ["block-1"],
        mutationId: "mutation-1",
        items: [{
          id: "block-1",
          sortOrder: 0,
          parentBlockId: null,
          expectedVersion: 7,
          futureItemState: { value: "preserve me" }
        }],
        updatedAt: 1
      };
    }
  ];

  for (const mutate of variants) {
    const storage = new MemoryStorage();
    const record = base();
    mutate(record);
    const raw = JSON.stringify(record);
    storage.setItem(key, raw);

    const store = createPageDraftStore(storage, { sourceId: "tab-a" });
    const inspection = store.inspectPageDrafts("user-1", "page-1");

    assert.deepEqual(inspection.records, []);
    assert.deepEqual(inspection.unreadableKeys, [key]);

    assert.equal(store.saveTitle({
      userId: "user-1",
      pageId: "page-1",
      value: "ordinary edit",
      expectedVersion: 7,
      revision: 2
    }), false);
    assert.equal(store.removeBlock("user-1", "page-1", "block-1", "tab-a"), false);
    assert.equal(storage.getItem(key), raw);
  }
});
