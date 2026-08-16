import { inspectStorageKeys } from "./storage-snapshot.js";

const recoverySchemaVersion = 3;
const base64RecoverySchemaVersion = 2;
const legacyRecoverySchemaVersion = 1;
let generationSequence = 0;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return null;
}

function createGeneration() {
  generationSequence = (generationSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now()}-${generationSequence}-${Math.random().toString(36).slice(2)}`;
}

export function createCollaborationRecoveryStore(
  storage,
  { prefix = "brainvault.collaborationRecovery.v1" } = {}
) {
  const storagePrefix = `${prefix}:`;
  const getPagePrefix = (accountId, pageId) =>
    `${prefix}:${encodeURIComponent(accountId)}:${encodeURIComponent(pageId)}:`;
  const getKey = (accountId, pageId, documentEpoch, sourceId) =>
    `${getPagePrefix(accountId, pageId)}${encodeURIComponent(documentEpoch)}:${encodeURIComponent(sourceId)}`;

  function snapshotStorageKeys() {
    return inspectStorageKeys(storage);
  }

  function parseStorageKey(key) {
    if (!key.startsWith(storagePrefix)) return null;
    const parts = key.slice(storagePrefix.length).split(":");
    if (parts.length !== 3 && parts.length !== 4) return null;
    try {
      const accountId = decodeURIComponent(parts[0]);
      const pageId = decodeURIComponent(parts[1]);
      const documentEpoch = parts.length === 4 ? decodeURIComponent(parts[2]) : null;
      const sourceId = decodeURIComponent(parts.at(-1));
      if (
        !isNonEmptyString(accountId)
        || !isNonEmptyString(pageId)
        || !isNonEmptyString(sourceId)
        || (parts.length === 4 && !isNonEmptyString(documentEpoch))
      ) return null;
      return { accountId, pageId, documentEpoch, sourceId, legacyKey: parts.length === 3 };
    } catch {
      return null;
    }
  }

  function readRawRecord(key) {
    const objectValue = storage?.getObject?.(key);
    if (objectValue !== null && objectValue !== undefined) {
      return typeof objectValue === "string" ? JSON.parse(objectValue) : objectValue;
    }
    const raw = storage?.getItem?.(key);
    if (raw === null || raw === undefined) return null;
    return JSON.parse(raw);
  }

  function inspectRecord(key, accountId, pageId) {
    if (!storage) return { record: null, unreadable: true };
    try {
      const record = readRawRecord(key);
      if (record === null) return { record: null, unreadable: false };
      const parsedKey = parseStorageKey(key);
      const isLegacy = record?.schemaVersion === legacyRecoverySchemaVersion;
      const isBase64 = record?.schemaVersion === base64RecoverySchemaVersion;
      const isBinary = record?.schemaVersion === recoverySchemaVersion;
      const isCurrent = isBase64 || isBinary;
      const binaryUpdate = isBinary ? asBytes(record.update) : null;
      if (
        (!isLegacy && !isCurrent)
        || !parsedKey
        || parsedKey.accountId !== accountId
        || parsedKey.pageId !== pageId
        || record.accountId !== accountId
        || record.pageId !== pageId
        || !isNonEmptyString(record.sourceId)
        || parsedKey.sourceId !== record.sourceId
        || parsedKey.documentEpoch !== (isCurrent ? record.documentEpoch : null)
        || parsedKey.legacyKey !== isLegacy
        || !isNonEmptyString(record.generation)
        || (isCurrent && !isNonEmptyString(record.documentEpoch))
        || (isBinary ? !binaryUpdate?.byteLength : (typeof record.update !== "string" || !record.update))
      ) {
        return { record: null, unreadable: true };
      }
      const update = isBinary ? binaryUpdate : base64ToBytes(record.update);
      if (!update?.byteLength) return { record: null, unreadable: true };
      const updatedAt = Number(record.updatedAt);
      return {
        record: {
          sourceId: record.sourceId,
          documentEpoch: isCurrent ? record.documentEpoch : null,
          legacy: isLegacy,
          generation: record.generation,
          updatedAt: Number.isFinite(updatedAt) && updatedAt >= 0 && updatedAt <= 8_640_000_000_000_000
            ? updatedAt
            : 0,
          encodedUpdate: isBinary ? null : record.update,
          update
        },
        unreadable: false
      };
    } catch {
      // Never destroy an unconfirmed recovery payload merely because this
      // application version cannot decode it. Destructive guards treat it as
      // potentially recoverable and block until inspection succeeds.
      return { record: null, unreadable: true };
    }
  }

  function inspectPageKeys(accountId, pageId) {
    const pagePrefix = getPagePrefix(accountId, pageId);
    const snapshot = snapshotStorageKeys();
    return {
      keys: snapshot.keys.filter((key) => key.startsWith(pagePrefix)),
      reliable: snapshot.reliable
    };
  }

  function inspectAll(accountId, pageId) {
    if (!storage || !isNonEmptyString(accountId) || !isNonEmptyString(pageId)) {
      return { records: [], reliable: false, unreadableKeys: [] };
    }
    const keyInspection = inspectPageKeys(accountId, pageId);
    const records = [];
    const unreadableKeys = [];
    for (const key of keyInspection.keys) {
      const inspection = inspectRecord(key, accountId, pageId);
      if (inspection.record) records.push(inspection.record);
      else if (inspection.unreadable) unreadableKeys.push(key);
    }
    return {
      records: records.sort((left, right) =>
        left.updatedAt - right.updatedAt
        || String(left.documentEpoch ?? "").localeCompare(String(right.documentEpoch ?? ""))
        || left.sourceId.localeCompare(right.sourceId)
      ),
      reliable: keyInspection.reliable,
      unreadableKeys
    };
  }

  function loadAll(accountId, pageId) {
    return inspectAll(accountId, pageId).records;
  }

  function inspectPageRecords(pageId) {
    if (!storage || !isNonEmptyString(pageId)) {
      return { records: [], reliable: false, unreadableKeys: [] };
    }
    const snapshot = snapshotStorageKeys();
    const records = [];
    const unreadableKeys = [];
    for (const key of snapshot.keys) {
      if (!key.startsWith(storagePrefix)) continue;
      const parsedKey = parseStorageKey(key);
      if (!parsedKey) {
        unreadableKeys.push(key);
        continue;
      }
      if (parsedKey.pageId !== pageId) continue;
      const inspection = inspectRecord(key, parsedKey.accountId, pageId);
      if (inspection.record) records.push({ accountId: parsedKey.accountId, ...inspection.record });
      else if (inspection.unreadable) unreadableKeys.push(key);
    }
    return {
      records: records.sort((left, right) => left.updatedAt - right.updatedAt),
      reliable: snapshot.reliable,
      unreadableKeys
    };
  }

  function loadPageRecords(pageId) {
    return inspectPageRecords(pageId).records;
  }

  function inspectAccountRecords(accountId) {
    if (!storage || !isNonEmptyString(accountId)) {
      return { records: [], reliable: false, unreadableKeys: [] };
    }
    const accountPrefix = `${prefix}:${encodeURIComponent(accountId)}:`;
    const snapshot = snapshotStorageKeys();
    const records = [];
    const unreadableKeys = [];
    for (const key of snapshot.keys) {
      if (!key.startsWith(accountPrefix)) continue;
      const parsedKey = parseStorageKey(key);
      if (!parsedKey || parsedKey.accountId !== accountId) {
        unreadableKeys.push(key);
        continue;
      }
      const inspection = inspectRecord(key, accountId, parsedKey.pageId);
      if (inspection.record) records.push({ accountId, pageId: parsedKey.pageId, ...inspection.record });
      else if (inspection.unreadable) unreadableKeys.push(key);
    }
    return {
      records: records.sort((left, right) => left.updatedAt - right.updatedAt),
      reliable: snapshot.reliable,
      unreadableKeys
    };
  }

  function loadAccountRecords(accountId) {
    return inspectAccountRecords(accountId).records;
  }

  function save(accountId, pageId, sourceId, documentEpoch, update) {
    if (
      !storage
      || !isNonEmptyString(accountId)
      || !isNonEmptyString(pageId)
      || !isNonEmptyString(sourceId)
      || !isNonEmptyString(documentEpoch)
    ) return null;
    const bytes = update instanceof Uint8Array ? new Uint8Array(update) : new Uint8Array(update ?? 0);
    if (!bytes.byteLength) return null;
    const key = getKey(accountId, pageId, documentEpoch, sourceId);
    const existing = inspectRecord(key, accountId, pageId);
    if (
      existing.unreadable
      || (existing.record && (
        existing.record.legacy
        || existing.record.sourceId !== sourceId
        || existing.record.documentEpoch !== documentEpoch
      ))
    ) return null;
    const generation = createGeneration();
    const common = {
      accountId,
      pageId,
      sourceId,
      documentEpoch,
      generation,
      updatedAt: Date.now()
    };
    try {
      if (typeof storage.setObject === "function" && typeof storage.flush === "function") {
        storage.setObject(key, {
          schemaVersion: recoverySchemaVersion,
          ...common,
          update: bytes
        });
        return storage.flush().then(() => generation);
      }
      storage.setItem(
        key,
        JSON.stringify({
          schemaVersion: base64RecoverySchemaVersion,
          ...common,
          update: bytesToBase64(bytes)
        })
      );
      return generation;
    } catch {
      return null;
    }
  }

  function remove(accountId, pageId, sourceId, documentEpoch, expectedGeneration = null) {
    if (
      !storage
      || !isNonEmptyString(accountId)
      || !isNonEmptyString(pageId)
      || !isNonEmptyString(sourceId)
      || !(documentEpoch === null || isNonEmptyString(documentEpoch))
    ) return false;
    const keyInspection = inspectPageKeys(accountId, pageId);
    if (!keyInspection.reliable) return false;
    try {
      for (const key of keyInspection.keys) {
        const recordInspection = inspectRecord(key, accountId, pageId);
        if (recordInspection.unreadable) return false;
        const record = recordInspection.record;
        if (!record || record.sourceId !== sourceId || record.documentEpoch !== documentEpoch) continue;
        if (isNonEmptyString(expectedGeneration) && record.generation !== expectedGeneration) return false;
        storage.removeItem(key);
        return true;
      }
      return true;
    } catch {
      return false;
    }
  }


  async function removeDurably(accountId, pageId, sourceId, documentEpoch, expectedGeneration = null) {
    if (
      !storage
      || typeof storage.compareAndRemove !== "function"
      || !isNonEmptyString(accountId)
      || !isNonEmptyString(pageId)
      || !isNonEmptyString(sourceId)
      || !(documentEpoch === null || isNonEmptyString(documentEpoch))
    ) return false;

    const keyInspection = inspectPageKeys(accountId, pageId);
    if (!keyInspection.reliable) return false;

    for (const key of keyInspection.keys) {
      const parsedKey = parseStorageKey(key);
      if (
        !parsedKey
        || parsedKey.accountId !== accountId
        || parsedKey.pageId !== pageId
        || parsedKey.sourceId !== sourceId
        || parsedKey.documentEpoch !== documentEpoch
      ) continue;

      return storage.compareAndRemove(key, (storedValue) => {
        try {
          const storedRecord = typeof storedValue === "string" ? JSON.parse(storedValue) : storedValue;
          if (!storedRecord || typeof storedRecord !== "object" || Array.isArray(storedRecord)) return false;
          const isLegacy = storedRecord.schemaVersion === legacyRecoverySchemaVersion;
          const isBase64 = storedRecord.schemaVersion === base64RecoverySchemaVersion;
          const isBinary = storedRecord.schemaVersion === recoverySchemaVersion;
          const currentDocumentEpoch = isLegacy ? null : storedRecord.documentEpoch;
          const updateIsValid = isBinary
            ? Boolean(asBytes(storedRecord.update)?.byteLength)
            : ((isBase64 || isLegacy) && typeof storedRecord.update === "string" && storedRecord.update.length > 0);
          return (isLegacy || isBase64 || isBinary)
            && updateIsValid
            && storedRecord.accountId === accountId
            && storedRecord.pageId === pageId
            && storedRecord.sourceId === sourceId
            && currentDocumentEpoch === documentEpoch
            && isNonEmptyString(storedRecord.generation)
            && (!isNonEmptyString(expectedGeneration) || storedRecord.generation === expectedGeneration);
        } catch {
          return false;
        }
      });
    }
    return false;
  }
  return {
    inspectAll,
    loadAll,
    inspectPageRecords,
    loadPageRecords,
    inspectAccountRecords,
    loadAccountRecords,
    save,
    remove,
    removeDurably
  };
}
