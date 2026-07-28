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

const epochA = "epoch_a";
const epochB = "epoch_b";

describe("collaboration recovery store", () => {
  it("keeps independent recovery states for concurrent tabs in one document epoch", () => {
    const store = createCollaborationRecoveryStore(createMemoryStorage());
    const first = new Uint8Array([0, 1, 2, 127, 128, 255]);
    const second = new Uint8Array([9, 8, 7]);
    expect(store.save("user-1", "page-1", "tab-1", epochA, first)).toBeTypeOf("string");
    expect(store.save("user-1", "page-1", "tab-2", epochA, second)).toBeTypeOf("string");
    const records = store.loadAll("user-1", "page-1");
    expect(records.map((record) => record.sourceId).sort()).toEqual(["tab-1", "tab-2"]);
    expect(records.every((record) => record.documentEpoch === epochA)).toBe(true);
    expect(records.map((record) => [...record.update])).toEqual(expect.arrayContaining([[...first], [...second]]));
    expect(store.loadAll("user-2", "page-1")).toEqual([]);
  });

  it("keeps an earlier document recovery when the same tab edits a replacement document", () => {
    const store = createCollaborationRecoveryStore(createMemoryStorage());
    const firstGeneration = store.save("user-1", "page-1", "tab-1", epochA, new Uint8Array([1]));
    const secondGeneration = store.save("user-1", "page-1", "tab-1", epochB, new Uint8Array([2]));

    expect(store.loadAll("user-1", "page-1").map(({ documentEpoch, generation }) => ({
      documentEpoch,
      generation
    }))).toEqual(expect.arrayContaining([
      { documentEpoch: epochA, generation: firstGeneration },
      { documentEpoch: epochB, generation: secondGeneration }
    ]));
  });

  it("enumerates one account's recoveries across pages with an encoded fallback", () => {
    const store = createCollaborationRecoveryStore(createMemoryStorage());
    store.save("user-1", "page-2", "tab-2", epochA, new Uint8Array([9, 8]));
    store.save("user-1", "page-1", "tab-1", epochB, new Uint8Array([1, 2, 3]));
    store.save("user-2", "page-3", "other-account", epochA, new Uint8Array([7]));

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
    store.save("owner", "page-1", "owner-tab", epochA, new Uint8Array([1, 2]));
    store.save("collaborator", "page-1", "collaborator-tab", epochA, new Uint8Array([3, 4]));
    store.save("collaborator", "page-2", "other-page-tab", epochB, new Uint8Array([5]));

    expect(store.loadPageRecords("page-1").map(({ accountId, sourceId }) => ({ accountId, sourceId }))).toEqual(
      expect.arrayContaining([
        { accountId: "owner", sourceId: "owner-tab" },
        { accountId: "collaborator", sourceId: "collaborator-tab" }
      ])
    );
    expect(store.loadPageRecords("page-1")).toHaveLength(2);
  });

  it("preserves schema-v1 recovery as legacy instead of deleting or auto-upgrading it", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "brainvault.collaborationRecovery.v1:user-1:page-1:tab-legacy",
      JSON.stringify({
        schemaVersion: 1,
        accountId: "user-1",
        pageId: "page-1",
        sourceId: "tab-legacy",
        generation: "legacy-generation",
        updatedAt: 1,
        update: btoa(String.fromCharCode(1, 2, 3))
      })
    );
    const store = createCollaborationRecoveryStore(storage);

    expect(store.loadAll("user-1", "page-1")).toEqual([
      expect.objectContaining({
        sourceId: "tab-legacy",
        documentEpoch: null,
        legacy: true,
        generation: "legacy-generation"
      })
    ]);
  });

  it("does not skip a valid recovery record and preserves a corrupt neighbor", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "brainvault.collaborationRecovery.v1:user-1:page-1:corrupt",
      "{not-json"
    );
    const store = createCollaborationRecoveryStore(storage);
    store.save("user-1", "page-1", "tab-1", epochA, new Uint8Array([4, 5, 6]));

    expect(store.loadAll("user-1", "page-1").map((record) => [...record.update])).toEqual([[4, 5, 6]]);
    expect(storage.getItem("brainvault.collaborationRecovery.v1:user-1:page-1:corrupt")).toBe("{not-json");
  });

  it("does not skip a surviving recovery when another tab removes a key during enumeration", () => {
    const values = new Map();
    let shiftOnNextKey = false;
    const storage = {
      get length() { return values.size; },
      key(index) {
        const key = [...values.keys()][index] ?? null;
        if (shiftOnNextKey && index === 0 && key) {
          shiftOnNextKey = false;
          values.delete(key);
        }
        return key;
      },
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, value); },
      removeItem(key) { values.delete(key); }
    };
    const store = createCollaborationRecoveryStore(storage);
    store.save("user-1", "page-1", "tab-a", epochA, new Uint8Array([1]));
    store.save("user-1", "page-1", "tab-b", epochA, new Uint8Array([2]));

    shiftOnNextKey = true;
    expect(store.loadPageRecords("page-1").map((record) => record.sourceId)).toEqual(["tab-b"]);
  });

  it("keeps scanning until repeated key shifts expose the final surviving recovery", () => {
    const values = new Map();
    let shiftsRemaining = 0;
    const storage = {
      get length() { return values.size; },
      key(index) {
        const keys = [...values.keys()];
        const key = keys[index] ?? null;
        if (shiftsRemaining > 0 && keys.length > 1 && index === keys.length - 2) {
          values.delete(keys[0]);
          shiftsRemaining -= 1;
        }
        return key;
      },
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, value); },
      removeItem(key) { values.delete(key); }
    };
    const store = createCollaborationRecoveryStore(storage);
    for (const sourceId of ["tab-a", "tab-b", "tab-c", "tab-survivor"]) {
      store.save("user-1", "page-1", sourceId, epochA, new Uint8Array([sourceId.length]));
    }

    shiftsRemaining = 3;
    const inspection = store.inspectPageRecords("page-1");
    expect(inspection.reliable).toBe(true);
    expect(inspection.unreadableKeys).toEqual([]);
    expect(inspection.records.map((record) => record.sourceId)).toEqual(["tab-survivor"]);
  });

  it("marks storage failures and undecodable target recovery as unsafe", () => {
    const brokenStorage = {
      get length() { throw new Error("disabled"); },
      key() { throw new Error("disabled"); },
      getItem() { throw new Error("disabled"); },
      setItem() { throw new Error("disabled"); },
      removeItem() { throw new Error("disabled"); }
    };
    expect(createCollaborationRecoveryStore(brokenStorage).inspectPageRecords("page-1").reliable).toBe(false);

    const storage = createMemoryStorage();
    storage.setItem(
      "brainvault.collaborationRecovery.v1:user-1:page-1:epoch_a:tab-corrupt",
      "{not-json"
    );
    const inspection = createCollaborationRecoveryStore(storage).inspectPageRecords("page-1");
    expect(inspection.reliable).toBe(true);
    expect(inspection.records).toEqual([]);
    expect(inspection.unreadableKeys).toHaveLength(1);
  });

  it("does not delete a newer record written by another live tab", () => {
    const store = createCollaborationRecoveryStore(createMemoryStorage());
    const oldGeneration = store.save("user-1", "page-1", "tab-1", epochA, new Uint8Array([1]));
    const newGeneration = store.save("user-1", "page-1", "tab-1", epochA, new Uint8Array([2]));
    expect(store.remove("user-1", "page-1", "tab-1", epochA, oldGeneration)).toBe(false);
    expect(store.loadAll("user-1", "page-1")[0]?.generation).toBe(newGeneration);
    expect(store.remove("user-1", "page-1", "tab-1", epochA, newGeneration)).toBe(true);
    expect(store.loadAll("user-1", "page-1")).toEqual([]);
  });

  it("fails closed when browser storage or the document epoch is unavailable", () => {
    const brokenStorage = {
      get length() { throw new Error("disabled"); },
      key() { throw new Error("disabled"); },
      getItem() { throw new Error("disabled"); },
      setItem() { throw new Error("disabled"); },
      removeItem() { throw new Error("disabled"); }
    };
    const store = createCollaborationRecoveryStore(brokenStorage);
    expect(store.save("user-1", "page-1", "tab-1", epochA, new Uint8Array([1]))).toBeNull();
    expect(store.loadAll("user-1", "page-1")).toEqual([]);
    expect(store.remove("user-1", "page-1", "tab-1", epochA)).toBe(false);

    const healthyStore = createCollaborationRecoveryStore(createMemoryStorage());
    expect(healthyStore.save("user-1", "page-1", "tab-1", "", new Uint8Array([1]))).toBeNull();
  });
});
