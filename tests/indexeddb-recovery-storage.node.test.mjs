import assert from "node:assert/strict";
import test from "node:test";
import { createIndexedDbRecoveryStorage } from "../public/indexeddb-recovery-storage.js";
import { createPageDraftStore } from "../public/draft-store.js";
import { createCollaborationRecoveryStore } from "../public/collaboration-recovery-store.js";

class MemoryStorage {
  constructor(entries = []) { this.values = new Map(entries); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

class FakeStorageEventTarget {
  constructor() { this.listeners = new Set(); }
  addEventListener(type, listener) { if (type === "storage") this.listeners.add(listener); }
  removeEventListener(type, listener) { if (type === "storage") this.listeners.delete(listener); }
  emit(event) { for (const listener of [...this.listeners]) listener(event); }
}

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : value;
}

class FakeIndexedDb {
  constructor({ ignoreDurability = false, corruptReadbackKeys = [], failDeleteKeys = [], failReadKeys = [], failClear = false } = {}) {
    this.databases = new Map();
    this.ignoreDurability = ignoreDurability;
    this.corruptReadbackKeys = new Set(corruptReadbackKeys);
    this.failDeleteKeys = new Set(failDeleteKeys);
    this.failReadKeys = new Set(failReadKeys);
    this.failClear = failClear;
    this.transactions = [];
    this.pausedReadKeys = new Set();
    this.pendingReads = [];
  }
  releasePausedReads() {
    for (const read of this.pendingReads.splice(0)) queueMicrotask(read);
  }
  open(name) {
    const request = {};
    queueMicrotask(() => {
      let state = this.databases.get(name);
      const created = !state;
      if (!state) {
        state = { stores: new Map() };
        this.databases.set(name, state);
      }
      const db = {
        objectStoreNames: { contains: (storeName) => state.stores.has(storeName) },
        createObjectStore: (storeName) => {
          if (!state.stores.has(storeName)) state.stores.set(storeName, new Map());
        },
        transaction: (storeName, mode = "readonly", options = {}) => {
          const requestedDurability = options?.durability ?? "default";
          const durability = this.ignoreDurability ? "default" : requestedDurability;
          const transaction = {
            error: null,
            oncomplete: null,
            onabort: null,
            onerror: null,
            durability,
            abort() {
              transaction.error = new Error("Fake IndexedDB transaction aborted");
              queueMicrotask(() => transaction.onabort?.());
            }
          };
          this.transactions.push({ storeName, mode, requestedDurability, durability });
          const store = state.stores.get(storeName);
          if (!store) throw new Error(`Missing fake object store ${storeName}`);
          transaction.objectStore = () => ({
            getAll() {
              const child = { result: null, error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                child.result = [...store.entries()].map(([key, value]) => ({ key, value: clone(value) }));
                child.onsuccess?.();
              });
              return child;
            },
            get: (key) => {
              const child = { result: null, error: null, onsuccess: null, onerror: null };
              const finishRead = (exists, value) => {
                if (this.failReadKeys.has(key)) {
                  child.error = new Error(`simulated IndexedDB read failure for ${key}`);
                  child.onerror?.();
                  return;
                }
                child.result = exists
                  ? {
                      key,
                      value: this.corruptReadbackKeys.has(key) ? "__corrupted__" : clone(value)
                    }
                  : undefined;
                child.onsuccess?.();
              };
              if (this.pausedReadKeys.has(key)) {
                const exists = store.has(key);
                const value = exists ? clone(store.get(key)) : undefined;
                this.pendingReads.push(() => finishRead(exists, value));
              } else {
                queueMicrotask(() => {
                  const exists = store.has(key);
                  finishRead(exists, exists ? clone(store.get(key)) : undefined);
                });
              }
              return child;
            },
            put(record) { store.set(record.key, clone(record.value)); },
            delete: (key) => {
              if (this.failDeleteKeys.has(key)) {
                transaction.error = new Error(`simulated IndexedDB delete failure for ${key}`);
                queueMicrotask(() => transaction.onabort?.());
                return;
              }
              store.delete(key);
            },
            clear: () => {
              if (this.failClear) {
                transaction.error = new Error("simulated IndexedDB clear failure");
                queueMicrotask(() => transaction.onabort?.());
                return;
              }
              store.clear();
            }
          });
          setTimeout(() => transaction.oncomplete?.(), 0);
          return transaction;
        },
        close() {}
      };
      request.result = db;
      if (created) request.onupgradeneeded?.();
      queueMicrotask(() => request.onsuccess?.());
    });
    return request;
  }
}


class FakeBroadcastHub {
  constructor() { this.channels = new Map(); }
  create = (name) => {
    const listeners = new Set();
    const channel = {
      addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
      removeEventListener(type, listener) { if (type === "message") listeners.delete(listener); },
      postMessage: (data) => {
        for (const peer of this.channels.get(name) ?? []) {
          if (peer === channel) continue;
          queueMicrotask(() => peer._dispatch({ data: clone(data) }));
        }
      },
      _dispatch(event) { for (const listener of [...listeners]) listener(event); },
      close: () => this.channels.get(name)?.delete(channel)
    };
    const group = this.channels.get(name) ?? new Set();
    group.add(channel);
    this.channels.set(name, group);
    return channel;
  };
}

