const recoverySchemaVersion = 1;
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
  const getKey = (accountId, pageId, sourceId) =>
    `${getPagePrefix(accountId, pageId)}${encodeURIComponent(sourceId)}`;

  function readRecord(key, accountId, pageId) {
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const record = JSON.parse(raw);
      if (
        record?.schemaVersion !== recoverySchemaVersion
        || record.accountId !== accountId
        || record.pageId !== pageId
        || !isNonEmptyString(record.sourceId)
        || !isNonEmptyString(record.generation)
        || typeof record.update !== "string"
        || !record.update
      ) {
        storage.removeItem(key);
        return null;
      }
      const update = base64ToBytes(record.update);
      if (!update.byteLength) {
        storage.removeItem(key);
        return null;
      }
      const updatedAt = Number(record.updatedAt);
      return {
        sourceId: record.sourceId,
        generation: record.generation,
        updatedAt: Number.isFinite(updatedAt) && updatedAt >= 0 && updatedAt <= 8_640_000_000_000_000
          ? updatedAt
          : 0,
        encodedUpdate: record.update,
        update
      };
    } catch {
      try {
        storage.removeItem(key);
      } catch {
        // A disabled storage backend must not prevent the editor from opening.
      }
      return null;
    }
  }

  function loadAll(accountId, pageId) {
    if (!storage || !isNonEmptyString(accountId) || !isNonEmptyString(pageId)) return [];
    const pagePrefix = getPagePrefix(accountId, pageId);
    try {
      const keys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(pagePrefix)) keys.push(key);
      }

      const records = [];
      // readRecord may remove corrupt entries. Iterate a stable key snapshot so
      // deleting one entry cannot shift and hide the next recoverable record.
      for (const key of keys) {
        const record = readRecord(key, accountId, pageId);
        if (record) records.push(record);
      }
      return records.sort((left, right) => left.updatedAt - right.updatedAt);
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

  function save(accountId, pageId, sourceId, update) {
    if (
      !storage
      || !isNonEmptyString(accountId)
      || !isNonEmptyString(pageId)
      || !isNonEmptyString(sourceId)
    ) return null;
    const bytes = update instanceof Uint8Array ? update : new Uint8Array(update ?? 0);
    if (!bytes.byteLength) return null;
    const generation = createGeneration();
    try {
      storage.setItem(
        getKey(accountId, pageId, sourceId),
        JSON.stringify({
          schemaVersion: recoverySchemaVersion,
          accountId,
          pageId,
          sourceId,
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

  function remove(accountId, pageId, sourceId, expectedGeneration = null) {
    if (
      !storage
      || !isNonEmptyString(accountId)
      || !isNonEmptyString(pageId)
      || !isNonEmptyString(sourceId)
    ) return false;
    const key = getKey(accountId, pageId, sourceId);
    try {
      if (isNonEmptyString(expectedGeneration)) {
        const raw = storage.getItem(key);
        if (!raw) return true;
        const record = JSON.parse(raw);
        if (record?.generation !== expectedGeneration) return false;
      }
      storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  return { loadAll, loadPageRecords, loadAccountRecords, save, remove };
}
