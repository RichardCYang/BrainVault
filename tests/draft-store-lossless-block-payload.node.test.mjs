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

test("direct recovery safely persists prototype-named block ids", () => {
  const storage = new MemoryStorage();
  const store = createPageDraftStore(storage, { sourceId: "tab-a" });
  const payload = {
    type: "MARKDOWN",
    markdown: "durable prototype-named draft",
    checked: false,
    metadata: null
  };

  assert.equal(store.saveBlock({
    userId: "user-1",
    pageId: "page-1",
    blockId: "__proto__",
    payload,
    expectedVersion: 7,
    revision: 2
  }), true);

  const stored = store.loadPage("user-1", "page-1");
  assert.equal(Object.prototype.hasOwnProperty.call(stored?.blocks, "__proto__"), true);
  assert.deepEqual(stored?.blocks["__proto__"]?.payload, payload);

  const previousExpectedVersion = Object.getOwnPropertyDescriptor(Object.prototype, "expectedVersion");
  try {
    assert.equal(store.saveTitle({
      userId: "user-1",
      pageId: "page-2",
      value: "keep this title",
      expectedVersion: 4,
      revision: 1
    }), true);
    assert.equal(store.acknowledgeBlock({
      userId: "user-1",
      pageId: "page-2",
      blockId: "__proto__",
      revision: 1,
      nextExpectedVersion: 8
    }), true);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(Object.prototype, "expectedVersion"),
      previousExpectedVersion
    );
  } finally {
    if (previousExpectedVersion) {
      Object.defineProperty(Object.prototype, "expectedVersion", previousExpectedVersion);
    } else {
      delete Object.prototype.expectedVersion;
    }
  }
});

