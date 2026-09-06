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

const legacyMigrationMarkerKeyPrefix = "\u0000brainvault.recoveryLegacyMigration.v1:";
const legacyLineageMarkerKeyPrefix = "\u0000brainvault.recoveryLegacyLineage.v1:";

function getLegacyMigrationMarkerKey(key) {
  return `${legacyMigrationMarkerKeyPrefix}${key}`;
}

function getLegacyMigrationSourceKey(key) {
  if (typeof key !== "string" || !key.startsWith(legacyMigrationMarkerKeyPrefix)) return null;
  return key.slice(legacyMigrationMarkerKeyPrefix.length);
}

function getLegacyLineageMarkerKey(key) {
  return `${legacyLineageMarkerKeyPrefix}${key}`;
}

function getLegacyLineageSourceKey(key) {
  if (typeof key !== "string" || !key.startsWith(legacyLineageMarkerKeyPrefix)) return null;
  return key.slice(legacyLineageMarkerKeyPrefix.length);
}

async function fingerprintLegacyValue(value) {
  if (typeof value !== "string") return null;
  try {
    if (globalThis.crypto?.subtle && typeof TextEncoder === "function") {
      const bytes = new TextEncoder().encode(value);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return `sha256:${hex}`;
    }
  } catch {
    // Fall through to an exact marker. This path is only for runtimes that
    // expose IndexedDB but cannot provide Web Crypto hashing.
  }
  return `exact:${value}`;
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
  const legacyMigrationMarkers = new Map();
  const legacyLineageMarkers = new Map();
  const loadTransaction = db.transaction(storeName, "readonly");
  const loadComplete = transactionComplete(loadTransaction);
  const existing = await requestResult(loadTransaction.objectStore(storeName).getAll());
  await loadComplete;
  for (const record of existing ?? []) {
    if (typeof record?.key !== "string") continue;
    const markerSourceKey = getLegacyMigrationSourceKey(record.key);
    if (markerSourceKey !== null) {
      if (typeof record.value === "string") legacyMigrationMarkers.set(markerSourceKey, record.value);
      continue;
    }
    const lineageSourceKey = getLegacyLineageSourceKey(record.key);
    if (lineageSourceKey !== null) {
      if (typeof record.value === "string") legacyLineageMarkers.set(lineageSourceKey, record.value);
      continue;
    }
    records.set(record.key, cloneStoredValue(record.value));
  }

  // Migrate legacy localStorage recovery records transactionally, but keep the
  // legacy copy as a fallback. Web Storage has no cross-agent locking/CAS:
  // removing a snapshotted key after awaiting IndexedDB could delete a newer
  // write from an older tab during a rolling deployment. A durable, internal
  // fingerprint marks the exact legacy value already imported so a later
  // successful delete cannot cause that stale fallback to resurrect on restart.
  const prefixes = migrationPrefixes.filter((value) => typeof value === "string" && value.length > 0);
  const isMigratableLegacyKey = (key) => typeof key === "string" && prefixes.some((prefix) => {
    const namespace = prefix.endsWith(":") ? prefix : `${prefix}:`;
    return key === prefix || key.startsWith(namespace);
  });
  const initializationLegacyEvents = new Map();
  let captureInitializationLegacyEvent = null;
  if (legacyStorage && prefixes.length) {
    // Listen before taking the first migration snapshot. Two reconciliation passes
    // close ordinary commit races, but without this temporary journal a legacy tab
    // can create or advance recovery data after the final snapshot and before the
    // live storage listener is installed. Keep one causal predecessor per key.
    // When a migration pass imports an intermediate generation, the predecessor
    // is rebased below to that durable generation before handoff replay.
    captureInitializationLegacyEvent = (event) => {
      if (event?.storageArea != null && event.storageArea !== legacyStorage) return;
      if (!isMigratableLegacyKey(event?.key) || initializationLegacyEvents.has(event.key)) return;
      const oldValue = event?.oldValue;
      if (oldValue !== null && typeof oldValue !== "string") return;
      initializationLegacyEvents.set(event.key, { key: event.key, oldValue });
    };
    storageEventTarget?.addEventListener?.("storage", captureInitializationLegacyEvent);
    try {
      // Reconcile twice. The second pass closes the common rolling-deployment
      // race where an older tab writes a newer legacy value while the first
      // IndexedDB migration transaction is committing. The legacy copy is never
      // removed, so a still-later write remains recoverable on the next refresh.
      for (let pass = 0; pass < 2; pass += 1) {
        const snapshot = inspectStorageKeys(legacyStorage);
        if (!snapshot.reliable) throw new Error("Legacy recovery storage could not be inspected safely");

        const migration = [];
        const markerUpdates = new Map();
        const lineageUpdates = new Map();
        for (const key of snapshot.keys) {
          if (!isMigratableLegacyKey(key)) continue;
          const value = legacyStorage.getItem(key);
          if (value === null) continue;
          const legacyFingerprint = await fingerprintLegacyValue(value);
          const marker = legacyMigrationMarkers.get(key) ?? null;
          const lineage = legacyLineageMarkers.get(key) ?? null;

          if (records.has(key)) {
            const currentValue = records.get(key);
            if (typeof currentValue !== "string") continue;
            const currentFingerprint = await fingerprintLegacyValue(currentValue);

            if (
              marker !== null
              && lineage === marker
              && currentFingerprint === marker
              && legacyFingerprint !== marker
            ) {
              // Only a durable lineage receipt can prove the current IndexedDB
              // generation is still the legacy generation named by the marker.
              // Byte equality alone is not causal evidence: A -> B -> A is a
              // valid newer IndexedDB sequence and must not be rolled back.
              migration.push({ key, value, fingerprint: legacyFingerprint });
            } else if (currentFingerprint === legacyFingerprint && marker !== legacyFingerprint) {
              // Bootstrap resurrection receipts for databases migrated by an
              // older build, but deliberately do not bootstrap lineage. Older
              // versions did not record enough information to distinguish an
              // original legacy generation from a newer same-byte generation.
              markerUpdates.set(key, legacyFingerprint);
            }
            continue;
          }

          if (marker === legacyFingerprint) {
            // This exact fallback was already imported and then durably removed.
            // Do not resurrect it merely because the intentionally retained
            // localStorage copy is still present.
            continue;
          }
          migration.push({ key, value, fingerprint: legacyFingerprint });
        }

        if (migration.length) {
          const transaction = createStrictWriteTransaction(db, storeName);
          const objectStore = transaction.objectStore(storeName);
          for (const record of migration) objectStore.put({ key: record.key, value: record.value });
          await transactionComplete(transaction);

          // Verify the durable copy before exposing it through the in-memory mirror.
          await verifyMigratedRecords(
            db,
            storeName,
            migration.map(({ key, value }) => ({ key, value }))
          );
          for (const record of migration) {
            records.set(record.key, record.value);
            markerUpdates.set(record.key, record.fingerprint);
            lineageUpdates.set(record.key, record.fingerprint);
            // A captured event can predate this pass. If this pass imports an
            // intermediate legacy generation, replay must compare the newest
            // legacy bytes against that generation rather than the event's
            // original predecessor.
            const initializationEvent = initializationLegacyEvents.get(record.key);
            if (initializationEvent) initializationEvent.oldValue = record.value;
          }
        }

        if (markerUpdates.size || lineageUpdates.size) {
          const expectedMarkers = [
            ...[...markerUpdates].map(([key, fingerprint]) => ({
              key: getLegacyMigrationMarkerKey(key),
              value: fingerprint
            })),
            ...[...lineageUpdates].map(([key, fingerprint]) => ({
              key: getLegacyLineageMarkerKey(key),
              value: fingerprint
            }))
          ];
          const markerTransaction = createStrictWriteTransaction(db, storeName);
          const markerStore = markerTransaction.objectStore(storeName);
          for (const markerRecord of expectedMarkers) markerStore.put(markerRecord);
          await transactionComplete(markerTransaction);
          await verifyMigratedRecords(db, storeName, expectedMarkers);
          for (const [key, fingerprint] of markerUpdates) legacyMigrationMarkers.set(key, fingerprint);
          for (const [key, fingerprint] of lineageUpdates) legacyLineageMarkers.set(key, fingerprint);
        }
      }
    } catch (error) {
      storageEventTarget?.removeEventListener?.("storage", captureInitializationLegacyEvent);
      db.close();
      throw error;
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
      if (
        typeof record?.key !== "string"
        || getLegacyMigrationSourceKey(record.key) !== null
        || getLegacyLineageSourceKey(record.key) !== null
      ) continue;
      loadedRecords.set(record.key, cloneStoredValue(record.value));
    }
    return loadedRecords;
  }

  async function reloadAllRecords(preserveMutationsAfter = null) {
    const loadedRecords = await loadAllRecords();
    for (const key of [...records.keys()]) {
      if (
        preserveMutationsAfter === null
        || (keyMutationSequences.get(key) ?? 0) <= preserveMutationsAfter
      ) records.delete(key);
    }
    for (const [key, value] of loadedRecords) {
      if (
        preserveMutationsAfter === null
        || (keyMutationSequences.get(key) ?? 0) <= preserveMutationsAfter
      ) records.set(key, value);
    }
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

    const localSequenceAtNotification = localMutationSequence;
    const keySequenceAtNotification = message.key === null
      ? null
      : (keyMutationSequences.get(message.key) ?? 0);
    externalRefreshTail = Promise.all([
      externalRefreshTail.catch(() => undefined),
      tail.catch(() => undefined)
    ]).then(async () => {
      if (message.operation === "clear") {
        await reloadAllRecords(localSequenceAtNotification);
      } else {
        // Cross-tab notifications can be delayed behind later writes. Re-read
        // the committed record for both put and delete signals so an older
        // delete cannot hide a newer durable draft from this tab's mirror.
        const record = await loadRecord(message.key);
        if ((keyMutationSequences.get(message.key) ?? 0) === keySequenceAtNotification) {
          if (record) records.set(record.key, record.value);
          else records.delete(message.key);
        }
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
    if (event?.storageArea != null && event.storageArea !== legacyStorage) return;
    if (event?.key === changeSignalKey && typeof event.newValue === "string") {
      try {
        applyExternalChange(JSON.parse(event.newValue));
      } catch {
        // Malformed coordination signals are ignored; they never carry recovery data.
      }
      return;
    }

    // During a rolling deployment an already-open older tab can still mutate the
    // legacy localStorage recovery namespace. Reconcile from the storage area's
    // current value instead of trusting a potentially delayed event payload.
    // Source IDs are part of the recovery key, so this cannot overwrite another
    // tab's draft.
    if (!isRecoveryKey(event?.key)) return;
    const legacyKey = event.key;
    let legacyValue;
    try {
      legacyValue = legacyStorage?.getItem?.(legacyKey);
    } catch {
      // If localStorage cannot be read, fail closed and keep the durable copy.
      return;
    }

    if (typeof legacyValue === "string") {
      const previousLegacyValue = event?.oldValue;
      if (previousLegacyValue !== null && typeof previousLegacyValue !== "string") return;
      const visibleMutationSequence = markVisibleMutation(legacyKey);
      void putLegacyRecord(
        legacyKey,
        legacyValue,
        previousLegacyValue,
        visibleMutationSequence
      ).catch(() => undefined);
      return;
    }

    // A legacy tab can also acknowledge/delete a draft after this tab migrated it.
    // Require both the exact bytes and a durable legacy-lineage receipt. Byte
    // equality alone is ABA-vulnerable when a newer IndexedDB generation returns
    // to the same value before a delayed legacy delete is delivered.
    if (legacyValue !== null || typeof event?.oldValue !== "string") return;
    const removedLegacyValue = event.oldValue;
    void removeLegacyRecord(legacyKey, removedLegacyValue).catch(() => undefined);
  };

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
      const objectStore = transaction.objectStore(storeName);
      objectStore.put({ key, value: cloneStoredValue(value) });
      // A normal IndexedDB mutation starts a new generation. Keep the migration
      // receipt (it prevents stale retained localStorage from resurrecting), but
      // clear legacy lineage so equal bytes cannot impersonate the old generation.
      objectStore.delete(getLegacyLineageMarkerKey(key));
      await transactionComplete(transaction);
      legacyLineageMarkers.delete(key);
      publishChange("put", key);
    }, { operation: "put", key });
  }

  function putLegacyRecord(key, value, previousLegacyValue, visibleMutationSequence) {
    return enqueue(async () => {
      const fingerprint = await fingerprintLegacyValue(value);
      const previousFingerprint = previousLegacyValue === null
        ? null
        : await fingerprintLegacyValue(previousLegacyValue);
      const transaction = createStrictWriteTransaction(db, storeName);
      const complete = transactionComplete(transaction);
      const objectStore = transaction.objectStore(storeName);
      const markerKey = getLegacyMigrationMarkerKey(key);
      const lineageKey = getLegacyLineageMarkerKey(key);
      let matched = false;
      let currentExists = false;
      let currentValue = null;
      let durableMarker = null;
      let durableLineage = null;

      // The record and both receipts are read and conditionally updated in one
      // transaction. A value comparison by itself is ABA-vulnerable: a newer
      // IndexedDB generation can legitimately evolve A -> B -> A while a legacy
      // event for the original A is delayed.
      const comparison = new Promise((resolve, reject) => {
        const currentRequest = objectStore.get(key);
        currentRequest.onerror = () => reject(
          currentRequest.error ?? new Error("IndexedDB legacy recovery compare-read failed")
        );
        currentRequest.onsuccess = () => {
          const current = currentRequest.result;
          if (current && current.key === key) {
            currentExists = true;
            currentValue = cloneStoredValue(current.value);
          }

          let remaining = 2;
          const finishComparison = () => {
            remaining -= 1;
            if (remaining > 0) return;

            // If these bytes have already been imported, this is a duplicate
            // retained-fallback event, not a new generation.
            if (durableMarker === fingerprint) {
              resolve();
              return;
            }

            const predecessorMatches = previousLegacyValue === null
              ? !currentExists
              : (
                currentExists
                  ? (
                    typeof currentValue === "string"
                    && currentValue === previousLegacyValue
                    && durableLineage === previousFingerprint
                  )
                  : durableMarker === previousFingerprint
              );

            if (predecessorMatches) {
              objectStore.put({ key, value: cloneStoredValue(value) });
              objectStore.put({ key: markerKey, value: fingerprint });
              objectStore.put({ key: lineageKey, value: fingerprint });
              matched = true;
            }
            resolve();
          };

          const markerRequest = objectStore.get(markerKey);
          markerRequest.onerror = () => reject(
            markerRequest.error ?? new Error("IndexedDB legacy migration receipt read failed")
          );
          markerRequest.onsuccess = () => {
            const markerRecord = markerRequest.result;
            durableMarker = markerRecord
              && markerRecord.key === markerKey
              && typeof markerRecord.value === "string"
              ? markerRecord.value
              : null;
            finishComparison();
          };

          const lineageRequest = objectStore.get(lineageKey);
          lineageRequest.onerror = () => reject(
            lineageRequest.error ?? new Error("IndexedDB legacy lineage receipt read failed")
          );
          lineageRequest.onsuccess = () => {
            const lineageRecord = lineageRequest.result;
            durableLineage = lineageRecord
              && lineageRecord.key === lineageKey
              && typeof lineageRecord.value === "string"
              ? lineageRecord.value
              : null;
            finishComparison();
          };
        };
      });
      await Promise.all([comparison, complete]);

      const mirrorStillMatchesRequest = (keyMutationSequences.get(key) ?? 0) === visibleMutationSequence;
      if (!matched) {
        if (durableMarker === null) legacyMigrationMarkers.delete(key);
        else legacyMigrationMarkers.set(key, durableMarker);
        if (durableLineage === null) legacyLineageMarkers.delete(key);
        else legacyLineageMarkers.set(key, durableLineage);

        // Converge the synchronous mirror on the durable value that defeated the
        // stale legacy write, unless a newer same-tab mutation has superseded it.
        if (mirrorStillMatchesRequest) {
          if (currentExists) records.set(key, cloneStoredValue(currentValue));
          else records.delete(key);
        }
        return false;
      }

      legacyMigrationMarkers.set(key, fingerprint);
      legacyLineageMarkers.set(key, fingerprint);
      // A newer same-tab mutation can be queued while fingerprinting/committing
      // the legacy write. Do not let this older reconciliation roll its mirror
      // back; the newer mutation is serialized after this durable transaction.
      if (mirrorStillMatchesRequest) records.set(key, cloneStoredValue(value));
      publishChange("put", key);
      return true;
    }, { operation: "legacy-put", key });
  }

  function removeLegacyRecord(key, removedLegacyValue) {
    const visibleMutationSequence = keyMutationSequences.get(key) ?? 0;
    return enqueue(async () => {
      const removedFingerprint = await fingerprintLegacyValue(removedLegacyValue);
      const transaction = createStrictWriteTransaction(db, storeName);
      const complete = transactionComplete(transaction);
      const objectStore = transaction.objectStore(storeName);
      const lineageKey = getLegacyLineageMarkerKey(key);
      let matched = false;
      let currentExists = false;
      let currentValue = null;
      let durableLineage = null;

      const comparison = new Promise((resolve, reject) => {
        const currentRequest = objectStore.get(key);
        currentRequest.onerror = () => reject(
          currentRequest.error ?? new Error("IndexedDB legacy recovery delete compare-read failed")
        );
        currentRequest.onsuccess = () => {
          const current = currentRequest.result;
          if (current && current.key === key) {
            currentExists = true;
            currentValue = cloneStoredValue(current.value);
          }

          const lineageRequest = objectStore.get(lineageKey);
          lineageRequest.onerror = () => reject(
            lineageRequest.error ?? new Error("IndexedDB legacy lineage receipt read failed")
          );
          lineageRequest.onsuccess = () => {
            const lineageRecord = lineageRequest.result;
            durableLineage = lineageRecord
              && lineageRecord.key === lineageKey
              && typeof lineageRecord.value === "string"
              ? lineageRecord.value
              : null;

            if (
              currentExists
              && typeof currentValue === "string"
              && currentValue === removedLegacyValue
              && durableLineage === removedFingerprint
            ) {
              objectStore.delete(key);
              objectStore.delete(lineageKey);
              matched = true;
            }
            resolve();
          };
        };
      });
      await Promise.all([comparison, complete]);

      const mirrorStillMatchesRequest = (keyMutationSequences.get(key) ?? 0) === visibleMutationSequence;
      if (matched) {
        legacyLineageMarkers.delete(key);
        if (mirrorStillMatchesRequest) records.delete(key);
        publishChange("delete", key);
        return true;
      }

      if (durableLineage === null) legacyLineageMarkers.delete(key);
      else legacyLineageMarkers.set(key, durableLineage);
      if (mirrorStillMatchesRequest) {
        if (currentExists) records.set(key, cloneStoredValue(currentValue));
        else records.delete(key);
      }
      return false;
    }, { operation: "legacy-delete", key });
  }

  function deleteRecord(key, { onCommitted = null, onFailure = null } = {}) {
    return enqueue(async () => {
      try {
        const transaction = createStrictWriteTransaction(db, storeName);
        const objectStore = transaction.objectStore(storeName);
        objectStore.delete(key);
        objectStore.delete(getLegacyLineageMarkerKey(key));
        await transactionComplete(transaction);
        legacyLineageMarkers.delete(key);
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
    compareAndSet(key, matches, value) {
      if (typeof matches !== "function") {
        return Promise.reject(new TypeError("A recovery comparison function is required"));
      }
      const normalizedKey = String(key);
      const nextValue = cloneStoredValue(value);
      const visibleMutationSequence = keyMutationSequences.get(normalizedKey) ?? 0;
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
              if (matched) {
                objectStore.put({ key: normalizedKey, value: cloneStoredValue(nextValue) });
                objectStore.delete(getLegacyLineageMarkerKey(normalizedKey));
              }
            }
            resolve();
          };
        });

        await Promise.all([comparison, complete]);
        const mirrorStillMatchesRequest = (keyMutationSequences.get(normalizedKey) ?? 0)
          === visibleMutationSequence;
        if (matched) {
          legacyLineageMarkers.delete(normalizedKey);
          if (mirrorStillMatchesRequest) records.set(normalizedKey, cloneStoredValue(nextValue));
          publishChange("put", normalizedKey);
        } else if (mirrorStillMatchesRequest && currentExists) {
          // A stale mirror must converge on the durable record that caused the
          // compare to fail instead of retaining data the caller can mutate again.
          records.set(normalizedKey, currentValue);
        } else if (mirrorStillMatchesRequest) {
          records.delete(normalizedKey);
        }
        return matched;
      }, { operation: "compare-put", key: normalizedKey });
    },
    compareAndRemove(key, matches) {
      if (typeof matches !== "function") {
        return Promise.reject(new TypeError("A recovery comparison function is required"));
      }
      const normalizedKey = String(key);
      const visibleMutationSequence = keyMutationSequences.get(normalizedKey) ?? 0;
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
              if (matched) {
                objectStore.delete(normalizedKey);
                objectStore.delete(getLegacyLineageMarkerKey(normalizedKey));
              }
            }
            resolve();
          };
        });

        await Promise.all([comparison, complete]);
        const mirrorStillMatchesRequest = (keyMutationSequences.get(normalizedKey) ?? 0)
          === visibleMutationSequence;
        if (matched) {
          legacyLineageMarkers.delete(normalizedKey);
          if (mirrorStillMatchesRequest) records.delete(normalizedKey);
          publishChange("delete", normalizedKey);
        } else if (mirrorStillMatchesRequest && currentExists) {
          // A different tab may have committed a newer recovery value while this
          // tab's synchronous mirror was stale. Refresh the mirror from the exact
          // record observed by the atomic compare transaction.
          records.set(normalizedKey, currentValue);
        } else if (mirrorStillMatchesRequest) {
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
          const objectStore = transaction.objectStore(storeName);
          objectStore.clear();
          // Keep only internal migration receipts. The corresponding legacy
          // fallback values remain in localStorage by design, and these receipts
          // prevent clear() from making those stale values visible again later.
          for (const [key, fingerprint] of legacyMigrationMarkers) {
            objectStore.put({ key: getLegacyMigrationMarkerKey(key), value: fingerprint });
          }
          await transactionComplete(transaction);

          // clear() removes every lineage sidecar atomically with the records.
          // Migration receipts are intentionally retained above so stale legacy
          // fallbacks cannot reappear after acknowledgement.
          legacyLineageMarkers.clear();

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
      // A recovery write or cross-tab refresh can be queued while this barrier
      // is awaiting an earlier generation. Keep draining until both promise
      // chains remain unchanged across the await; otherwise flush() can resolve
      // while a newer strict IndexedDB transaction is still pending.
      while (true) {
        const pendingTail = tail;
        const pendingExternalRefreshTail = externalRefreshTail;
        await pendingTail;
        await pendingExternalRefreshTail;
        if (pendingTail === tail && pendingExternalRefreshTail === externalRefreshTail) break;
      }
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
      const localSequenceAtRefresh = localMutationSequence;
      await tail.catch(() => undefined);
      await externalRefreshTail;
      await reloadAllRecords(localSequenceAtRefresh);
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

  // Install the live listener before removing the temporary migration journal
  // so there is no unobserved handoff interval. Replaying each key's first event
  // through onStorageEvent re-reads the latest legacy bytes and uses the existing
  // lineage receipts/CAS fencing, so it cannot overwrite a newer IndexedDB write.
  storageEventTarget?.addEventListener?.("storage", onStorageEvent);
  if (captureInitializationLegacyEvent) {
    storageEventTarget?.removeEventListener?.("storage", captureInitializationLegacyEvent);
    for (const event of initializationLegacyEvents.values()) onStorageEvent(event);
    try {
      await api.flush();
    } catch (error) {
      api.close();
      throw error;
    }
  }
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