class QueuedBroadcastHub {
  constructor() {
    this.channels = new Map();
    this.pending = [];
  }
  create = (name) => {
    const listeners = new Set();
    const channel = {
      addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
      removeEventListener(type, listener) { if (type === "message") listeners.delete(listener); },
      postMessage: (data) => {
        for (const peer of this.channels.get(name) ?? []) {
          if (peer === channel) continue;
          this.pending.push(() => peer._dispatch({ data: clone(data) }));
        }
      },
      _dispatch(event) { for (const listener of [...listeners]) listener(event); },
      close: () => this.channels.get(name)?.delete(channel)
    };
    const group = this.channels.get(name) ?? new Set();
    group.add(channel);
    this.channels.set(name, group);
    return channel;
  };
  deliverAll() {
    for (const deliver of this.pending.splice(0)) deliver();
  }
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("fails closed when strict IndexedDB durability cannot be confirmed", async () => {
  const indexedDb = new FakeIndexedDb({ ignoreDurability: true });

  await assert.rejects(
    createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
      databaseName: "strict-durability-rejected"
    }),
    (error) => error?.code === "RECOVERY_STRICT_DURABILITY_UNAVAILABLE"
  );
});

test("uses strict durability for every recovery write transaction", async () => {
  const indexedDb = new FakeIndexedDb();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "strict-durability-write"
  });

  storage.setItem("brainvault.pageDraft.v2:user:page:tab", "draft");
  await storage.flush();
  storage.removeItem("brainvault.pageDraft.v2:user:page:tab");
  await storage.flush();
  storage.setObject("collaboration:large", { update: new Uint8Array([1, 2, 3]) });
  await storage.flush();
  storage.clear();
  await storage.flush();

  const writeTransactions = indexedDb.transactions.filter(({ mode }) => mode === "readwrite");
  assert.ok(writeTransactions.length >= 5, "probe plus put/delete/put/clear writes should be observed");
  assert.ok(writeTransactions.every(({ requestedDurability }) => requestedDurability === "strict"));
  assert.ok(writeTransactions.every(({ durability }) => durability === "strict"));
  storage.close();
});

test("flush drains recovery writes queued while the barrier is in flight", async () => {
  const indexedDb = new FakeIndexedDb();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "flush-inflight-race",
    storageEventTarget: null
  });

  storage.setItem("brainvault.pageDraft.v2:user:page:first", "first");
  const flushing = storage.flush();
  storage.setItem("brainvault.pageDraft.v2:user:page:second", "second");
  await flushing;

  assert.equal(
    storage.hasPendingWrites(),
    false,
    "flush must not resolve while a recovery write queued during the barrier is still pending"
  );
  storage.close();
});

test("reports and flush-rejects failed recovery deletions instead of silently discarding them", async () => {
  const key = "brainvault.pageDraft.v2:user:page:tab";
  const indexedDb = new FakeIndexedDb();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "delete-failure-test"
  });
  const writeErrors = [];
  storage.onWriteError((error, context) => writeErrors.push({ error, context }));

  storage.setItem(key, "durable-draft");
  await storage.flush();
  indexedDb.failDeleteKeys.add(key);

  storage.removeItem(key);
  await assert.rejects(storage.flush(), /simulated IndexedDB delete failure/);
  assert.equal(
    storage.getItem(key),
    "durable-draft",
    "a failed durable delete must restore the still-durable record to the in-memory mirror"
  );
  assert.equal(writeErrors.at(-1)?.context?.operation, "delete");
  storage.close();

  indexedDb.failDeleteKeys.delete(key);
  const reopened = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "delete-failure-test"
  });
  assert.equal(reopened.getItem(key), "durable-draft");
  reopened.close();
});

test("failed recovery deletion cannot overwrite a newer local recovery write", async () => {
  const key = "brainvault.pageDraft.v2:user:page:tab";
  const indexedDb = new FakeIndexedDb();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "delete-failure-newer-write-test"
  });

  storage.setItem(key, "old-draft");
  await storage.flush();
  indexedDb.failDeleteKeys.add(key);

  storage.removeItem(key);
  storage.setItem(key, "newer-draft");
  await assert.rejects(storage.flush(), /simulated IndexedDB delete failure/);
  assert.equal(storage.getItem(key), "newer-draft");

  indexedDb.failDeleteKeys.delete(key);
  storage.close();
  const reopened = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "delete-failure-newer-write-test"
  });
  assert.equal(reopened.getItem(key), "newer-draft");
  reopened.close();
});

test("restores still-durable recovery records when a clear transaction fails", async () => {
  const firstKey = "brainvault.pageDraft.v2:user:page:first";
  const secondKey = "brainvault.pageDraft.v2:user:page:second";
  const indexedDb = new FakeIndexedDb();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "clear-failure-test"
  });
  const writeErrors = [];
  storage.onWriteError((error, context) => writeErrors.push({ error, context }));

  storage.setItem(firstKey, "first durable draft");
  storage.setItem(secondKey, "second durable draft");
  await storage.flush();
  indexedDb.failClear = true;

  storage.clear();
  await assert.rejects(storage.flush(), /simulated IndexedDB clear failure/);
  assert.equal(storage.getItem(firstKey), "first durable draft");
  assert.equal(storage.getItem(secondKey), "second durable draft");
  assert.equal(writeErrors.at(-1)?.context?.operation, "clear");
  storage.close();

  indexedDb.failClear = false;
  const reopened = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "clear-failure-test"
  });
  assert.equal(reopened.getItem(firstKey), "first durable draft");
  assert.equal(reopened.getItem(secondKey), "second durable draft");
  reopened.close();
});

