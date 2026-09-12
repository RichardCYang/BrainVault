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
const pageId = "source-page";
const blockId = "block-1";
const sourceId = "tab-a";

const oldPayload = {
  type: "MARKDOWN",
  markdown: "draft present when move started",
  checked: false,
  metadata: null
};
const newerPayload = {
  ...oldPayload,
  markdown: "newer recovery edit written while move was in flight"
};

function seedMoveIntent(store) {
  store.saveBlock({
    userId,
    pageId,
    blockId,
    sourceId,
    payload: oldPayload,
    expectedVersion: 7,
    revision: 1
  });
}

function captureMoveCleanup(store) {
  const draft = store.loadPage(userId, pageId, sourceId)?.blocks?.[blockId] ?? null;
  return draft
    ? {
        userId,
        pageId,
        blockId,
        sourceId,
        payload: draft.payload,
        expectedVersion: draft.expectedVersion,
        revision: draft.revision
      }
    : null;
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
}

function runScenario(fixed) {
  const store = createPageDraftStore(new MemoryStorage(), { sourceId });
  seedMoveIntent(store);
  const cleanup = captureMoveCleanup(store);

  // The server-side move is in flight. A later same-tab recovery write now
  // replaces the record that existed when the request was dispatched.
  writeNewerRecovery(store);

  if (fixed) {
    if (cleanup) store.removeBlockIfUnchanged(cleanup);
  } else {
    store.removeBlocks(userId, pageId, [blockId], sourceId);
  }

  const draft = store.loadPage(userId, pageId, sourceId)?.blocks?.[blockId] ?? null;
  return {
    newerDraftPreserved: draft?.revision === 2,
    markdown: draft?.payload?.markdown ?? null
  };
}

console.log(JSON.stringify({
  vulnerable: runScenario(false),
  fixed: runScenario(true)
}, null, 2));
