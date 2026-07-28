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

  it("falls back to the durable lease when the browser lock API is unavailable", async () => {
    const storage = createMemoryStorage();
    const lock = createPageTransitionLock(storage, { sourceId: "tab-a" });
    await expect(lock.runExclusive("page-1", async () => "saved")).resolves.toEqual({
      acquired: true,
      value: "saved"
    });
  });

});