test("failed recovery clear preserves newer local writes while restoring untouched records", async () => {
  const changedKey = "brainvault.pageDraft.v2:user:page:changed";
  const untouchedKey = "brainvault.pageDraft.v2:user:page:untouched";
  const indexedDb = new FakeIndexedDb();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "clear-failure-newer-write-test"
  });

  storage.setItem(changedKey, "old changed draft");
  storage.setItem(untouchedKey, "untouched durable draft");
  await storage.flush();
  indexedDb.failClear = true;

  storage.clear();
  storage.setItem(changedKey, "newer changed draft");
  await assert.rejects(storage.flush(), /simulated IndexedDB clear failure/);
  assert.equal(storage.getItem(changedKey), "newer changed draft");
  assert.equal(storage.getItem(untouchedKey), "untouched durable draft");

  indexedDb.failClear = false;
  storage.close();
  const reopened = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "clear-failure-newer-write-test"
  });
  assert.equal(reopened.getItem(changedKey), "newer changed draft");
  assert.equal(reopened.getItem(untouchedKey), "untouched durable draft");
  reopened.close();
});

test("successful recovery clear cannot resurrect a value from an older failed delete", async () => {
  const key = "brainvault.pageDraft.v2:user:page:tab";
  const indexedDb = new FakeIndexedDb();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "clear-supersedes-delete-failure-test"
  });

  storage.setItem(key, "obsolete draft");
  await storage.flush();
  indexedDb.failDeleteKeys.add(key);

  storage.removeItem(key);
  storage.clear();
  await assert.rejects(storage.flush(), /simulated IndexedDB delete failure/);
  assert.equal(storage.getItem(key), null);
  assert.equal(storage.length, 0);

  indexedDb.failDeleteKeys.delete(key);
  storage.close();
  const reopened = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "clear-supersedes-delete-failure-test"
  });
  assert.equal(reopened.getItem(key), null);
  reopened.close();
});

test("keeps the legacy recovery copy when post-commit migration verification fails", async () => {
  const key = "brainvault.pageDraft.v2:user:page:tab";
  const legacyValue = JSON.stringify({ schemaVersion: 2, marker: "legacy" });
  const indexedDb = new FakeIndexedDb({ corruptReadbackKeys: [key] });
  const legacy = new MemoryStorage([[key, legacyValue]]);

  await assert.rejects(
    createIndexedDbRecoveryStorage(indexedDb, legacy, {
      databaseName: "migration-verification-failure",
      migrationPrefixes: ["brainvault.pageDraft.v2:"]
    }),
    /migration verification failed/
  );
  assert.equal(legacy.getItem(key), legacyValue);
});

test("migrates legacy recovery after IndexedDB commit without destructively removing the fallback", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:tab";
  const legacyValue = JSON.stringify({ schemaVersion: 2, marker: "legacy" });
  const legacy = new MemoryStorage([[key, legacyValue]]);
  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "migration-test",
    migrationPrefixes: ["brainvault.pageDraft.v2:"]
  });

  assert.equal(legacy.getItem(key), legacyValue);
  assert.match(storage.getItem(key), /"marker":"legacy"/);
  await storage.flush();
  storage.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "migration-test",
    migrationPrefixes: ["brainvault.pageDraft.v2:"]
  });
  assert.match(reopened.getItem(key), /"marker":"legacy"/);
  assert.equal(legacy.getItem(key), legacyValue);
  reopened.close();
});

test("deleted migrated legacy recovery does not resurrect on restart", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:tab";
  const legacyValue = JSON.stringify({ schemaVersion: 2, marker: "already-acknowledged" });
  const legacy = new MemoryStorage([[key, legacyValue]]);

  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "migration-delete-restart",
    migrationPrefixes: ["brainvault.pageDraft.v2:"]
  });
  assert.equal(storage.getItem(key), legacyValue);

  storage.removeItem(key);
  await storage.flush();
  assert.equal(storage.getItem(key), null);
  storage.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "migration-delete-restart",
    migrationPrefixes: ["brainvault.pageDraft.v2:"]
  });
  assert.equal(
    reopened.getItem(key),
    null,
    "an acknowledged legacy fallback must not be imported again after its IndexedDB copy was durably deleted"
  );
  reopened.close();
});

test("durable acknowledgement of migrated legacy recovery stays deleted after restart", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:tab";
  const legacyValue = JSON.stringify({ schemaVersion: 2, marker: "uploaded" });
  const legacy = new MemoryStorage([[key, legacyValue]]);
  const options = {
    databaseName: "migration-compare-delete-restart",
    migrationPrefixes: ["brainvault.pageDraft.v2:"]
  };

  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, options);
  assert.equal(await storage.compareAndRemove(key, (value) => value === legacyValue), true);
  await storage.flush();
  storage.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, legacy, options);
  assert.equal(reopened.getItem(key), null);
  assert.equal(reopened.length, 0, "internal migration receipts must not leak through the Storage-compatible API");
  reopened.close();
});

test("clearing migrated recovery does not re-import retained legacy fallbacks", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:tab";
  const legacyValue = JSON.stringify({ schemaVersion: 2, marker: "cleared" });
  const legacy = new MemoryStorage([[key, legacyValue]]);
  const options = {
    databaseName: "migration-clear-restart",
    migrationPrefixes: ["brainvault.pageDraft.v2:"]
  };

  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, options);
  storage.clear();
  await storage.flush();
  storage.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, legacy, options);
  assert.equal(reopened.getItem(key), null);
  reopened.close();
});