test("direct recovery block maps do not fall through to Object.prototype", () => {
  const storage = new MemoryStorage();
  const store = createPageDraftStore(storage, { sourceId: "tab-a" });

  assert.equal(store.saveTitle({
    userId: "user-1",
    pageId: "page-1",
    value: "title-only recovery",
    expectedVersion: 4,
    revision: 1
  }), true);

  const blocks = store.loadPage("user-1", "page-1")?.blocks;
  assert.equal(Object.getPrototypeOf(blocks), null);
  for (const blockId of ["__proto__", "constructor", "toString"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(blocks, blockId), false);
    assert.equal(blocks[blockId], undefined);
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
    { database: { score: Number.MAX_SAFE_INTEGER + 1 } },
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

test("direct recovery rejects unsafe integer metadata before unrelated mutations can rewrite it", () => {
  const storage = new MemoryStorage();
  const key = "brainvault.pageDraft.v2:user-1:page-1:tab-a";
  const raw = '{"schemaVersion":2,"userId":"user-1","pageId":"page-1","sourceId":"tab-a","updatedAt":1,"title":null,"blockOrder":null,"blocks":{"block-1":{"revision":1,"expectedVersion":7,"updatedAt":1,"payload":{"type":"MARKDOWN","markdown":"keep this unsaved note","checked":false,"metadata":{"unsafe":9007199254740993}}}}}';
  storage.setItem(key, raw);

  const store = createPageDraftStore(storage, { sourceId: "tab-a" });
  const inspection = store.inspectPageDrafts("user-1", "page-1");

  assert.deepEqual(inspection.records, []);
  assert.deepEqual(inspection.unreadableKeys, [key]);
  assert.equal(store.saveTitle({
    userId: "user-1",
    pageId: "page-1",
    value: "ordinary title edit",
    expectedVersion: 7,
    revision: 2
  }), false);
  assert.equal(storage.getItem(key), raw);
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


test("direct recovery rejects coercive numeric metadata before unrelated mutations can rewrite it", () => {
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
    (record) => { record.updatedAt = null; },
    (record) => { record.updatedAt = "1"; },
    (record) => { record.blocks["block-1"].revision = "1"; },
    (record) => { record.blocks["block-1"].expectedVersion = "7"; },
    (record) => { record.blocks["block-1"].updatedAt = null; },
    (record) => {
      record.title = { value: "title", revision: 1, expectedVersion: 7, updatedAt: "1" };
    },
    (record) => {
      record.blockOrder = {
        parentBlockId: null,
        orderedIds: ["block-1"],
        previousIds: ["block-1"],
        mutationId: "mutation-1",
        items: [{ id: "block-1", sortOrder: 0, parentBlockId: null, expectedVersion: "7" }],
        updatedAt: 1
      };
    },
    (record) => {
      record.blockOrder = {
        parentBlockId: null,
        orderedIds: ["block-1"],
        previousIds: ["block-1"],
        mutationId: "mutation-1",
        items: [{ id: "block-1", sortOrder: 0, parentBlockId: null, expectedVersion: 7 }],
        updatedAt: null
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
    assert.equal(storage.getItem(key), raw);
  }
});


test("direct recovery rejects duplicate JSON object names before a mutation can erase shadowed recovery bytes", () => {
  const key = "brainvault.pageDraft.v2:user-1:page-1:tab-a";
  const shadowedBlock = `{"revision":1,"expectedVersion":7,"updatedAt":1,"payload":{"type":"MARKDOWN","markdown":"SHADOWED UNSAVED NOTE","checked":false,"metadata":null}}`;
  const visibleBlock = `{"revision":1,"expectedVersion":7,"updatedAt":1,"payload":{"type":"MARKDOWN","markdown":"visible note","checked":false,"metadata":null}}`;

  for (const duplicateName of ['"blocks"', '"blo\\u0063ks"']) {
    const storage = new MemoryStorage();
    const raw = `{"schemaVersion":2,"userId":"user-1","pageId":"page-1","sourceId":"tab-a","updatedAt":1,"title":null,"blockOrder":null,"blocks":{"shadowed":${shadowedBlock}},${duplicateName}:{"visible":${visibleBlock}}}`;
    storage.setItem(key, raw);

    const store = createPageDraftStore(storage, { sourceId: "tab-a" });
    const inspection = store.inspectPageDrafts("user-1", "page-1");

    assert.deepEqual(inspection.records, []);
    assert.deepEqual(inspection.unreadableKeys, [key]);
    assert.equal(store.saveTitle({
      userId: "user-1",
      pageId: "page-1",
      value: "ordinary edit",
      expectedVersion: 1,
      revision: 1
    }), false);
    assert.equal(store.removeBlock("user-1", "page-1", "visible", "tab-a"), false);
    assert.equal(storage.getItem(key), raw);
    assert.match(storage.getItem(key), /SHADOWED UNSAVED NOTE/);
  }
});

test("foreign-source CAS and durable cleanup refuse a duplicate-key record that parses like the old snapshot", async () => {
  class DeferredAtomicMemoryStorage extends MemoryStorage {
    compareAndSet(key, predicate, nextValue) {
      return Promise.resolve().then(() => {
        const current = this.getItem(key);
        if (!predicate(current)) return false;
        this.setItem(key, nextValue);
        return true;
      });
    }

    compareAndRemove(key, predicate) {
      return Promise.resolve().then(() => {
        const current = this.getItem(key);
        if (!predicate(current)) return false;
        this.removeItem(key);
        return true;
      });
    }
  }

  const key = "brainvault.pageDraft.v2:user-1:page-1:tab-a";
  const visibleRecord = {
    schemaVersion: 2,
    userId: "user-1",
    pageId: "page-1",
    sourceId: "tab-a",
    updatedAt: 1,
    title: { value: "draft title", revision: 1, expectedVersion: 1, updatedAt: 1 },
    blockOrder: null,
    blocks: {
      visible: {
        revision: 1,
        expectedVersion: 7,
        updatedAt: 1,
        payload: { type: "MARKDOWN", markdown: "visible note", checked: false, metadata: null }
      }
    }
  };
  const visibleBlocks = JSON.stringify(visibleRecord.blocks);
  const shadowedBlocks = JSON.stringify({
    shadowed: {
      revision: 1,
      expectedVersion: 7,
      updatedAt: 1,
      payload: { type: "MARKDOWN", markdown: "SHADOWED UNSAVED NOTE", checked: false, metadata: null }
    }
  });
  const duplicateRaw = `{"schemaVersion":2,"userId":"user-1","pageId":"page-1","sourceId":"tab-a","updatedAt":1,"title":{"value":"draft title","revision":1,"expectedVersion":1,"updatedAt":1},"blockOrder":null,"blocks":${shadowedBlocks},"blocks":${visibleBlocks}}`;

  const storage = new DeferredAtomicMemoryStorage();
  storage.setItem(key, JSON.stringify(visibleRecord));
  const store = createPageDraftStore(storage, { sourceId: "tab-b" });

  assert.equal(store.acknowledgeTitle({
    userId: "user-1",
    pageId: "page-1",
    sourceId: "tab-a",
    revision: 1,
    nextExpectedVersion: 2
  }), true);
  storage.setItem(key, duplicateRaw);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(storage.getItem(key), duplicateRaw);

  storage.setItem(key, JSON.stringify(visibleRecord));
  const uploaded = store.loadPage("user-1", "page-1", "tab-a");
  assert.ok(uploaded);
  storage.setItem(key, duplicateRaw);
  assert.equal(await store.removePageIfUnchangedDurably(uploaded), false);
  assert.equal(storage.getItem(key), duplicateRaw);
});

test("removeBlockIfUnchanged rejects toJSON spoofing instead of deleting a different durable draft", () => {
  const storage = new MemoryStorage();
  const store = createPageDraftStore(storage, { sourceId: "tab-a" });
  const originalPayload = {
    type: "MARKDOWN",
    markdown: "keep this unsaved note",
    checked: false,
    metadata: null
  };

  assert.equal(store.saveBlock({
    userId: "user-1",
    pageId: "page-1",
    blockId: "block-1",
    payload: originalPayload,
    expectedVersion: 7,
    revision: 2
  }), true);

  const spoofedPayload = {
    type: "MARKDOWN",
    markdown: "different content",
    checked: false,
    metadata: null,
    toJSON() {
      return originalPayload;
    }
  };

  assert.equal(store.removeBlockIfUnchanged({
    userId: "user-1",
    pageId: "page-1",
    blockId: "block-1",
    sourceId: "tab-a",
    payload: spoofedPayload,
    expectedVersion: 7,
    revision: 2
  }), false);
  assert.deepEqual(
    store.loadPage("user-1", "page-1")?.blocks["block-1"]?.payload,
    originalPayload
  );
});
