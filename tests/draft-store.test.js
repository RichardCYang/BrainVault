import { describe, expect, it } from "vitest";
import { createPageDraftStore } from "../public/draft-store.js";
import { createLatestWriteQueue } from "../public/save-queue.js";

class MemoryStorage {
  values = new Map();
  failWrites = false;

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    if (this.failWrites) throw new Error("quota exceeded");
    this.values.set(key, value);
  }

  removeItem(key) {
    if (this.failWrites) throw new Error("storage unavailable");
    this.values.delete(key);
  }
}

const titleDraft = { userId: "user-1", pageId: "page-1", value: "Recovered", expectedVersion: 4, revision: 2 };
const blockDraft = {
  userId: "user-1",
  pageId: "page-1",
  blockId: "block-1",
  payload: { type: "MARKDOWN", markdown: "unsaved", checked: false },
  expectedVersion: 7,
  revision: 3
};
const blockOrderDraft = {
  userId: "user-1",
  pageId: "page-1",
  parentBlockId: null,
  orderedIds: ["block-2", "block-1"],
  previousIds: ["block-1", "block-2"],
  mutationId: "mut-order-1",
  items: [
    { id: "block-2", sortOrder: 0, parentBlockId: null, expectedVersion: 5 },
    { id: "block-1", sortOrder: 1, parentBlockId: null, expectedVersion: 7 }
  ]
};

