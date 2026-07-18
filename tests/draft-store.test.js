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

describe("page draft store", () => {
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
  });
});
