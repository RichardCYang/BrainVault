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

function saveOrder(store, mutationId, orderedIds) {
  store.saveBlockOrder({
    userId,
    pageId,
    sourceId,
    parentBlockId: null,
    orderedIds,
    previousIds: [...orderedIds].reverse(),
    mutationId,
    items: orderedIds.map((id, index) => ({
      id,
      sortOrder: index,
      parentBlockId: null,
      expectedVersion: 7
    }))
  });
}

function runBlockOrderScenario({ fixed, writeNewerOrder = false }) {
  const store = createPageDraftStore(new MemoryStorage(), { sourceId });
  const initialIds = ["keep-block", blockId];
  saveOrder(store, "order-before-move", initialIds);
  const cleanup = store.loadPage(userId, pageId, sourceId)?.blockOrder ?? null;

  if (writeNewerOrder) {
    saveOrder(store, "order-newer", [blockId, "keep-block"]);
  }

  // A successful cross-page move removes blockId from the source page. The
  // pre-move order is therefore obsolete and would surface as a recovery
  // conflict on the next load if it is left behind.
  if (
    fixed
    && cleanup?.orderedIds.includes(blockId)
  ) {
    store.acknowledgeBlockOrder({
      userId,
      pageId,
      sourceId,
      mutationId: cleanup.mutationId
    });
  }

  const order = store.loadPage(userId, pageId, sourceId)?.blockOrder ?? null;
  const serverIdsAfterMove = ["keep-block"];
  const wouldBecomeRecoveryConflict = Boolean(
    order
    && (
      serverIdsAfterMove.length !== order.orderedIds.length
      || !serverIdsAfterMove.every((id) => order.orderedIds.includes(id))
    )
  );
  return {
    staleOrderRetained: Boolean(order),
    mutationId: order?.mutationId ?? null,
    orderedIds: order?.orderedIds ?? null,
    wouldBecomeRecoveryConflict
  };
}

console.log(JSON.stringify({
  vulnerable: runScenario(false),
  fixed: runScenario(true),
  blockOrder: {
    vulnerable: runBlockOrderScenario({ fixed: false }),
    fixed: runBlockOrderScenario({ fixed: true }),
    fixedWithNewerOrder: runBlockOrderScenario({ fixed: true, writeNewerOrder: true })
  }
}, null, 2));