test("cross-tab clear preserves a newer durable legacy migration receipt", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:cross-tab-clear";
  const initialValue = JSON.stringify({ schemaVersion: 2, marker: "initial" });
  const newerValue = JSON.stringify({ schemaVersion: 2, marker: "newer-legacy-generation" });
  const legacy = new MemoryStorage([[key, initialValue]]);
  const writerEvents = new FakeStorageEventTarget();
  const clearerEvents = new FakeStorageEventTarget();
  const hub = new FakeBroadcastHub();
  const options = {
    databaseName: "migration-cross-tab-clear-receipt",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    broadcastChannelFactory: hub.create
  };

  const writer = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    ...options,
    storageEventTarget: writerEvents
  });
  const clearer = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    ...options,
    storageEventTarget: clearerEvents
  });

  // Only the writer has received the legacy localStorage event so far. Its
  // IndexedDB commit/broadcast advances the durable migration receipt, while the
  // clearer can already observe the new record with an older in-memory receipt.
  legacy.setItem(key, newerValue);
  writerEvents.emit({
    key,
    oldValue: initialValue,
    newValue: newerValue,
    storageArea: legacy
  });
  await writer.flush();
  await nextTask();
  await clearer.flush();
  assert.equal(clearer.getItem(key), newerValue);

  clearer.clear();
  await clearer.flush();
  assert.equal(clearer.getItem(key), null);
  writer.close();
  clearer.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    ...options,
    storageEventTarget: null,
    broadcastChannelFactory: null
  });
  assert.equal(
    reopened.getItem(key),
    null,
    "clear must retain the newest durable migration receipt instead of resurrecting the legacy draft"
  );
  reopened.close();
});

test("legacy migration never deletes a newer recovery write from an older tab", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:tab";
  const initialValue = JSON.stringify({ schemaVersion: 2, marker: "before-migration" });
  const newerValue = JSON.stringify({ schemaVersion: 2, marker: "newer-old-tab-write" });

  class ConcurrentLegacyStorage extends MemoryStorage {
    constructor(entries) {
      super(entries);
      this.injectedWrite = false;
    }

    getItem(storageKey) {
      const value = super.getItem(storageKey);
      if (storageKey === key && !this.injectedWrite) {
        this.injectedWrite = true;
        queueMicrotask(() => this.setItem(key, newerValue));
      }
      return value;
    }
  }

  const legacy = new ConcurrentLegacyStorage([[key, initialValue]]);
  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "migration-concurrent-write",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: null
  });

  assert.equal(
    storage.getItem(key),
    newerValue,
    "migration must reconcile a newer legacy write that arrived while IndexedDB commit/verification was pending"
  );
  assert.equal(
    legacy.getItem(key),
    newerValue,
    "migration must not remove a newer legacy write that arrived while IndexedDB commit/verification was pending"
  );
  storage.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "migration-concurrent-write",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: null
  });
  assert.equal(reopened.getItem(key), newerValue);
  reopened.close();
});

test("captures legacy recovery created during the final migration pass before listener handoff", async () => {
  const indexedDb = new FakeIndexedDb();
  const events = new FakeStorageEventTarget();
  const seedKey = "brainvault.pageDraft.v2:user:page:seed";
  const lateKey = "brainvault.pageDraft.v2:user:page:late";
  const seedValue = JSON.stringify({ schemaVersion: 2, marker: "seed" });
  const lateValue = JSON.stringify({ schemaVersion: 2, marker: "late-final-pass-write" });

  class FinalPassLegacyStorage extends MemoryStorage {
    constructor(entries) {
      super(entries);
      this.seedReads = 0;
      this.injectedWrite = false;
    }

    getItem(storageKey) {
      const value = super.getItem(storageKey);
      if (storageKey === seedKey) {
        this.seedReads += 1;
        if (this.seedReads === 2 && !this.injectedWrite) {
          this.injectedWrite = true;
          queueMicrotask(() => {
            const oldValue = super.getItem(lateKey);
            super.setItem(lateKey, lateValue);
            events.emit({ key: lateKey, oldValue, newValue: lateValue });
          });
        }
      }
      return value;
    }
  }

  const legacy = new FinalPassLegacyStorage([[seedKey, seedValue]]);
  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "migration-final-pass-listener-gap",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: events
  });

  assert.equal(legacy.getItem(lateKey), lateValue);
  assert.equal(
    storage.getItem(lateKey),
    lateValue,
    "a recovery draft created after the final migration snapshot must be visible before initialization returns"
  );
  await storage.flush();
  storage.close();
});

test("legacy storage deletion removes the exact migrated IndexedDB recovery", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:legacy-tab";
  const legacyValue = JSON.stringify({ schemaVersion: 2, marker: "acknowledged-by-old-tab" });
  const legacy = new MemoryStorage([[key, legacyValue]]);
  const events = new FakeStorageEventTarget();
  const options = {
    databaseName: "legacy-delete-event",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: events
  };

  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, options);
  assert.equal(storage.getItem(key), legacyValue);

  legacy.removeItem(key);
  events.emit({ key, oldValue: legacyValue, newValue: null });
  await nextTask();
  await storage.flush();
  assert.equal(storage.getItem(key), null);
  storage.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    ...options,
    storageEventTarget: null
  });
  assert.equal(reopened.getItem(key), null);
  reopened.close();
});

test("ignores same-key recovery deletion events from a different Storage area", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:foreign-storage-event";
  const legacyValue = JSON.stringify({ schemaVersion: 2, marker: "local-draft" });
  const legacy = new MemoryStorage([[key, legacyValue]]);
  const foreignStorage = new MemoryStorage([[key, legacyValue]]);
  const events = new FakeStorageEventTarget();
  const options = {
    databaseName: "foreign-storage-area-event",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: events
  };

  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, options);
  assert.equal(storage.getItem(key), legacyValue);

  legacy.removeItem(key);
  events.emit({
    key,
    oldValue: legacyValue,
    newValue: null,
    storageArea: foreignStorage
  });
  await nextTask();
  await storage.flush();

  assert.equal(
    storage.getItem(key),
    legacyValue,
    "an unrelated Storage area must not acknowledge or delete localStorage recovery"
  );
  storage.close();
});

