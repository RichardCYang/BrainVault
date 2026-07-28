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
  const getPagePrefix = (accountId, pageId) =>
    `${prefix}:${encodeURIComponent(accountId)}:${encodeURIComponent(pageId)}:`;
  const getKey = (accountId, pageId, documentEpoch, sourceId) =>
    `${getPagePrefix(accountId, pageId)}${encodeURIComponent(documentEpoch)}:${encodeURIComponent(sourceId)}`;

  function readRecord(key, accountId, pageId) {
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const record = JSON.parse(raw);
      const isLegacy = record?.schemaVersion === legacyRecoverySchemaVersion;
      const isCurrent = record?.schemaVersion === recoverySchemaVersion;
      if (
        (!isLegacy && !isCurrent)
        || record.accountId !== accountId
        || record.pageId !== pageId
        || !isNonEmptyString(record.sourceId)
        || !isNonEmptyString(record.generation)
        || (isCurrent && !isNonEmptyString(record.documentEpoch))
        || typeof record.update !== "string"
        || !record.update
      ) {
        // Never destroy an unconfirmed recovery payload merely because this
        // application version cannot decode it. Keep the raw browser record
        // available for forensic/manual recovery.
        return null;
      }
      const update = base64ToBytes(record.update);
      if (!update.byteLength) return null;
      const updatedAt = Number(record.updatedAt);
      return {
        sourceId: record.sourceId,
        documentEpoch: isCurrent ? record.documentEpoch : null,
        legacy: isLegacy,
        generation: record.generation,
        updatedAt: Number.isFinite(updatedAt) && updatedAt >= 0 && updatedAt <= 8_640_000_000_000_000
          ? updatedAt
          : 0,
        encodedUpdate: record.update,
        update
      };
    } catch {
      // A malformed or temporarily unreadable record is skipped but retained.
      // Automatic cleanup would turn a decode problem into irreversible loss.
      return null;
    }
  }

  function listPageKeys(accountId, pageId) {
    const pagePrefix = getPagePrefix(accountId, pageId);
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(pagePrefix)) keys.push(key);
    }
    return keys;
  }

  function loadAll(accountId, pageId) {
    if (!storage || !isNonEmptyString(accountId) || !isNonEmptyString(pageId)) return [];
    try {
      const records = [];
      // Iterate a stable key snapshot so a storage implementation changing
      // during inspection cannot shift and hide another recoverable record.
      for (const key of listPageKeys(accountId, pageId)) {
        const record = readRecord(key, accountId, pageId);
        if (record) records.push(record);
      }
      return records.sort((left, right) =>
        left.updatedAt - right.updatedAt
        || String(left.documentEpoch ?? "").localeCompare(String(right.documentEpoch ?? ""))
        || left.sourceId.localeCompare(right.sourceId)
      );
    } catch {
      return [];
    }
  }

  function loadPageRecords(pageId) {
    if (!storage || !isNonEmptyString(pageId)) return [];
    const storagePrefix = `${prefix}:`;
    try {
      const keys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(storagePrefix)) keys.push(key);
      }

      const records = [];
      for (const key of keys) {
        try {
          const raw = storage.getItem(key);
          if (!raw) continue;
          const value = JSON.parse(raw);
          if (!isNonEmptyString(value?.accountId) || value?.pageId !== pageId) continue;
          const record = readRecord(key, value.accountId, pageId);
          if (record) records.push({ accountId: value.accountId, ...record });
        } catch {
          // A corrupt record for another account must not hide valid page recovery.
        }
      }
      return records.sort((left, right) => left.updatedAt - right.updatedAt);
    } catch {
      return [];
    }
  }

  function loadAccountRecords(accountId) {
    if (!storage || !isNonEmptyString(accountId)) return [];
    const accountPrefix = `${prefix}:${encodeURIComponent(accountId)}:`;
    try {
      const keys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(accountPrefix)) keys.push(key);
      }

      const records = [];
      for (const key of keys) {
        try {
          const raw = storage.getItem(key);
          if (!raw) continue;
          const value = JSON.parse(raw);
          if (value?.accountId !== accountId || !isNonEmptyString(value?.pageId)) continue;
          const record = readRecord(key, accountId, value.pageId);
          if (record) records.push({ accountId, pageId: value.pageId, ...record });
        } catch {
          // A corrupt record for one page must not hide another recoverable page.
        }
      }
      return records.sort((left, right) => left.updatedAt - right.updatedAt);
    } catch {
      return [];
    }
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
    const generation = createGeneration();
    try {
      storage.setItem(
        getKey(accountId, pageId, documentEpoch, sourceId),
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
    try {
      for (const key of listPageKeys(accountId, pageId)) {
        const record = readRecord(key, accountId, pageId);
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

  return { loadAll, loadPageRecords, loadAccountRecords, save, remove };
}
