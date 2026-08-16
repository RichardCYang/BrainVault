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

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : value;
}

class FakeIndexedDb {
  constructor({ ignoreDurability = false, corruptReadbackKeys = [], failDeleteKeys = [] } = {}) {
    this.databases = new Map();
    this.ignoreDurability = ignoreDurability;
    this.corruptReadbackKeys = new Set(corruptReadbackKeys);
    this.failDeleteKeys = new Set(failDeleteKeys);
    this.transactions = [];
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
              queueMicrotask(() => {
                child.result = store.has(key)
                  ? {
                      key,
                      value: this.corruptReadbackKeys.has(key) ? "__corrupted__" : clone(store.get(key))
                    }
                  : undefined;
                child.onsuccess?.();
              });
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
            clear() { store.clear(); }
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
  assert.equal(writeErrors.at(-1)?.context?.operation, "delete");
  storage.close();

  indexedDb.failDeleteKeys.delete(key);
  const reopened = await createIndexedDbRecoveryStorage(indexedDb, new MemoryStorage(), {
    databaseName: "delete-failure-test"
  });
  assert.equal(reopened.getItem(key), "durable-draft");
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

test("migrates legacy recovery only after IndexedDB commit and removes the duplicate", async () => {
  const indexedDb = new FakeIndexedDb();
  const key = "brainvault.pageDraft.v2:user:page:tab";
  const legacy = new MemoryStorage([[key, JSON.stringify({ schemaVersion: 2, marker: "legacy" })]]);
  const storage = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "migration-test",
    migrationPrefixes: ["brainvault.pageDraft.v2:"]
  });

  assert.equal(legacy.getItem(key), null);
  assert.match(storage.getItem(key), /"marker":"legacy"/);
  await storage.flush();
  storage.close();

  const reopened = await createIndexedDbRecoveryStorage(indexedDb, legacy, {
    databaseName: "migration-test",
    migrationPrefixes: ["brainvault.pageDraft.v2:"]
  });
  assert.match(reopened.getItem(key), /"marker":"legacy"/);
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
