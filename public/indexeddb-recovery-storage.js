import { inspectStorageKeys } from "./storage-snapshot.js";

const defaultDatabaseName = "brainvault-recovery";
const defaultStoreName = "recovery-records";
const databaseVersion = 1;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function createStrictWriteTransaction(db, storeName) {
  let transaction;
  try {
    transaction = db.transaction(storeName, "readwrite", { durability: "strict" });
  } catch (cause) {
    const error = new Error("Strict IndexedDB recovery durability is unavailable", { cause });
    error.code = "RECOVERY_STRICT_DURABILITY_UNAVAILABLE";
    throw error;
  }

  // Recovery records are the last-resort copy of unsynchronized note data.
  // Fail closed when the browser ignores or cannot expose the requested strict
  // durability hint instead of silently treating default durability as equivalent.
  if (transaction?.durability !== "strict") {
    try {
      transaction?.abort?.();
    } catch {
      // Best effort only. Initialization/write failure below remains authoritative.
    }
    const error = new Error("Strict IndexedDB recovery durability could not be confirmed");
    error.code = "RECOVERY_STRICT_DURABILITY_UNAVAILABLE";
    throw error;
  }

  return transaction;
}

async function verifyMigratedRecords(db, storeName, expectedRecords) {
  const transaction = db.transaction(storeName, "readonly");
  const complete = transactionComplete(transaction);
  const objectStore = transaction.objectStore(storeName);

  await Promise.all(expectedRecords.map(async (expected) => {
    const actual = await requestResult(objectStore.get(expected.key));
    if (!actual || actual.key !== expected.key || actual.value !== expected.value) {
      throw new Error(`IndexedDB recovery migration verification failed for ${expected.key}`);
    }
  }));
  await complete;
}

function openDatabase(indexedDb, databaseName, storeName) {
  if (!indexedDb?.open) throw new Error("IndexedDB is unavailable");
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB recovery database could not be opened"));
    request.onblocked = () => reject(new Error("IndexedDB recovery database upgrade was blocked"));
  });
}

function cloneStoredValue(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (typeof structuredClone === "function") return structuredClone(value);
  return value;
}

/**
 * Creates a synchronous in-memory Storage-compatible view backed by IndexedDB.
 * Every mutation is serialized to IndexedDB and can be awaited with flush().
 * The synchronous view lets the existing recovery scanners remain deterministic;
 * callers that must not expose a mutation before the browser's strongest
 * requested persistence barrier completes must await flush().
 */
