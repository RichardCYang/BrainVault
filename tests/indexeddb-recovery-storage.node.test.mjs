import assert from "node:assert/strict";
import test from "node:test";
import { createIndexedDbRecoveryStorage } from "../public/indexeddb-recovery-storage.js";

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
  constructor() { this.databases = new Map(); }
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
        transaction: (storeName) => {
          const transaction = { error: null, oncomplete: null, onabort: null, onerror: null };
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
            get(key) {
              const child = { result: null, error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                child.result = store.has(key) ? { key, value: clone(store.get(key)) } : undefined;
                child.onsuccess?.();
              });
              return child;
            },
            put(record) { store.set(record.key, clone(record.value)); },
            delete(key) { store.delete(key); },
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