test("delayed legacy deletion reconciles a newer current legacy draft instead of hiding it", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:legacy-tab";
  const oldValue = JSON.stringify({ schemaVersion: 2, marker: "old" });
  const newerValue = JSON.stringify({ schemaVersion: 2, marker: "newer" });
  const legacy = new MemoryStorage([[key, oldValue]]);
  const events = new FakeStorageEventTarget();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "legacy-stale-delete-event",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: events
  });

  legacy.setItem(key, newerValue);
  events.emit({ key, oldValue, newValue: null });
  await nextTask();
  await storage.flush();
  assert.equal(storage.getItem(key), newerValue);
  storage.close();
});

test("legacy deletion cannot remove a newer IndexedDB value for the same recovery key", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:legacy-tab";
  const legacyValue = JSON.stringify({ schemaVersion: 2, marker: "legacy" });
  const newerIndexedDbValue = JSON.stringify({ schemaVersion: 2, marker: "new-indexeddb" });
  const legacy = new MemoryStorage([[key, legacyValue]]);
  const events = new FakeStorageEventTarget();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "legacy-delete-newer-indexeddb",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: events
  });

  storage.setItem(key, newerIndexedDbValue);
  await storage.flush();
  legacy.removeItem(key);
  events.emit({ key, oldValue: legacyValue, newValue: null });
  await nextTask();
  await storage.flush();
  assert.equal(storage.getItem(key), newerIndexedDbValue);
  storage.close();
});

test("delayed legacy write cannot resurrect an acknowledged migrated recovery", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:legacy-tab";
  const legacyValue = JSON.stringify({ schemaVersion: 2, marker: "already-acknowledged" });
  const legacy = new MemoryStorage([[key, legacyValue]]);
  const events = new FakeStorageEventTarget();
  const options = {
    databaseName: "legacy-stale-put-after-ack",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: events
  };

  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, options);
  assert.equal(storage.getItem(key), legacyValue);
  assert.equal(await storage.compareAndRemove(key, (storedValue) => storedValue === legacyValue), true);
  await storage.flush();
  assert.equal(storage.getItem(key), null);

  // The localStorage fallback is intentionally retained. A delayed storage
  // event for its already-migrated bytes must not make that stale copy live again.
  events.emit({ key, oldValue: null, newValue: legacyValue });
  await nextTask();
  await storage.flush();
  assert.equal(storage.getItem(key), null);
  storage.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    ...options,
    storageEventTarget: null
  });
  assert.equal(reopened.getItem(key), null);
  reopened.close();
});

test("delayed legacy write cannot overwrite newer IndexedDB recovery for the same key", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:legacy-tab";
  const legacyValue = JSON.stringify({ schemaVersion: 2, marker: "legacy" });
  const newerIndexedDbValue = JSON.stringify({ schemaVersion: 2, marker: "newer-indexeddb" });
  const legacy = new MemoryStorage([[key, legacyValue]]);
  const events = new FakeStorageEventTarget();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "legacy-stale-put-newer-indexeddb",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: events
  });

  storage.setItem(key, newerIndexedDbValue);
  await storage.flush();
  assert.equal(storage.getItem(key), newerIndexedDbValue);

  events.emit({ key, oldValue: null, newValue: legacyValue });
  await nextTask();
  await storage.flush();
  assert.equal(storage.getItem(key), newerIndexedDbValue);
  storage.close();
});

test("delayed changed legacy write cannot overwrite a newer IndexedDB recovery value", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:legacy-tab";
  const migratedValue = JSON.stringify({ schemaVersion: 2, marker: "migrated" });
  const delayedLegacyValue = JSON.stringify({ schemaVersion: 2, marker: "older-legacy-write" });
  const newerIndexedDbValue = JSON.stringify({ schemaVersion: 2, marker: "newer-indexeddb" });
  const legacy = new MemoryStorage([[key, migratedValue]]);
  const events = new FakeStorageEventTarget();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "legacy-stale-changed-put-newer-indexeddb",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: events
  });

  // The older tab writes first, but delivery of its storage event is delayed.
  legacy.setItem(key, delayedLegacyValue);

  // A newer recovery value commits durably before the old event reaches this tab.
  storage.setItem(key, newerIndexedDbValue);
  await storage.flush();
  assert.equal(storage.getItem(key), newerIndexedDbValue);

  events.emit({ key, oldValue: migratedValue, newValue: delayedLegacyValue });
  await nextTask();
  await storage.flush();
  assert.equal(storage.getItem(key), newerIndexedDbValue);
  storage.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "legacy-stale-changed-put-newer-indexeddb",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: null
  });
  assert.equal(reopened.getItem(key), newerIndexedDbValue);
  reopened.close();
});

test("stores large binary recovery values without localStorage/base64 expansion", async () => {
  const indexedDb = new FakeIndexedDb();
  const legacy = new MemoryStorage();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "binary-test"
  });
  const bytes = new Uint8Array(6 * 1024 * 1024);
  bytes[0] = 17;
  bytes[bytes.length - 1] = 91;

  storage.setObject("collaboration:large", { schemaVersion: 3, update: bytes });
  await storage.flush();
  const recovered = storage.getObject("collaboration:large");

  assert.equal(recovered.update.byteLength, bytes.byteLength);
  assert.equal(recovered.update[0], 17);
  assert.equal(recovered.update[recovered.update.length - 1], 91);
  storage.close();
});