describe("page draft store", () => {
  it("keeps the recovered origin immutable while the current tab edits its clone", () => {
    const storage = new MemoryStorage();
    const origin = createPageDraftStore(storage, { sourceId: "tab-origin" });
    const current = createPageDraftStore(storage, { sourceId: "tab-current" });

    origin.saveTitle({ ...titleDraft, value: "origin title" });
    origin.saveBlock({ ...blockDraft, payload: { ...blockDraft.payload, markdown: "origin block" } });
    origin.saveBlockOrder(blockOrderDraft);

    current.saveTitle({ ...titleDraft, value: "edited title", revision: 3 });
    current.saveBlock({
      ...blockDraft,
      revision: 4,
      payload: { ...blockDraft.payload, markdown: "edited block" }
    });
    current.saveBlockOrder(blockOrderDraft);

    expect(origin.loadPage("user-1", "page-1", "tab-origin")?.title?.value).toBe("origin title");
    expect(origin.loadPage("user-1", "page-1", "tab-origin")?.blocks["block-1"]?.payload.markdown).toBe(
      "origin block"
    );
    expect(origin.loadPage("user-1", "page-1", "tab-origin")?.blockOrder?.mutationId).toBe("mut-order-1");

    expect(current.loadPage("user-1", "page-1", "tab-current")?.title?.value).toBe("edited title");
    expect(current.loadPage("user-1", "page-1", "tab-current")?.blocks["block-1"]?.payload.markdown).toBe(
      "edited block"
    );
  });

  it("cleans a recovered order origin only when its exact mutation is unchanged", () => {
    const storage = new MemoryStorage();
    const origin = createPageDraftStore(storage, { sourceId: "tab-origin" });
    const current = createPageDraftStore(storage, { sourceId: "tab-current" });
    origin.saveBlockOrder(blockOrderDraft);
    current.saveBlockOrder(blockOrderDraft);

    expect(
      current.acknowledgeBlockOrder({
        userId: "user-1",
        pageId: "page-1",
        sourceId: "tab-current",
        mutationId: "mut-order-1"
      })
    ).toBe(true);
    expect(
      origin.acknowledgeBlockOrder({
        userId: "user-1",
        pageId: "page-1",
        sourceId: "tab-origin",
        mutationId: "mut-order-1"
      })
    ).toBe(true);
    expect(origin.loadPage("user-1", "page-1", "tab-origin")).toBeNull();

    origin.saveBlockOrder({ ...blockOrderDraft, mutationId: "newer-origin-order" });
    expect(
      origin.acknowledgeBlockOrder({
        userId: "user-1",
        pageId: "page-1",
        sourceId: "tab-origin",
        mutationId: "mut-order-1"
      })
    ).toBe(true);
    expect(origin.loadPage("user-1", "page-1", "tab-origin")?.blockOrder?.mutationId).toBe(
      "newer-origin-order"
    );
  });

  it("cleans up only the exact recovered conflict and preserves concurrent tab changes", () => {
    const storage = new MemoryStorage();
    const recovered = createPageDraftStore(storage, { sourceId: "tab-recovered" });
    recovered.saveTitle({ ...titleDraft, value: "stale title" });
    recovered.saveBlock({ ...blockDraft, payload: { ...blockDraft.payload, markdown: "stale block" } });

    expect(
      recovered.removeTitleIfUnchanged({
        ...titleDraft,
        sourceId: "tab-recovered",
        value: "stale title"
      })
    ).toBe(true);
    expect(recovered.loadPage("user-1", "page-1")?.title).toBeNull();

    recovered.saveTitle({ ...titleDraft, value: "changed in original tab", revision: 3 });
    expect(
      recovered.removeTitleIfUnchanged({
        ...titleDraft,
        sourceId: "tab-recovered",
        value: "stale title"
      })
    ).toBe(true);
    expect(recovered.loadPage("user-1", "page-1")?.title?.value).toBe("changed in original tab");

    expect(
      recovered.removeBlockIfUnchanged({
        ...blockDraft,
        sourceId: "tab-recovered",
        payload: { ...blockDraft.payload, markdown: "stale block" }
      })
    ).toBe(true);
    expect(recovered.loadPage("user-1", "page-1")?.blocks["block-1"]).toBeUndefined();

    recovered.saveBlock({
      ...blockDraft,
      revision: 4,
      payload: { ...blockDraft.payload, markdown: "changed in original tab" }
    });
    expect(
      recovered.removeBlockIfUnchanged({
        ...blockDraft,
        sourceId: "tab-recovered",
        payload: { ...blockDraft.payload, markdown: "stale block" }
      })
    ).toBe(true);
    expect(recovered.loadPage("user-1", "page-1")?.blocks["block-1"]?.payload.markdown).toBe(
      "changed in original tab"
    );
  });

  it("persists title and block drafts across store instances", () => {
    const storage = new MemoryStorage();
    const first = createPageDraftStore(storage, { sourceId: "tab-a" });
    expect(first.saveTitle(titleDraft)).toBe(true);
    expect(first.saveBlock(blockDraft)).toBe(true);

    const restored = createPageDraftStore(storage, { sourceId: "tab-a" }).loadPage("user-1", "page-1");
    expect(restored?.sourceId).toBe("tab-a");
    expect(restored?.title).toMatchObject({ value: "Recovered", expectedVersion: 4, revision: 2 });
    expect(restored?.blocks["block-1"]).toMatchObject({
      payload: blockDraft.payload,
      expectedVersion: 7,
      revision: 3
    });
  });

  it("persists block-order retries and acknowledges only the exact mutation", () => {
    const storage = new MemoryStorage();
    const first = createPageDraftStore(storage, { sourceId: "tab-a" });
    expect(first.saveBlockOrder(blockOrderDraft)).toBe(true);

    const restored = createPageDraftStore(storage, { sourceId: "tab-a" }).loadPage("user-1", "page-1");
    expect(restored?.blockOrder).toMatchObject({
      mutationId: "mut-order-1",
      orderedIds: ["block-2", "block-1"],
      previousIds: ["block-1", "block-2"]
    });

    expect(
      first.acknowledgeBlockOrder({
        userId: "user-1",
        pageId: "page-1",
        mutationId: "another-mutation"
      })
    ).toBe(true);
    expect(first.loadPage("user-1", "page-1")?.blockOrder?.mutationId).toBe("mut-order-1");

    expect(
      first.acknowledgeBlockOrder({
        userId: "user-1",
        pageId: "page-1",
        mutationId: "mut-order-1"
      })
    ).toBe(true);
    expect(first.loadPage("user-1", "page-1")).toBeNull();
  });

  it("does not skip a remaining draft when another tab removes a storage key during enumeration", () => {
    class ShiftingStorage extends MemoryStorage {
      shiftOnNextKey = false;

      key(index) {
        const key = super.key(index);
        if (this.shiftOnNextKey && index === 0 && key) {
          this.shiftOnNextKey = false;
          this.values.delete(key);
        }
        return key;
      }
    }

    const storage = new ShiftingStorage();
    createPageDraftStore(storage, { sourceId: "tab-a" }).saveBlock(blockDraft);
    createPageDraftStore(storage, { sourceId: "tab-b" }).saveBlock({
      ...blockDraft,
      blockId: "block-2",
      payload: { ...blockDraft.payload, markdown: "must remain visible" }
    });

    storage.shiftOnNextKey = true;
    const records = createPageDraftStore(storage, { sourceId: "reader" }).loadUserDrafts("user-1");
    expect(records).toHaveLength(1);
    expect(records[0].sourceId).toBe("tab-b");
    expect(records[0].blocks["block-2"]?.payload.markdown).toBe("must remain visible");
  });

  it("keeps scanning until repeated key shifts expose the final surviving draft", () => {
    class RepeatedShiftingStorage extends MemoryStorage {
      shiftsRemaining = 0;

      key(index) {
        const keys = [...this.values.keys()];
        const key = keys[index] ?? null;
        if (this.shiftsRemaining > 0 && keys.length > 1 && index === keys.length - 2) {
          this.values.delete(keys[0]);
          this.shiftsRemaining -= 1;
        }
        return key;
      }
    }

    const storage = new RepeatedShiftingStorage();
    for (const sourceId of ["tab-a", "tab-b", "tab-c", "tab-survivor"]) {
      createPageDraftStore(storage, { sourceId }).saveBlock({
        ...blockDraft,
        blockId: sourceId,
        payload: { ...blockDraft.payload, markdown: sourceId }
      });
    }

    storage.shiftsRemaining = 3;
    const inspection = createPageDraftStore(storage, { sourceId: "reader" })
      .inspectUserDrafts("user-1");
    expect(inspection.reliable).toBe(true);
    expect(inspection.unreadableKeys).toEqual([]);
    expect(inspection.records.map((record) => record.sourceId)).toEqual(["tab-survivor"]);
  });

  it("marks enumeration and corrupt target records as unsafe for destructive guards", () => {
    const brokenStorage = {
      get length() { throw new Error("disabled"); },
      key() { throw new Error("disabled"); },
      getItem() { throw new Error("disabled"); },
      setItem() { throw new Error("disabled"); },
      removeItem() { throw new Error("disabled"); }
    };
    expect(
      createPageDraftStore(brokenStorage, { sourceId: "reader" }).inspectUserDrafts("user-1").reliable
    ).toBe(false);

    const storage = new MemoryStorage();
    storage.setItem("brainvault.pageDraft.v2:user-1:page-1:tab-corrupt", "{not-json");
    const inspection = createPageDraftStore(storage, { sourceId: "reader" })
      .inspectPageDrafts("user-1", "page-1");
    expect(inspection.reliable).toBe(true);
    expect(inspection.records).toEqual([]);
    expect(inspection.unreadableKeys).toHaveLength(1);
  });

  it("preserves partially malformed draft bytes instead of silently dropping one component", () => {
    const storage = new MemoryStorage();
    const key = "brainvault.pageDraft.v2:user-1:page-1:tab-corrupt";
    const original = JSON.stringify({
      schemaVersion: 2,
      userId: "user-1",
      pageId: "page-1",
      sourceId: "tab-corrupt",
      updatedAt: 10,
      title: { value: "still recoverable", expectedVersion: 4, revision: 2, updatedAt: 10 },
      blocks: {
        "block-corrupt": { payload: "not-an-object", expectedVersion: 7, revision: 3, updatedAt: 10 }
      },
      blockOrder: null
    });
    storage.setItem(key, original);
    const store = createPageDraftStore(storage, { sourceId: "tab-corrupt" });

    const inspection = store.inspectPageDrafts("user-1", "page-1");
    expect(inspection.records).toEqual([]);
    expect(inspection.unreadableKeys).toEqual([key]);
    expect(store.saveTitle({ ...titleDraft, sourceId: "tab-corrupt", value: "new title" })).toBe(false);
    expect(store.saveBlock({ ...blockDraft, sourceId: "tab-corrupt" })).toBe(false);
    expect(store.saveBlockOrder({ ...blockOrderDraft, sourceId: "tab-corrupt" })).toBe(false);
    expect(store.acknowledgeTitle({
      userId: "user-1",
      pageId: "page-1",
      sourceId: "tab-corrupt",
      revision: 2,
      nextExpectedVersion: 5
    })).toBe(false);
    expect(store.removePage("user-1", "page-1", "tab-corrupt")).toBe(false);
    expect(store.clearPage("user-1", "page-1")).toBe(false);
    expect(storage.getItem(key)).toBe(original);
  });

  it("treats an empty-string draft value as present, unreadable, and non-overwritable", () => {
    const storage = new MemoryStorage();
    const key = "brainvault.pageDraft.v2:user-1:page-1:tab-empty";
    storage.setItem(key, "");
    const store = createPageDraftStore(storage, { sourceId: "tab-empty" });

    expect(store.inspectPageDrafts("user-1", "page-1").unreadableKeys).toEqual([key]);
    expect(store.saveTitle({ ...titleDraft, sourceId: "tab-empty" })).toBe(false);
    expect(store.removePage("user-1", "page-1", "tab-empty")).toBe(false);
    expect(store.clearUser("user-1")).toBe(false);
    expect(storage.getItem(key)).toBe("");
  });

  it("keeps another tab's order retry and clears an order that references a deleted block", () => {
    const storage = new MemoryStorage();
    const tabA = createPageDraftStore(storage, { sourceId: "tab-a" });
    const tabB = createPageDraftStore(storage, { sourceId: "tab-b" });
    tabA.saveBlockOrder(blockOrderDraft);
    tabB.saveBlockOrder({ ...blockOrderDraft, mutationId: "mut-order-2" });

    expect(tabA.removeBlocks("user-1", "page-1", ["block-1"], "tab-a")).toBe(true);
    expect(tabA.loadPage("user-1", "page-1", "tab-a")).toBeNull();
    expect(tabB.loadPage("user-1", "page-1")?.blockOrder?.mutationId).toBe("mut-order-2");
  });

  it("isolates drafts from concurrent tabs and acknowledges only the matching source", () => {
    const storage = new MemoryStorage();
    const tabA = createPageDraftStore(storage, { sourceId: "tab-a" });
    const tabB = createPageDraftStore(storage, { sourceId: "tab-b" });
    tabA.saveBlock(blockDraft);
    tabB.saveBlock({ ...blockDraft, payload: { ...blockDraft.payload, markdown: "from tab B" } });

    expect(tabA.loadPageDrafts("user-1", "page-1")).toHaveLength(2);
    expect(
      tabA.acknowledgeBlock({ ...blockDraft, sourceId: "tab-a", revision: 3, nextExpectedVersion: 8 })
    ).toBe(true);
    expect(tabA.loadPage("user-1", "page-1", "tab-a")).toBeNull();
    expect(tabB.loadPage("user-1", "page-1")?.blocks["block-1"]?.payload.markdown).toBe("from tab B");
  });

  it("rebases a queued newer edit after the preceding write is acknowledged", async () => {
    const storage = new MemoryStorage();
    const store = createPageDraftStore(storage, { sourceId: "tab-a" });
    const observedVersions = [];
    let releaseFirstWrite;
    const firstWriteGate = new Promise((resolve) => {
      releaseFirstWrite = resolve;
    });

    const queue = createLatestWriteQueue(async (task) => {
      const stored = store.loadPage("user-1", "page-1")?.blocks["block-1"];
      observedVersions.push(stored?.expectedVersion ?? task.expectedVersion);
      if (task.revision === 1) await firstWriteGate;
      const nextExpectedVersion = task.revision + 7;
      store.acknowledgeBlock({
        userId: "user-1",
        pageId: "page-1",
        blockId: "block-1",
        revision: task.revision,
        nextExpectedVersion
      });
      return nextExpectedVersion;
    });

    store.saveBlock({ ...blockDraft, revision: 1 });
    const first = queue.enqueue({ revision: 1, expectedVersion: 7 });
    await Promise.resolve();
    store.saveBlock({ ...blockDraft, revision: 2, payload: { ...blockDraft.payload, markdown: "newer" } });
    const second = queue.enqueue({ revision: 2, expectedVersion: 7 });
    releaseFirstWrite();

    await expect(first).resolves.toBe(9);
    await expect(second).resolves.toBe(9);
    expect(observedVersions).toEqual([7, 8]);
    expect(store.loadPage("user-1", "page-1")).toBeNull();
  });

  it("preserves the post-rerender edit when an older in-flight write is acknowledged", () => {
    const storage = new MemoryStorage();
    const store = createPageDraftStore(storage, { sourceId: "tab-a" });

    store.saveBlock({ ...blockDraft, revision: 3 });
    const restoredAfterRerender = store.loadPage("user-1", "page-1")?.blocks["block-1"];
    expect(restoredAfterRerender).toMatchObject({ expectedVersion: 7, revision: 3 });

    store.saveBlock({
      ...blockDraft,
      expectedVersion: restoredAfterRerender.expectedVersion,
      revision: restoredAfterRerender.revision + 1,
      payload: { ...blockDraft.payload, markdown: "typed after rerender" }
    });

    expect(
      store.acknowledgeBlock({ ...blockDraft, revision: 3, nextExpectedVersion: 8 })
    ).toBe(true);
    expect(store.loadPage("user-1", "page-1")?.blocks["block-1"]).toMatchObject({
      expectedVersion: 8,
      revision: 4,
      payload: { markdown: "typed after rerender" }
    });
  });

  it("clears an acknowledged draft only after its revision reaches the stored revision", () => {
    const storage = new MemoryStorage();
    const store = createPageDraftStore(storage, { sourceId: "tab-a" });
    store.saveBlock(blockDraft);

    expect(store.acknowledgeBlock({ ...blockDraft, revision: 2, nextExpectedVersion: 8 })).toBe(true);
    expect(store.loadPage("user-1", "page-1")?.blocks["block-1"]?.expectedVersion).toBe(8);

    expect(store.acknowledgeBlock({ ...blockDraft, revision: 3, nextExpectedVersion: 9 })).toBe(true);
    expect(store.loadPage("user-1", "page-1")).toBeNull();
  });

  it("rebases a newer title draft after an older write succeeds", () => {
    const storage = new MemoryStorage();
    const store = createPageDraftStore(storage, { sourceId: "tab-a" });
    store.saveTitle({ ...titleDraft, revision: 4 });

    expect(store.acknowledgeTitle({ ...titleDraft, revision: 2, nextExpectedVersion: 5 })).toBe(true);
    expect(store.loadPage("user-1", "page-1")?.title).toMatchObject({
      value: "Recovered",
      expectedVersion: 5,
      revision: 4
    });
  });

  it("removes deleted blocks and pages from every tab source", () => {
    const storage = new MemoryStorage();
    const tabA = createPageDraftStore(storage, { sourceId: "tab-a" });
    const tabB = createPageDraftStore(storage, { sourceId: "tab-b" });
    tabA.saveBlock(blockDraft);
    tabB.saveBlock(blockDraft);
    tabA.saveTitle(titleDraft);

    expect(tabA.clearBlocks("user-1", "page-1", ["block-1"])).toBe(true);
    expect(tabA.loadPageDrafts("user-1", "page-1")).toHaveLength(1);
    expect(tabA.loadPage("user-1", "page-1")?.blocks["block-1"]).toBeUndefined();

    expect(tabA.clearPage("user-1", "page-1")).toBe(true);
    expect(tabA.loadPageDrafts("user-1", "page-1")).toHaveLength(0);
  });

  it("keeps other tabs' drafts when a destructive action acknowledges only its own source", () => {
    const storage = new MemoryStorage();
    const tabA = createPageDraftStore(storage, { sourceId: "tab-a" });
    const tabB = createPageDraftStore(storage, { sourceId: "tab-b" });
    tabA.saveBlock(blockDraft);
    tabB.saveBlock({ ...blockDraft, payload: { ...blockDraft.payload, markdown: "tab B unsaved" } });
    tabA.saveTitle(titleDraft);
    tabB.saveTitle({ ...titleDraft, value: "tab B title" });

    expect(tabA.removeBlocks("user-1", "page-1", ["block-1"], "tab-a")).toBe(true);
    expect(tabA.loadPage("user-1", "page-1", "tab-a")?.blocks["block-1"]).toBeUndefined();
    expect(tabB.loadPage("user-1", "page-1")?.blocks["block-1"]?.payload.markdown).toBe("tab B unsaved");

    expect(tabA.removePages("user-1", ["page-1"], "tab-a")).toBe(true);
    expect(tabA.loadPage("user-1", "page-1", "tab-a")).toBeNull();
    expect(tabB.loadPage("user-1", "page-1")?.title?.value).toBe("tab B title");
  });

  it("lists durable drafts across pages and tab sources for orphan recovery", () => {
    const storage = new MemoryStorage();
    const tabA = createPageDraftStore(storage, { sourceId: "tab-a" });
    const tabB = createPageDraftStore(storage, { sourceId: "tab-b" });
    tabA.saveTitle(titleDraft);
    tabA.saveTitle({ ...titleDraft, pageId: "page-2", value: "Second page" });
    tabB.saveBlock({ ...blockDraft, pageId: "page-2", blockId: "block-2" });
    storage.setItem("brainvault.pageDraft.v2:user-1:corrupt:tab-x", "{");

    const drafts = tabA.loadUserDrafts("user-1");
    expect(drafts).toHaveLength(3);
    expect(drafts.map(({ pageId, sourceId }) => `${pageId}:${sourceId}`).sort()).toEqual([
      "page-1:tab-a",
      "page-2:tab-a",
      "page-2:tab-b"
    ]);
    expect(tabA.loadUserDrafts("user-2")).toEqual([]);
  });

  it("isolates cleanup by user and page", () => {
    const storage = new MemoryStorage();
    const store = createPageDraftStore(storage, { sourceId: "tab-a" });
    store.saveTitle(titleDraft);
    store.saveTitle({ ...titleDraft, pageId: "page-2" });
    store.saveTitle({ ...titleDraft, userId: "user-2" });

    expect(store.clearPage("user-1", "page-1")).toBe(true);
    expect(store.loadPage("user-1", "page-1")).toBeNull();
    expect(store.loadPage("user-1", "page-2")).not.toBeNull();

    expect(store.clearUser("user-1")).toBe(true);
    expect(store.loadPage("user-1", "page-2")).toBeNull();
    expect(store.loadPage("user-2", "page-1")).not.toBeNull();
  });

  it("fails closed without throwing when browser storage is unavailable", () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const store = createPageDraftStore(storage, { sourceId: "tab-a" });
    expect(store.saveTitle(titleDraft)).toBe(false);
    expect(store.saveBlock(blockDraft)).toBe(false);
    expect(store.saveBlockOrder(blockOrderDraft)).toBe(false);
  });
});
