import { describe, expect, it } from "vitest";
import { createPageTransitionLock } from "../public/page-transition-lock.js";

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

function createMemoryLockManager() {
  const held = new Set();
  return {
    async request(name, options, callback) {
      if (options?.ifAvailable && held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name, mode: options?.mode ?? "exclusive" });
      } finally {
        held.delete(name);
      }
    }
  };
}

describe("page persistence transition lock", () => {
  it("allows only one same-origin tab to change a page persistence mode", () => {
    const storage = createMemoryStorage();
    const first = createPageTransitionLock(storage, { sourceId: "tab-a" });
    const second = createPageTransitionLock(storage, { sourceId: "tab-b" });
    const lease = first.acquire("page-1", "share-add");

    expect(lease).not.toBeNull();
    expect(first.owns(lease)).toBe(true);
    expect(second.acquire("page-1", "share-remove")).toBeNull();
    expect(second.read("page-1")?.sourceId).toBe("tab-a");
    expect(first.release(lease)).toBe(true);
    expect(second.acquire("page-1", "share-remove")).not.toBeNull();
  });

  it("recovers automatically from a tab that crashed while holding the lock", () => {
    const storage = createMemoryStorage();
    let clock = 1_000;
    const first = createPageTransitionLock(storage, {
      sourceId: "tab-a",
      ttlMs: 1_000,
      now: () => clock
    });
    const second = createPageTransitionLock(storage, {
      sourceId: "tab-b",
      ttlMs: 1_000,
      now: () => clock
    });
    expect(first.acquire("page-1", "share-add")).not.toBeNull();
    clock = 2_001;
    expect(second.acquire("page-1", "share-remove")).not.toBeNull();
  });

  it("does not let a stale owner release a newer tab's lease", () => {
    const storage = createMemoryStorage();
    let clock = 1_000;
    const first = createPageTransitionLock(storage, {
      sourceId: "tab-a",
      ttlMs: 1_000,
      now: () => clock
    });
    const second = createPageTransitionLock(storage, {
      sourceId: "tab-b",
      ttlMs: 1_000,
      now: () => clock
    });
    const staleLease = first.acquire("page-1", "share-add");
    clock = 2_001;
    const currentLease = second.acquire("page-1", "share-remove");

    expect(first.release(staleLease)).toBe(false);
    expect(second.owns(currentLease)).toBe(true);
  });

  it("enumerates every active page and workspace lease without returning expired entries", () => {
    const storage = createMemoryStorage();
    let clock = 1_000;
    const first = createPageTransitionLock(storage, {
      sourceId: "tab-a",
      ttlMs: 1_000,
      now: () => clock
    });
    const second = createPageTransitionLock(storage, {
      sourceId: "tab-b",
      ttlMs: 1_000,
      now: () => clock
    });
    first.acquire("page-1", "share-add");
    second.acquire("__workspace__:user-1", "data-restore");

    expect(first.loadActive().map((record) => record.pageId).sort()).toEqual([
      "__workspace__:user-1",
      "page-1"
    ]);

    clock = 2_001;
    expect(first.loadActive()).toEqual([]);
  });

  it("does not skip a surviving lease when another tab removes a key during enumeration", () => {
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
    const first = createPageTransitionLock(storage, { sourceId: "tab-a" });
    const second = createPageTransitionLock(storage, { sourceId: "tab-b" });
    first.acquire("page-1", "share-add");
    second.acquire("__workspace__:user-1", "data-restore");

    shiftOnNextKey = true;
    expect(first.loadActive().map((record) => record.pageId)).toEqual(["__workspace__:user-1"]);
  });

  it("keeps scanning until repeated key shifts expose the final surviving lease", () => {
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
    const lock = createPageTransitionLock(storage, { sourceId: "tab-a" });
    for (const pageId of ["page-a", "page-b", "page-c", "page-survivor"]) {
      expect(lock.acquire(pageId, "delete")).not.toBeNull();
    }

    shiftsRemaining = 3;
    const inspection = lock.inspectActive();
    expect(inspection.reliable).toBe(true);
    expect(inspection.unreadableKeys).toEqual([]);
    expect(inspection.records.map((record) => record.pageId)).toEqual(["page-survivor"]);
  });

  it("does not overwrite an undecodable lease and reports unsafe enumeration", () => {
    const storage = createMemoryStorage();
    storage.setItem("brainvault.pageTransition.v1:page-1", "{not-json");
    const lock = createPageTransitionLock(storage, { sourceId: "tab-a" });
    expect(lock.inspect("page-1").status).toBe("invalid");
    expect(lock.acquire("page-1", "delete")).toBeNull();
    const activeInspection = lock.inspectActive();
    expect(activeInspection.reliable).toBe(true);
    expect(activeInspection.unreadableKeys).toHaveLength(1);
    expect(storage.getItem("brainvault.pageTransition.v1:page-1")).toBe("{not-json");

    const brokenStorage = {
      get length() { throw new Error("disabled"); },
      key() { throw new Error("disabled"); },
      getItem() { throw new Error("disabled"); },
      setItem() { throw new Error("disabled"); },
      removeItem() { throw new Error("disabled"); }
    };
    expect(createPageTransitionLock(brokenStorage, { sourceId: "tab-b" }).inspectActive().reliable).toBe(false);
  });

  it("treats an empty-string lease as occupied and preserves it", () => {
    const storage = createMemoryStorage();
    const key = "brainvault.pageTransition.v1:page-1";
    storage.setItem(key, "");
    const lock = createPageTransitionLock(storage, { sourceId: "tab-a" });

    expect(lock.inspect("page-1").status).toBe("invalid");
    expect(lock.acquire("page-1", "delete")).toBeNull();
    expect(lock.release({ pageId: "page-1", token: "unknown" })).toBe(false);
    expect(lock.inspectActive().unreadableKeys).toEqual([key]);
    expect(storage.getItem(key)).toBe("");
  });

  it("uses the browser lock manager for atomic cross-tab exclusion when available", async () => {
    const storage = createMemoryStorage();
    const lockManager = createMemoryLockManager();
    const first = createPageTransitionLock(storage, { sourceId: "tab-a", lockManager });
    const second = createPageTransitionLock(storage, { sourceId: "tab-b", lockManager });
    let releaseFirst;
    const firstRun = first.runExclusive("page-1", () => new Promise((resolve) => {
      releaseFirst = () => resolve("first");
    }));
    await Promise.resolve();

    const secondRun = await second.runExclusive("page-1", async () => "second");
    expect(secondRun).toEqual({ acquired: false, value: undefined });

    releaseFirst();
    await expect(firstRun).resolves.toEqual({ acquired: true, value: "first" });
  });

  it("fails closed when the browser lock API is unavailable", async () => {
    const storage = createMemoryStorage();
    const lock = createPageTransitionLock(storage, { sourceId: "tab-a" });
    let actionExecuted = false;
    await expect(lock.runExclusive("page-1", async () => {
      actionExecuted = true;
      return "unsafe";
    })).resolves.toEqual({
      acquired: false,
      value: undefined,
      reason: "lock-manager-unavailable"
    });
    expect(actionExecuted).toBe(false);
  });

});
