import { describe, expect, it } from "vitest";
import { createPageTransitionLock } from "../public/page-transition-lock.js";

function createMemoryStorage() {
  const values = new Map();
  return {
    failWrites: false,
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
      if (this.failWrites) throw new Error("simulated storage write failure");
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

async function acquireLease(lock, pageId, kind, exclusiveId = pageId) {
  const result = await lock.runExclusive([pageId, exclusiveId], async () =>
    lock.acquire(pageId, kind, exclusiveId)
  );
  expect(result.acquired).toBe(true);
  return result.value;
}

describe("page persistence transition lock", () => {
  it("requires the authoritative browser lock and allows only one durable lease", async () => {
    const storage = createMemoryStorage();
    const lockManager = createMemoryLockManager();
    const first = createPageTransitionLock(storage, { sourceId: "tab-a", lockManager });
    const second = createPageTransitionLock(storage, { sourceId: "tab-b", lockManager });

    expect(first.acquire("page-1", "share-add")).toBeNull();
    const lease = await acquireLease(first, "page-1", "share-add");
    expect(lease).not.toBeNull();
    expect(first.owns(lease)).toBe(true);

    const blocked = await second.runExclusive("page-1", async () =>
      second.acquire("page-1", "share-remove")
    );
    expect(blocked).toEqual({ acquired: true, value: null });
    expect(second.read("page-1")?.sourceId).toBe("tab-a");

    expect(first.release(lease)).toBe(true);
    expect(await acquireLease(second, "page-1", "share-remove")).not.toBeNull();
  });

  it("reaps an expired crashed-tab lease only while holding its browser lock", async () => {
    const storage = createMemoryStorage();
    const lockManager = createMemoryLockManager();
    let clock = 1_000;
    const first = createPageTransitionLock(storage, {
      sourceId: "tab-a",
      ttlMs: 1_000,
      now: () => clock,
      lockManager
    });
    const second = createPageTransitionLock(storage, {
      sourceId: "tab-b",
      ttlMs: 1_000,
      now: () => clock,
      lockManager
    });
    expect(await acquireLease(first, "page-1", "share-add")).not.toBeNull();
    clock = 2_001;

    expect(second.inspect("page-1").status).toBe("expired");
    expect(second.read("page-1")?.sourceId).toBe("tab-a");
    expect(second.releaseExpired("page-1")).toBe(false);

    const recovered = await second.runExclusive("page-1", async () => {
      expect(second.releaseExpired("page-1")).toBe(true);
      return second.acquire("page-1", "share-remove");
    });
    expect(recovered.acquired).toBe(true);
    expect(recovered.value).not.toBeNull();
  });

  it("does not let a stale owner release a newer tab's lease", async () => {
    const storage = createMemoryStorage();
    const lockManager = createMemoryLockManager();
    let clock = 1_000;
    const first = createPageTransitionLock(storage, {
      sourceId: "tab-a",
      ttlMs: 1_000,
      now: () => clock,
      lockManager
    });
    const second = createPageTransitionLock(storage, {
      sourceId: "tab-b",
      ttlMs: 1_000,
      now: () => clock,
      lockManager
    });
    const staleLease = await acquireLease(first, "page-1", "share-add");
    clock = 2_001;
    const recovered = await second.runExclusive("page-1", async () => {
      expect(second.releaseExpired("page-1")).toBe(true);
      return second.acquire("page-1", "share-remove");
    });
    const currentLease = recovered.value;

    expect(first.release(staleLease)).toBe(false);
    expect(second.owns(currentLease)).toBe(true);
  });

  it("enumerates active and expired fences until each stale lease is reaped", async () => {
    const storage = createMemoryStorage();
    const lockManager = createMemoryLockManager();
    let clock = 1_000;
    const first = createPageTransitionLock(storage, {
      sourceId: "tab-a",
      ttlMs: 1_000,
      now: () => clock,
      lockManager
    });
    const second = createPageTransitionLock(storage, {
      sourceId: "tab-b",
      ttlMs: 1_000,
      now: () => clock,
      lockManager
    });
    await acquireLease(first, "page-1", "share-add");
    await acquireLease(second, "__workspace__:user-1", "data-restore");

    expect(first.loadActive().map((record) => record.pageId).sort()).toEqual([
      "__workspace__:user-1",
      "page-1"
    ]);

    clock = 2_001;
    expect(first.loadActive().map((record) => record.pageId).sort()).toEqual([
      "__workspace__:user-1",
      "page-1"
    ]);
    await first.runExclusive("page-1", async () => first.releaseExpired("page-1"));
    await first.runExclusive("__workspace__:user-1", async () =>
      first.releaseExpired("__workspace__:user-1")
    );
    expect(first.loadActive()).toEqual([]);
  });

  it("does not skip a surviving lease when another tab removes a key during enumeration", async () => {
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
    const lockManager = createMemoryLockManager();
    const first = createPageTransitionLock(storage, { sourceId: "tab-a", lockManager });
    const second = createPageTransitionLock(storage, { sourceId: "tab-b", lockManager });
    await acquireLease(first, "page-1", "share-add");
    await acquireLease(second, "__workspace__:user-1", "data-restore");

    shiftOnNextKey = true;
    expect(first.loadActive().map((record) => record.pageId)).toEqual(["__workspace__:user-1"]);
  });

  it("keeps scanning until repeated key shifts expose the final surviving lease", async () => {
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
    const lockManager = createMemoryLockManager();
    const lock = createPageTransitionLock(storage, { sourceId: "tab-a", lockManager });
    for (const pageId of ["page-a", "page-b", "page-c", "page-survivor"]) {
      expect(await acquireLease(lock, pageId, "delete")).not.toBeNull();
    }

    shiftsRemaining = 3;
    const inspection = lock.inspectActive();
    expect(inspection.reliable).toBe(true);
    expect(inspection.unreadableKeys).toEqual([]);
    expect(inspection.records.map((record) => record.pageId)).toEqual(["page-survivor"]);
  });

  it("does not overwrite an undecodable lease and reports unsafe enumeration", async () => {
    const storage = createMemoryStorage();
    const lockManager = createMemoryLockManager();
    storage.setItem("brainvault.pageTransition.v1:page-1", "{not-json");
    const lock = createPageTransitionLock(storage, { sourceId: "tab-a", lockManager });
    expect(lock.inspect("page-1").status).toBe("invalid");
    const result = await lock.runExclusive("page-1", async () => lock.acquire("page-1", "delete"));
    expect(result.value).toBeNull();
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

  it("treats an empty-string lease as occupied and preserves it", async () => {
    const storage = createMemoryStorage();
    const lockManager = createMemoryLockManager();
    const key = "brainvault.pageTransition.v1:page-1";
    storage.setItem(key, "");
    const lock = createPageTransitionLock(storage, { sourceId: "tab-a", lockManager });

    expect(lock.inspect("page-1").status).toBe("invalid");
    const result = await lock.runExclusive("page-1", async () => lock.acquire("page-1", "delete"));
    expect(result.value).toBeNull();
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

  it("keeps an expired lease visible while a slow destructive action still holds its lock", async () => {
    const storage = createMemoryStorage();
    const lockManager = createMemoryLockManager();
    let clock = 1_000;
    const first = createPageTransitionLock(storage, {
      sourceId: "tab-a",
      ttlMs: 1_000,
      now: () => clock,
      lockManager
    });
    const second = createPageTransitionLock(storage, {
      sourceId: "tab-b",
      ttlMs: 1_000,
      now: () => clock,
      lockManager
    });
    let releaseAction;
    let lease;
    const firstRun = first.runExclusive(["page-1", "__workspace__:user-1"], async () => {
      lease = first.acquire("page-1", "page-delete", "__workspace__:user-1");
      await new Promise((resolve) => { releaseAction = resolve; });
      return "deleted";
    });
    await Promise.resolve();

    storage.failWrites = true;
    clock = 1_400;
    expect(first.renew(lease)).toBeNull();
    clock = 2_001;
    expect(second.inspect("page-1").status).toBe("expired");
    expect(second.read("page-1")?.token).toBe(lease.token);
    expect(storage.getItem("brainvault.pageTransition.v1:page-1")).not.toBeNull();

    const blockedReaper = await second.runExclusive(
      ["page-1", "__workspace__:user-1"],
      async () => second.releaseExpired("page-1")
    );
    expect(blockedReaper).toEqual({ acquired: false, value: undefined });
    expect(second.read("page-1")?.token).toBe(lease.token);

    storage.failWrites = false;
    releaseAction();
    await expect(firstRun).resolves.toEqual({ acquired: true, value: "deleted" });
    const reaped = await second.runExclusive(
      ["page-1", "__workspace__:user-1"],
      async () => second.releaseExpired("page-1")
    );
    expect(reaped).toEqual({ acquired: true, value: true });
    expect(second.inspect("page-1").status).toBe("missing");
  });

  it("renews the same expired lease after a delayed timer while the browser lock is held", async () => {
    const storage = createMemoryStorage();
    const lockManager = createMemoryLockManager();
    let clock = 1_000;
    const lock = createPageTransitionLock(storage, {
      sourceId: "tab-a",
      ttlMs: 1_000,
      now: () => clock,
      lockManager
    });

    const result = await lock.runExclusive("page-1", async () => {
      const lease = lock.acquire("page-1", "delete");
      clock = 2_001;
      expect(lock.inspect("page-1").status).toBe("expired");
      const renewed = lock.renew(lease);
      expect(renewed).not.toBeNull();
      expect(lock.inspect("page-1").status).toBe("active");
      return renewed;
    });
    expect(result.acquired).toBe(true);
    expect(result.value?.expiresAt).toBe(3_001);
  });

  it("does not reap a scoped expired lease while holding the wrong browser lock", async () => {
    const storage = createMemoryStorage();
    const lockManager = createMemoryLockManager();
    let clock = 1_000;
    const first = createPageTransitionLock(storage, {
      sourceId: "tab-a",
      ttlMs: 1_000,
      now: () => clock,
      lockManager
    });
    const second = createPageTransitionLock(storage, {
      sourceId: "tab-b",
      ttlMs: 1_000,
      now: () => clock,
      lockManager
    });
    await acquireLease(first, "page-1", "delete", "__workspace__:user-1");
    clock = 2_001;

    const wrongScope = await second.runExclusive("page-1", async () => second.releaseExpired("page-1"));
    expect(wrongScope).toEqual({ acquired: true, value: false });
    expect(second.inspect("page-1").status).toBe("expired");

    const correctScope = await second.runExclusive("__workspace__:user-1", async () =>
      second.releaseExpired("page-1")
    );
    expect(correctScope).toEqual({ acquired: true, value: true });
  });

  it("rejects an incomplete multi-scope lock request instead of dropping a scope", async () => {
    const storage = createMemoryStorage();
    const lock = createPageTransitionLock(storage, {
      sourceId: "tab-a",
      lockManager: createMemoryLockManager()
    });
    let actionExecuted = false;

    await expect(lock.runExclusive(["page-1", ""], async () => {
      actionExecuted = true;
    })).rejects.toThrow("One or more pageIds");
    expect(actionExecuted).toBe(false);
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
