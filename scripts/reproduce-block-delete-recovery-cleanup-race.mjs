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

const userId = "user-1";
const pageId = "page-1";
const blockId = "block-1";
const sourceId = "tab-a";

const oldPayload = {
  type: "MARKDOWN",
  markdown: "draft present when delete started",
  checked: false,
  metadata: null
};
const newerPayload = {
  ...oldPayload,
  markdown: "newer recovery edit"
};

function captureDeleteCleanup(store) {
  const record = store.loadPage(userId, pageId, sourceId);
  const draft = record?.blocks?.[blockId] ?? null;
  return {
    blockOrigin: draft
      ? {
          userId,
          pageId,
          blockId,
          sourceId,
          payload: draft.payload,
          expectedVersion: draft.expectedVersion,
          revision: draft.revision
        }
      : null,
    blockOrderMutationId:
      record?.blockOrder?.orderedIds?.includes(blockId)
        ? record.blockOrder.mutationId
        : null
  };
}

function seedDeleteIntent(store) {
  store.saveBlock({
    userId,
    pageId,
    blockId,
    sourceId,
    payload: oldPayload,
    expectedVersion: 7,
    revision: 1
  });
  store.saveBlockOrder({
    userId,
    pageId,
    sourceId,
    parentBlockId: null,
    orderedIds: [blockId, "block-2"],
    previousIds: ["block-2", blockId],
    mutationId: "order-old",
    items: [
      { id: blockId, sortOrder: 0, parentBlockId: null, expectedVersion: 7 },
      { id: "block-2", sortOrder: 1, parentBlockId: null, expectedVersion: 3 }
    ]
  });
}

function writeNewerRecovery(store) {
  store.saveBlock({
    userId,
    pageId,
    blockId,
    sourceId,
    payload: newerPayload,
    expectedVersion: 7,
    revision: 2
  });
  store.saveBlockOrder({
    userId,
    pageId,
    sourceId,
    parentBlockId: null,
    orderedIds: ["block-2", blockId],
    previousIds: [blockId, "block-2"],
    mutationId: "order-new",
    items: [
      { id: "block-2", sortOrder: 0, parentBlockId: null, expectedVersion: 3 },
      { id: blockId, sortOrder: 1, parentBlockId: null, expectedVersion: 7 }
    ]
  });
}

function runScenario(fixed) {
  const storage = new MemoryStorage();
  const store = createPageDraftStore(storage, { sourceId });
  seedDeleteIntent(store);

  // The delete request is now in flight. Capture exactly what it is allowed to
  // acknowledge, then force a newer same-source recovery write before response
  // application.
  const cleanup = captureDeleteCleanup(store);
  writeNewerRecovery(store);

  if (fixed) {
    if (cleanup.blockOrigin) store.removeBlockIfUnchanged(cleanup.blockOrigin);
    if (cleanup.blockOrderMutationId) {
      store.acknowledgeBlockOrder({
        userId,
        pageId,
        sourceId,
        mutationId: cleanup.blockOrderMutationId
      });
    }
  } else {
    // Old application behavior: deletes whatever currently occupies the source
    // key, even if it was written after the destructive request was dispatched.
    store.removeBlocks(userId, pageId, [blockId], sourceId);
  }

  const record = store.loadPage(userId, pageId, sourceId);
  return {
    newerBlockDraftPreserved: record?.blocks?.[blockId]?.revision === 2,
    newerBlockOrderPreserved: record?.blockOrder?.mutationId === "order-new",
    blockMarkdown: record?.blocks?.[blockId]?.payload?.markdown ?? null,
    blockOrderMutationId: record?.blockOrder?.mutationId ?? null
  };
}

console.log(JSON.stringify({
  vulnerable: runScenario(false),
  fixed: runScenario(true)
}, null, 2));
