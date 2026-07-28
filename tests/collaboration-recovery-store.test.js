import { describe, expect, it } from "vitest";
import { createCollaborationRecoveryStore } from "../public/collaboration-recovery-store.js";

function createMemoryStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

describe("collaboration recovery store", () => {
  it("keeps independent recovery states for concurrent tabs", () => {
    const store = createCollaborationRecoveryStore(createMemoryStorage());
    const first = new Uint8Array([0, 1, 2, 127, 128, 255]);
    const second = new Uint8Array([9, 8, 7]);
    expect(store.save("user-1", "page-1", "tab-1", first)).toBeTypeOf("string");
    expect(store.save("user-1", "page-1", "tab-2", second)).toBeTypeOf("string");
    const records = store.loadAll("user-1", "page-1");
    expect(records.map((record) => record.sourceId).sort()).toEqual(["tab-1", "tab-2"]);
    expect(records.map((record) => [...record.update])).toEqual(expect.arrayContaining([[...first], [...second]]));
    expect(store.loadAll("user-2", "page-1")).toEqual([]);
  });

  it("enumerates one account's recoveries across pages with an encoded fallback", () => {
    const store = createCollaborationRecoveryStore(createMemoryStorage());
    store.save("user-1", "page-2", "tab-2", new Uint8Array([9, 8]));
    store.save("user-1", "page-1", "tab-1", new Uint8Array([1, 2, 3]));
    store.save("user-2", "page-3", "other-account", new Uint8Array([7]));

    const records = store.loadAccountRecords("user-1");
    expect(records.map(({ pageId, sourceId }) => ({ pageId, sourceId }))).toEqual(
      expect.arrayContaining([
        { pageId: "page-1", sourceId: "tab-1" },
        { pageId: "page-2", sourceId: "tab-2" }
      ])
    );
    expect(records).toHaveLength(2);
    expect(records.every((record) => typeof record.encodedUpdate === "string" && record.encodedUpdate)).toBe(true);
    expect(store.loadAccountRecords("user-2")).toHaveLength(1);
  });

  it("finds unconfirmed page recovery across accounts in the same browser", () => {
    const store = createCollaborationRecoveryStore(createMemoryStorage());
    store.save("owner", "page-1", "owner-tab", new Uint8Array([1, 2]));
    store.save("collaborator", "page-1", "collaborator-tab", new Uint8Array([3, 4]));
    store.save("collaborator", "page-2", "other-page-tab", new Uint8Array([5]));

    expect(store.loadPageRecords("page-1").map(({ accountId, sourceId }) => ({ accountId, sourceId }))).toEqual(
      expect.arrayContaining([
        { accountId: "owner", sourceId: "owner-tab" },
        { accountId: "collaborator", sourceId: "collaborator-tab" }
      ])
    );
    expect(store.loadPageRecords("page-1")).toHaveLength(2);
  });

  it("does not skip a valid recovery record after removing a corrupt neighbor", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "brainvault.collaborationRecovery.v1:user-1:page-1:corrupt",
      "{not-json"
    );
    const store = createCollaborationRecoveryStore(storage);
    store.save("user-1", "page-1", "tab-1", new Uint8Array([4, 5, 6]));

    expect(store.loadAll("user-1", "page-1").map((record) => [...record.update])).toEqual([[4, 5, 6]]);
    expect(storage.getItem("brainvault.collaborationRecovery.v1:user-1:page-1:corrupt")).toBeNull();
  });

  it("does not delete a newer record written by another live tab", () => {
    const store = createCollaborationRecoveryStore(createMemoryStorage());
    const oldGeneration = store.save("user-1", "page-1", "tab-1", new Uint8Array([1]));
    const newGeneration = store.save("user-1", "page-1", "tab-1", new Uint8Array([2]));
    expect(store.remove("user-1", "page-1", "tab-1", oldGeneration)).toBe(false);
    expect(store.loadAll("user-1", "page-1")[0]?.generation).toBe(newGeneration);
    expect(store.remove("user-1", "page-1", "tab-1", newGeneration)).toBe(true);
    expect(store.loadAll("user-1", "page-1")).toEqual([]);
  });

  it("fails closed when browser storage is unavailable", () => {
    const brokenStorage = {
      get length() { throw new Error("disabled"); },
      key() { throw new Error("disabled"); },
      getItem() { throw new Error("disabled"); },
      setItem() { throw new Error("disabled"); },
      removeItem() { throw new Error("disabled"); }
    };
    const store = createCollaborationRecoveryStore(brokenStorage);
    expect(store.save("user-1", "page-1", "tab-1", new Uint8Array([1]))).toBeNull();
    expect(store.loadAll("user-1", "page-1")).toEqual([]);
    expect(store.remove("user-1", "page-1", "tab-1")).toBe(false);
  });
});
