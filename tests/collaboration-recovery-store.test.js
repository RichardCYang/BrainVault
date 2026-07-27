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