test("cross-tab mirrors refresh only after another tab commits IndexedDB recovery", async () => {
  const indexedDb = new FakeIndexedDb();
  const hub = new FakeBroadcastHub();
  const options = {
    databaseName: "cross-tab-test",
    broadcastChannelFactory: hub.create,
    storageEventTarget: null
  };
  const first = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const second = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const changes = [];
  second.subscribe((change) => changes.push(change));

  first.setObject("brainvault.collaborationRecovery.v1:acct:page:tab", {
    schemaVersion: 3,
    update: new Uint8Array([4, 8, 15, 16, 23, 42])
  });
  await first.flush();
  await nextTask();
  await second.flush();

  const mirrored = second.getObject("brainvault.collaborationRecovery.v1:acct:page:tab");
  assert.deepEqual([...mirrored.update], [4, 8, 15, 16, 23, 42]);
  assert.equal(changes.at(-1)?.operation, "put");

  first.removeItem("brainvault.collaborationRecovery.v1:acct:page:tab");
  await first.flush();
  await nextTask();
  await second.flush();
  assert.equal(second.getObject("brainvault.collaborationRecovery.v1:acct:page:tab"), null);
  assert.equal(changes.at(-1)?.operation, "delete");

  first.close();
  second.close();
});

test("foreign draft acknowledgement cannot overwrite a newer cross-tab IndexedDB draft", async () => {
  const indexedDb = new FakeIndexedDb();
  const hub = new QueuedBroadcastHub();
  const options = {
    databaseName: "cross-tab-foreign-draft-cas",
    broadcastChannelFactory: hub.create,
    storageEventTarget: null
  };
  const reconcilingStorage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const editingStorage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const reconcilingDrafts = createPageDraftStore(reconcilingStorage, { sourceId: "tab-reader" });
  const editingDrafts = createPageDraftStore(editingStorage, { sourceId: "tab-editing" });

  assert.equal(editingDrafts.saveTitle({
    userId: "user-1",
    pageId: "page-1",
    value: "server title",
    expectedVersion: 4,
    revision: 2
  }), true);
  assert.equal(editingDrafts.saveBlock({
    userId: "user-1",
    pageId: "page-1",
    blockId: "block-1",
    payload: { type: "MARKDOWN", markdown: "older unsaved block", checked: false, metadata: null },
    expectedVersion: 7,
    revision: 3
  }), true);
  await editingStorage.flush();
  hub.deliverAll();
  await nextTask();
  await reconcilingStorage.flush();
  assert.equal(
    reconcilingDrafts.loadPage("user-1", "page-1", "tab-editing")?.blocks["block-1"]?.payload.markdown,
    "older unsaved block"
  );

  // The editing tab durably advances the same source record, but its change
  // notification remains queued so the reconciling tab still sees the old mirror.
  assert.equal(editingDrafts.saveBlock({
    userId: "user-1",
    pageId: "page-1",
    blockId: "block-1",
    payload: { type: "MARKDOWN", markdown: "newer unsaved block", checked: false, metadata: null },
    expectedVersion: 7,
    revision: 4
  }), true);
  await editingStorage.flush();
  assert.equal(
    reconcilingDrafts.loadPage("user-1", "page-1", "tab-editing")?.blocks["block-1"]?.payload.markdown,
    "older unsaved block"
  );

  // A stale acknowledgement of the matching title must not rewrite the whole
  // foreign record and thereby roll the newer block draft back to the old bytes.
  assert.equal(reconcilingDrafts.acknowledgeTitle({
    userId: "user-1",
    pageId: "page-1",
    sourceId: "tab-editing",
    revision: 2,
    nextExpectedVersion: 5
  }), true);
  await reconcilingStorage.flush();

  const reconciled = reconcilingDrafts.loadPage("user-1", "page-1", "tab-editing");
  assert.equal(reconciled?.title?.value, "server title", "failed CAS must retain the foreign title for later cleanup");
  assert.equal(reconciled?.blocks["block-1"]?.payload.markdown, "newer unsaved block");
  assert.equal(reconciled?.blocks["block-1"]?.revision, 4);

  // Retrying from the refreshed mirror should now match atomically: remove the
  // acknowledged title while preserving the newer block bytes in the same record.
  assert.equal(reconcilingDrafts.acknowledgeTitle({
    userId: "user-1",
    pageId: "page-1",
    sourceId: "tab-editing",
    revision: 2,
    nextExpectedVersion: 5
  }), true);
  await reconcilingStorage.flush();
  const cleaned = reconcilingDrafts.loadPage("user-1", "page-1", "tab-editing");
  assert.equal(cleaned?.title, null);
  assert.equal(cleaned?.blocks["block-1"]?.payload.markdown, "newer unsaved block");

  reconcilingStorage.close();
  editingStorage.close();
  const reopened = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "cross-tab-foreign-draft-cas",
    storageEventTarget: null
  });
  const durable = createPageDraftStore(reopened, { sourceId: "verifier" })
    .loadPage("user-1", "page-1", "tab-editing");
  assert.equal(durable?.title, null);
  assert.equal(durable?.blocks["block-1"]?.payload.markdown, "newer unsaved block");
  assert.equal(durable?.blocks["block-1"]?.revision, 4);
  reopened.close();
});

