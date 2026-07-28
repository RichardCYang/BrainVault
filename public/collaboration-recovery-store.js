import { inspectStorageKeys } from "./storage-snapshot.js";

const recoverySchemaVersion = 2;
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

  function inspectRecord(key, accountId, pageId) {
    if (!storage) return { record: null, unreadable: true };
    try {
      const raw = storage.getItem(key);
      if (raw === null) return { record: null, unreadable: false };
      const record = JSON.parse(raw);
      const parsedKey = parseStorageKey(key);
      const isLegacy = record?.schemaVersion === legacyRecoverySchemaVersion;
      const isCurrent = record?.schemaVersion === recoverySchemaVersion;
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
        || typeof record.update !== "string"
        || !record.update
      ) {
        return { record: null, unreadable: true };
      }
      const update = base64ToBytes(record.update);
      if (!update.byteLength) return { record: null, unreadable: true };
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
          encodedUpdate: record.update,
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

  function readRecord(key, accountId, pageId) {
    return inspectRecord(key, accountId, pageId).record;
  }

  function inspectPageKeys(accountId, pageId) {
    const pagePrefix = getPagePrefix(accountId, pageId);
    const snapshot = snapshotStorageKeys();
    return {
      keys: snapshot.keys.filter((key) => key.startsWith(pagePrefix)),
      reliable: snapshot.reliable
    };
  }

  function listPageKeys(accountId, pageId) {
    return inspectPageKeys(accountId, pageId).keys;
  }

  function loadAll(accountId, pageId) {
    if (!storage || !isNonEmptyString(accountId) || !isNonEmptyString(pageId)) return [];
    const records = [];
    for (const key of listPageKeys(accountId, pageId)) {
      const record = readRecord(key, accountId, pageId);
      if (record) records.push(record);
    }
    return records.sort((left, right) =>
      left.updatedAt - right.updatedAt
      || String(left.documentEpoch ?? "").localeCompare(String(right.documentEpoch ?? ""))
      || left.sourceId.localeCompare(right.sourceId)
    );
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
        // The key belongs to this recovery namespace but its page cannot be
        // proven. It may target the page being deleted, so fail closed.
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
    const bytes = update instanceof Uint8Array ? update : new Uint8Array(update ?? 0);
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
    try {
      storage.setItem(
        key,
        JSON.stringify({
          schemaVersion: recoverySchemaVersion,
          accountId,
          pageId,
          sourceId,
          documentEpoch,
          generation,
          updatedAt: Date.now(),
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

  return {
    loadAll,
    inspectPageRecords,
    loadPageRecords,
    inspectAccountRecords,
    loadAccountRecords,
    save,
    remove
  };
}