export async function createIndexedDbRecoveryStorage(
  indexedDb,
  legacyStorage,
  {
    databaseName = defaultDatabaseName,
    storeName = defaultStoreName,
    migrationPrefixes = [],
    broadcastChannelFactory = null,
    storageEventTarget = globalThis.window ?? null
  } = {}
) {
  const db = await openDatabase(indexedDb, databaseName, storeName);

  // Probe the browser capability before exposing writable recovery storage.
  // This no-op transaction intentionally fails initialization on engines that
  // cannot confirm the strict durability hint.
  try {
    const durabilityProbe = createStrictWriteTransaction(db, storeName);
    await transactionComplete(durabilityProbe);
  } catch (error) {
    db.close();
    throw error;
  }

  const records = new Map();
  const loadTransaction = db.transaction(storeName, "readonly");
  const loadComplete = transactionComplete(loadTransaction);
  const existing = await requestResult(loadTransaction.objectStore(storeName).getAll());
  await loadComplete;
  for (const record of existing ?? []) {
    if (typeof record?.key !== "string") continue;
    records.set(record.key, cloneStoredValue(record.value));
  }

  // Migrate legacy localStorage recovery records transactionally. The legacy
  // copy is removed only after the IndexedDB transaction commits successfully.
  const prefixes = migrationPrefixes.filter((value) => typeof value === "string" && value.length > 0);
  if (legacyStorage && prefixes.length) {
    const snapshot = inspectStorageKeys(legacyStorage);
    if (!snapshot.reliable) {
      db.close();
      throw new Error("Legacy recovery storage could not be inspected safely");
    }
    const migration = [];
    for (const key of snapshot.keys) {
      if (!prefixes.some((prefix) => {
        const namespace = prefix.endsWith(":") ? prefix : `${prefix}:`;
        return key === prefix || key.startsWith(namespace);
      })) continue;
      if (records.has(key)) continue;
      const value = legacyStorage.getItem(key);
      if (value === null) continue;
      migration.push({ key, value });
    }
    if (migration.length) {
      try {
        const transaction = createStrictWriteTransaction(db, storeName);
        const objectStore = transaction.objectStore(storeName);
        for (const record of migration) objectStore.put(record);
        await transactionComplete(transaction);

        // Destructive legacy cleanup is allowed only after a fresh committed read
        // confirms the replacement copy. If verification fails, localStorage is
        // intentionally left untouched so recovery retains at least one copy.
        await verifyMigratedRecords(db, storeName, migration);
        for (const record of migration) records.set(record.key, record.value);
        for (const record of migration) {
          try {
            legacyStorage.removeItem(record.key);
          } catch {
            // A duplicate legacy copy is safe. Never treat cleanup failure as a
            // reason to delete the newly durable IndexedDB record.
          }
        }
      } catch (error) {
        db.close();
        throw error;
      }
    }
  }

  let tail = Promise.resolve();
  let externalRefreshTail = Promise.resolve();
  let externalRefreshFailure = null;
  let pendingWrites = 0;
  const pendingDeleteTokens = new Map();
  let localMutationSequence = 0;
  const keyMutationSequences = new Map();
  let failureSequence = 0;
  let observedFailureSequence = 0;
  let lastFailure = null;
  let changeSequence = 0;
  const writeErrorListeners = new Set();
  const changeListeners = new Set();
  const instanceId = globalThis.crypto?.randomUUID?.()
    ?? `recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const changeSignalKey = `brainvault.recoveryChange.v1:${databaseName}:${storeName}`;
  const channelFactory = typeof broadcastChannelFactory === "function"
    ? broadcastChannelFactory
    : (typeof globalThis.window?.BroadcastChannel === "function"
      ? (name) => new globalThis.window.BroadcastChannel(name)
      : null);
  const changeChannel = channelFactory?.(`${changeSignalKey}:broadcast`) ?? null;

  function markVisibleMutation(key) {
    const sequence = ++localMutationSequence;
    keyMutationSequences.set(key, sequence);
    return sequence;
  }

  function notifyChange(change) {
    for (const listener of [...changeListeners]) {
      try {
        listener(change);
      } catch (listenerError) {
        console.error("Recovery storage change listener failed", listenerError);
      }
    }
  }

  function isRecoveryKey(key) {
    return typeof key === "string" && prefixes.some((prefix) => {
      const namespace = prefix.endsWith(":") ? prefix : `${prefix}:`;
      return key === prefix || key.startsWith(namespace);
    });
  }

  async function loadRecord(key) {
    const transaction = db.transaction(storeName, "readonly");
    const complete = transactionComplete(transaction);
    const value = await requestResult(transaction.objectStore(storeName).get(key));
    await complete;
    if (!value || typeof value.key !== "string") return null;
    return { key: value.key, value: cloneStoredValue(value.value) };
  }

  async function loadAllRecords() {
    const transaction = db.transaction(storeName, "readonly");
    const complete = transactionComplete(transaction);
    const values = await requestResult(transaction.objectStore(storeName).getAll());
    await complete;
    const loadedRecords = new Map();
    for (const record of values ?? []) {
      if (typeof record?.key !== "string") continue;
      loadedRecords.set(record.key, cloneStoredValue(record.value));
    }
    return loadedRecords;
  }

  async function reloadAllRecords() {
    const loadedRecords = await loadAllRecords();
    records.clear();
    for (const [key, value] of loadedRecords) records.set(key, value);
  }

  function publishChange(operation, key) {
    const message = {
      sourceId: instanceId,
      sequence: ++changeSequence,
      operation,
      key: key ?? null
    };
    try {
      changeChannel?.postMessage(message);
    } catch {
      // The localStorage signal below remains a second, small notification path.
    }
    try {
      legacyStorage?.setItem?.(changeSignalKey, JSON.stringify(message));
    } catch {
      // Recovery data itself no longer depends on localStorage capacity.
    }
  }

  function applyExternalChange(message) {
    if (!message || message.sourceId === instanceId) return;
    if (!["put", "delete", "clear"].includes(message.operation)) return;
    if (message.key !== null && typeof message.key !== "string") return;

    externalRefreshTail = Promise.all([
      externalRefreshTail.catch(() => undefined),
      tail.catch(() => undefined)
    ]).then(async () => {
      if (message.operation === "clear") {
        await reloadAllRecords();
      } else {
        // Cross-tab notifications can be delayed behind later writes. Re-read
        // the committed record for both put and delete signals so an older
        // delete cannot hide a newer durable draft from this tab's mirror.
        const record = await loadRecord(message.key);
        if (record) records.set(record.key, record.value);
        else records.delete(message.key);
      }
      notifyChange({
        operation: message.operation,
        key: message.key,
        external: true
      });
    }).catch((error) => {
      externalRefreshFailure = error instanceof Error ? error : new Error(String(error));
      console.error("Failed to refresh cross-tab recovery storage state", error);
    });
  }

  const onChannelMessage = (event) => applyExternalChange(event?.data);
  if (changeChannel) {
    if (typeof changeChannel.addEventListener === "function") {
      changeChannel.addEventListener("message", onChannelMessage);
    } else {
      changeChannel.onmessage = onChannelMessage;
    }
  }

  const onStorageEvent = (event) => {
    if (event?.key === changeSignalKey && typeof event.newValue === "string") {
      try {
        applyExternalChange(JSON.parse(event.newValue));
      } catch {
        // Malformed coordination signals are ignored; they never carry recovery data.
      }
      return;
    }

    // During a rolling deployment an already-open older tab can still write the
    // legacy localStorage recovery namespace. Import that committed value into
    // IndexedDB rather than making a newly loaded tab blind to it. Source IDs are
    // part of the recovery key, so this cannot overwrite another tab's draft.
    if (typeof event?.newValue !== "string" || !isRecoveryKey(event.key)) return;
    const legacyKey = event.key;
    const legacyValue = event.newValue;
    markVisibleMutation(legacyKey);
    records.set(legacyKey, legacyValue);
    void putRecord(legacyKey, legacyValue).catch(() => undefined);
  };
  storageEventTarget?.addEventListener?.("storage", onStorageEvent);

  function notifyWriteError(error, context) {
    for (const listener of [...writeErrorListeners]) {
      try {
        listener(error, context);
      } catch (listenerError) {
        console.error("Recovery storage write-error listener failed", listenerError);
      }
    }
  }

  function enqueue(operation, context, { reportFailure = true } = {}) {
    pendingWrites += 1;
    const run = tail.then(operation, operation);
    tail = run.then(
      () => {
        pendingWrites -= 1;
      },
      (error) => {
        pendingWrites -= 1;
        failureSequence += 1;
        lastFailure = error instanceof Error ? error : new Error(String(error));
        if (reportFailure) notifyWriteError(lastFailure, context);
      }
    );
    return run;
  }

  function putRecord(key, value) {
    return enqueue(async () => {
      const transaction = createStrictWriteTransaction(db, storeName);
      transaction.objectStore(storeName).put({ key, value: cloneStoredValue(value) });
      await transactionComplete(transaction);
      publishChange("put", key);
    }, { operation: "put", key });
  }

  function deleteRecord(key, { onCommitted = null, onFailure = null } = {}) {
    return enqueue(async () => {
      try {
        const transaction = createStrictWriteTransaction(db, storeName);
        transaction.objectStore(storeName).delete(key);
        await transactionComplete(transaction);
        onCommitted?.();
        publishChange("delete", key);
      } catch (error) {
        await onFailure?.();
        throw error;
      }
    }, { operation: "delete", key });
  }

  const api = {
    get length() {
      return records.size;
    },
    key(index) {
      if (!Number.isInteger(index) || index < 0) return null;
      return [...records.keys()][index] ?? null;
    },
    getItem(key) {
      const value = records.get(String(key));
      return typeof value === "string" ? value : null;
    },
    getObject(key) {
      const value = records.get(String(key));
      return value === undefined ? null : cloneStoredValue(value);
    },
    setItem(key, value) {
      const normalizedKey = String(key);
      const normalizedValue = String(value);
      // A newer local write supersedes any earlier delete whose durable
      // transaction is still settling. Its failure must not resurrect the
      // value that this write intentionally replaced.
      markVisibleMutation(normalizedKey);
      pendingDeleteTokens.delete(normalizedKey);
      records.set(normalizedKey, normalizedValue);
      void putRecord(normalizedKey, normalizedValue).catch(() => undefined);
    },
    setObject(key, value) {
      const normalizedKey = String(key);
      const cloned = cloneStoredValue(value);
      markVisibleMutation(normalizedKey);
      pendingDeleteTokens.delete(normalizedKey);
      records.set(normalizedKey, cloned);
      void putRecord(normalizedKey, cloned).catch(() => undefined);
    },
    removeItem(key) {
      const normalizedKey = String(key);
      markVisibleMutation(normalizedKey);
      const hadPreviousValue = records.has(normalizedKey);
      const previousValue = hadPreviousValue
        ? cloneStoredValue(records.get(normalizedKey))
        : undefined;
      const deleteToken = {};
      pendingDeleteTokens.set(normalizedKey, deleteToken);
      records.delete(normalizedKey);
      void deleteRecord(normalizedKey, {
        onCommitted: () => {
          if (pendingDeleteTokens.get(normalizedKey) === deleteToken) {
            pendingDeleteTokens.delete(normalizedKey);
          }
        },
        onFailure: async () => {
          if (pendingDeleteTokens.get(normalizedKey) !== deleteToken) return;
          let durableRecord;
          try {
            durableRecord = await loadRecord(normalizedKey);
          } catch {
            // If even the verification read fails, keep the last known copy
            // visible in memory rather than hiding potentially recoverable data.
            if (hadPreviousValue) records.set(normalizedKey, cloneStoredValue(previousValue));
            pendingDeleteTokens.delete(normalizedKey);
            return;
          }
          if (pendingDeleteTokens.get(normalizedKey) !== deleteToken) return;
          pendingDeleteTokens.delete(normalizedKey);
          if (durableRecord) records.set(durableRecord.key, durableRecord.value);
          else records.delete(normalizedKey);
        }
      }).catch(() => undefined);
    },
    compareAndRemove(key, matches) {
      if (typeof matches !== "function") {
        return Promise.reject(new TypeError("A recovery comparison function is required"));
      }
      const normalizedKey = String(key);
      return enqueue(async () => {
        const transaction = createStrictWriteTransaction(db, storeName);
        const complete = transactionComplete(transaction);
        const objectStore = transaction.objectStore(storeName);
        let matched = false;
        let currentExists = false;
        let currentValue = null;

        const comparison = new Promise((resolve, reject) => {
          const request = objectStore.get(normalizedKey);
          request.onerror = () => reject(request.error ?? new Error("IndexedDB recovery compare-read failed"));
          request.onsuccess = () => {
            const current = request.result;
            if (current && current.key === normalizedKey) {
              currentExists = true;
              currentValue = cloneStoredValue(current.value);
              try {
                matched = matches(cloneStoredValue(current.value)) === true;
              } catch (error) {
                try { transaction.abort(); } catch { /* best effort */ }
                reject(error);
                return;
              }
              if (matched) objectStore.delete(normalizedKey);
            }
            resolve();
          };
        });

        await Promise.all([comparison, complete]);
        if (matched) {
          records.delete(normalizedKey);
          publishChange("delete", normalizedKey);
        } else if (currentExists) {
          // A different tab may have committed a newer recovery value while this
          // tab's synchronous mirror was stale. Refresh the mirror from the exact
          // record observed by the atomic compare transaction.
          records.set(normalizedKey, currentValue);
        } else {
          records.delete(normalizedKey);
        }
        return matched;
      }, { operation: "compare-delete", key: normalizedKey });
    },
    clear() {
      const clearSequence = ++localMutationSequence;
      const previousRecords = new Map(
        [...records].map(([key, value]) => [key, cloneStoredValue(value)])
      );

      // A clear supersedes older per-key removals. If one of those removals
      // later aborts, it must not resurrect data after a successful clear.
      pendingDeleteTokens.clear();
      records.clear();
      void enqueue(async () => {
        try {
          const transaction = createStrictWriteTransaction(db, storeName);
          transaction.objectStore(storeName).clear();
          await transactionComplete(transaction);

          // An older queued operation may have repopulated the mirror while the
          // clear transaction was settling. Remove only values that were not
          // intentionally written again after clear() was called.
          for (const key of [...records.keys()]) {
            if ((keyMutationSequences.get(key) ?? 0) <= clearSequence) records.delete(key);
          }
          publishChange("clear", null);
        } catch (error) {
          let durableRecords = null;
          try {
            durableRecords = await loadAllRecords();
          } catch {
            // Keep the last known in-memory copies if verification is also
            // unavailable. A later successful refresh can reconcile them.
          }

          const recoveryRecords = durableRecords ?? previousRecords;
          if (durableRecords) {
            for (const key of [...records.keys()]) {
              if ((keyMutationSequences.get(key) ?? 0) <= clearSequence && !durableRecords.has(key)) {
                records.delete(key);
              }
            }
          }
          for (const [key, value] of recoveryRecords) {
            // Preserve any newer local write/removal made after clear(). The
            // queued operation for that mutation will run after this one.
            if ((keyMutationSequences.get(key) ?? 0) <= clearSequence) {
              records.set(key, cloneStoredValue(value));
            }
          }
          throw error;
        }
      }, { operation: "clear", key: null }).catch(() => undefined);
    },
    hasPendingWrites() {
      return pendingWrites > 0;
    },
    async flush() {
      await tail;
      await externalRefreshTail;
      if (failureSequence > observedFailureSequence) {
        observedFailureSequence = failureSequence;
        throw lastFailure ?? new Error("Recovery storage write failed");
      }
      if (externalRefreshFailure) throw externalRefreshFailure;
    },
    onWriteError(listener) {
      if (typeof listener !== "function") return () => {};
      writeErrorListeners.add(listener);
      return () => writeErrorListeners.delete(listener);
    },
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    async refresh() {
      await tail.catch(() => undefined);
      await externalRefreshTail;
      await reloadAllRecords();
      // Cross-tab refresh failures are sticky so synchronous inspections never
      // mistake a stale mirror for an authoritative empty store. Only a full
      // successful backing-store reload restores a healthy inspection state.
      externalRefreshFailure = null;
    },
    close() {
      storageEventTarget?.removeEventListener?.("storage", onStorageEvent);
      if (changeChannel) {
        if (typeof changeChannel.removeEventListener === "function") {
          changeChannel.removeEventListener("message", onChannelMessage);
        } else if (changeChannel.onmessage === onChannelMessage) {
          changeChannel.onmessage = null;
        }
        changeChannel.close?.();
      }
      db.close();
    }
  };

  return api;
}

export function createReadOnlyRecoveryStorage(storage) {
  return {
    get length() {
      return Number(storage?.length ?? 0);
    },
    key(index) {
      try {
        return storage?.key(index) ?? null;
      } catch {
        return null;
      }
    },
    getItem(key) {
      try {
        return storage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    getObject() {
      return null;
    },
    setItem() {
      throw new Error("Durable recovery storage is unavailable");
    },
    setObject() {
      throw new Error("Durable recovery storage is unavailable");
    },
    removeItem() {
      throw new Error("Durable recovery storage is unavailable");
    },
    clear() {
      throw new Error("Durable recovery storage is unavailable");
    },
    hasPendingWrites() {
      return false;
    },
    async flush() {
      throw new Error("Durable recovery storage is unavailable");
    },
    onWriteError() {
      return () => {};
    },
    subscribe() {
      return () => {};
    },
    async refresh() {
      throw new Error("Durable recovery storage is unavailable");
    },
    close() {}
  };
}