test("delayed cross-tab delete cannot hide a newer durable recovery write", async () => {
  const indexedDb = new FakeIndexedDb();
  const hub = new QueuedBroadcastHub();
  const options = {
    databaseName: "cross-tab-stale-delete",
    broadcastChannelFactory: hub.create,
    storageEventTarget: null
  };
  const deletingTab = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const editingTab = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const key = "brainvault.pageDraft.v2:user:page:tab";

  deletingTab.setItem(key, "old draft");
  await deletingTab.flush();
  hub.deliverAll();
  await editingTab.flush();
  assert.equal(editingTab.getItem(key), "old draft");

  // The delete commits first, but its notification is delayed.
  deletingTab.removeItem(key);
  await deletingTab.flush();

  // A newer write commits afterward, so IndexedDB contains the new draft.
  editingTab.setItem(key, "newer durable draft");
  await editingTab.flush();

  hub.deliverAll();
  await nextTask();
  await editingTab.flush();
  assert.equal(editingTab.getItem(key), "newer durable draft");

  deletingTab.close();
  editingTab.close();
});

test("atomic compare-and-remove cannot hide a newer same-tab recovery write", async () => {
  const indexedDb = new FakeIndexedDb();
  const storage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "same-tab-compare-delete-race",
    storageEventTarget: null
  });
  const key = "brainvault.pageDraft.v2:user:page:tab";

  storage.setItem(key, "uploaded-old-draft");
  await storage.flush();

  const cleanup = storage.compareAndRemove(key, (value) => value === "uploaded-old-draft");
  // Let the compare transaction consume the old durable value while its
  // completion callback is still pending, then queue a newer local draft.
  await Promise.resolve();
  await Promise.resolve();
  storage.setItem(key, "newer-local-draft");
  assert.equal(storage.getItem(key), "newer-local-draft");

  assert.equal(await cleanup, true);
  await storage.flush();
  assert.equal(storage.getItem(key), "newer-local-draft");

  storage.close();
  const reopened = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "same-tab-compare-delete-race",
    storageEventTarget: null
  });
  assert.equal(reopened.getItem(key), "newer-local-draft");
  reopened.close();
});

test("cross-tab reconciliation cannot hide a newer same-tab write while its IndexedDB read is in flight", async () => {
  const indexedDb = new FakeIndexedDb();
  const hub = new FakeBroadcastHub();
  const options = {
    databaseName: "cross-tab-overlap-delete",
    broadcastChannelFactory: hub.create,
    storageEventTarget: null
  };
  const deletingTab = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const editingTab = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const key = "brainvault.pageDraft.v2:user:page:tab";

  deletingTab.setItem(key, "old-draft");
  await deletingTab.flush();
  await nextTask();
  await editingTab.flush();
  assert.equal(editingTab.getItem(key), "old-draft");

  indexedDb.pausedReadKeys.add(key);
  deletingTab.removeItem(key);
  await deletingTab.flush();

  for (let attempt = 0; attempt < 10 && indexedDb.pendingReads.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(indexedDb.pendingReads.length, 1, "receiver should be reconciling the committed delete");

  editingTab.setItem(key, "newer-local-draft");
  assert.equal(editingTab.getItem(key), "newer-local-draft");

  indexedDb.releasePausedReads();
  await nextTask();
  await editingTab.flush();
  assert.equal(editingTab.getItem(key), "newer-local-draft");

  deletingTab.close();
  editingTab.close();
});

test("cross-tab refresh failures stay unhealthy until a full IndexedDB reload succeeds", async () => {
  const indexedDb = new FakeIndexedDb();
  const hub = new FakeBroadcastHub();
  const options = {
    databaseName: "cross-tab-refresh-failure",
    broadcastChannelFactory: hub.create,
    storageEventTarget: null
  };
  const writer = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const reader = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const key = "brainvault.pageDraft.v2:user:page:writer";

  indexedDb.failReadKeys.add(key);
  writer.setItem(key, "new durable draft");
  await writer.flush();
  await nextTask();

  assert.equal(reader.getItem(key), null, "the failed notification refresh leaves the mirror stale");
  await assert.rejects(reader.flush(), /simulated IndexedDB read failure/);

  indexedDb.failReadKeys.delete(key);
  await reader.refresh();
  assert.equal(reader.getItem(key), "new durable draft");
  await reader.flush();

  writer.close();
  reader.close();
});


test("atomic compare-and-remove preserves a newer direct draft committed by another tab", async () => {
  const indexedDb = new FakeIndexedDb();
  const options = { databaseName: "atomic-direct-cleanup", storageEventTarget: null };
  const cleanupStorage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const writerStorage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const cleanupStore = createPageDraftStore(cleanupStorage, { sourceId: "cleanup-tab" });
  const writerStore = createPageDraftStore(writerStorage, { sourceId: "writer-tab" });

  assert.equal(writerStore.saveTitle({ userId: "user", pageId: "page", value: "old", expectedVersion: 1, revision: 1 }), true);
  await writerStorage.flush();
  await cleanupStorage.refresh();
  const uploaded = cleanupStore.inspectUserDrafts("user").records.find((record) => record.sourceId === "writer-tab");
  assert.ok(uploaded);

  assert.equal(writerStore.saveTitle({ userId: "user", pageId: "page", value: "newest", expectedVersion: 1, revision: 2 }), true);
  await writerStorage.flush();
  assert.equal(cleanupStore.loadPage("user", "page", "writer-tab")?.title?.value, "old", "cleanup mirror must remain stale for the race");

  assert.equal(await cleanupStore.removePageIfUnchangedDurably(uploaded), false);
  assert.equal(cleanupStore.loadPage("user", "page", "writer-tab")?.title?.value, "newest");
  cleanupStorage.close();
  writerStorage.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const reopenedStore = createPageDraftStore(reopened, { sourceId: "reader" });
  assert.equal(reopenedStore.loadPage("user", "page", "writer-tab")?.title?.value, "newest");
  reopened.close();
});

test("atomic compare-and-remove preserves a newer collaboration generation committed by another tab", async () => {
  const indexedDb = new FakeIndexedDb();
  const options = { databaseName: "atomic-yjs-cleanup", storageEventTarget: null };
  const cleanupStorage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const writerStorage = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), options);
  const cleanupStore = createCollaborationRecoveryStore(cleanupStorage);
  const writerStore = createCollaborationRecoveryStore(writerStorage);

  const oldGeneration = await writerStore.save("acct", "page", "writer-tab", "epoch", new Uint8Array([1, 2, 3]));
  await writerStorage.flush();
  await cleanupStorage.refresh();
  const uploaded = cleanupStore.loadAll("acct", "page").find((record) => record.sourceId === "writer-tab");
  assert.equal(uploaded?.generation, oldGeneration);

  const newGeneration = await writerStore.save("acct", "page", "writer-tab", "epoch", new Uint8Array([9, 8, 7]));
  await writerStorage.flush();
  assert.notEqual(newGeneration, oldGeneration);
  assert.equal(cleanupStore.loadAll("acct", "page").find((record) => record.sourceId === "writer-tab")?.generation, oldGeneration);

  assert.equal(await cleanupStore.removeDurably("acct", "page", "writer-tab", "epoch", oldGeneration), false);
  const newest = cleanupStore.loadAll("acct", "page").find((record) => record.sourceId === "writer-tab");
  assert.equal(newest?.generation, newGeneration);
  assert.deepEqual([...newest.update], [9, 8, 7]);
  cleanupStorage.close();
  writerStorage.close();
});


test("delayed legacy deletion cannot remove a newer same-byte IndexedDB generation", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:legacy-tab";
  const originalValue = JSON.stringify({ schemaVersion: 2, marker: "A" });
  const intermediateValue = JSON.stringify({ schemaVersion: 2, marker: "B" });
  const legacy = new MemoryStorage([[key, originalValue]]);
  const events = new FakeStorageEventTarget();
  const options = {
    databaseName: "legacy-delete-aba",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: events
  };
  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, options);

  // The older tab deletes A, but delivery is delayed. Meanwhile this tab creates
  // two newer IndexedDB generations whose bytes happen to return B -> A.
  legacy.removeItem(key);
  storage.setItem(key, intermediateValue);
  await storage.flush();
  storage.setItem(key, originalValue);
  await storage.flush();
  assert.equal(storage.getItem(key), originalValue);

  events.emit({ key, oldValue: originalValue, newValue: null });
  await nextTask();
  await storage.flush();
  assert.equal(storage.getItem(key), originalValue);
  storage.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    ...options,
    storageEventTarget: null
  });
  assert.equal(reopened.getItem(key), originalValue);
  reopened.close();
});

test("delayed changed legacy write cannot overwrite a newer same-byte IndexedDB generation", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:legacy-tab";
  const originalValue = JSON.stringify({ schemaVersion: 2, marker: "A" });
  const intermediateValue = JSON.stringify({ schemaVersion: 2, marker: "B" });
  const staleLegacyValue = JSON.stringify({ schemaVersion: 2, marker: "stale-B" });
  const legacy = new MemoryStorage([[key, originalValue]]);
  const events = new FakeStorageEventTarget();
  const options = {
    databaseName: "legacy-put-aba",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: events
  };
  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, options);

  // The older tab changes A first, but its event is delayed. Newer IndexedDB
  // generations then evolve A -> B -> A before that event is delivered.
  legacy.setItem(key, staleLegacyValue);
  storage.setItem(key, intermediateValue);
  await storage.flush();
  storage.setItem(key, originalValue);
  await storage.flush();
  assert.equal(storage.getItem(key), originalValue);

  events.emit({ key, oldValue: originalValue, newValue: staleLegacyValue });
  await nextTask();
  await storage.flush();
  assert.equal(storage.getItem(key), originalValue);
  storage.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    ...options,
    storageEventTarget: null
  });
  assert.equal(reopened.getItem(key), originalValue);
  reopened.close();
});

test("initialization journal preserves the newest same-key legacy generation across both migration passes", async () => {
  const indexedDb = new FakeIndexedDb();
  const events = new FakeStorageEventTarget();
  const key = "brainvault.pageDraft.v2:user:page:tab";
  const valueA = JSON.stringify({ schemaVersion: 2, marker: "A" });
  const valueB = JSON.stringify({ schemaVersion: 2, marker: "B" });
  const valueC = JSON.stringify({ schemaVersion: 2, marker: "C" });

  class MultiWriteLegacyStorage extends MemoryStorage {
    constructor(entries) {
      super(entries);
      this.reads = 0;
    }

    getItem(storageKey) {
      const value = super.getItem(storageKey);
      if (storageKey === key) {
        this.reads += 1;
        if (this.reads === 1) {
          queueMicrotask(() => {
            const oldValue = super.getItem(key);
            super.setItem(key, valueB);
            events.emit({ key, oldValue, newValue: valueB });
          });
        } else if (this.reads === 2) {
          queueMicrotask(() => {
            const oldValue = super.getItem(key);
            super.setItem(key, valueC);
            events.emit({ key, oldValue, newValue: valueC });
          });
        }
      }
      return value;
    }
  }

  const legacy = new MultiWriteLegacyStorage([[key, valueA]]);
  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "migration-multiwrite-handoff-race",
    migrationPrefixes: ["brainvault.pageDraft.v2:"],
    storageEventTarget: events
  });

  assert.equal(legacy.getItem(key), valueC, "legacy storage reached generation C");
  assert.equal(
    storage.getItem(key),
    valueC,
    "initialization must expose the newest legacy generation instead of the intermediate pass-two generation"
  );
  await storage.flush();
  storage.close();
});
