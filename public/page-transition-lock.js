const transitionSchemaVersion = 1;
const defaultTtlMs = 120_000;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function createToken(sourceId) {
  return globalThis.crypto?.randomUUID?.()
    ?? `${sourceId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createPageTransitionLock(
  storage,
  {
    prefix = "brainvault.pageTransition.v1",
    sourceId,
    ttlMs = defaultTtlMs,
    now = () => Date.now(),
    lockManager = null
  } = {}
) {
  if (!isNonEmptyString(sourceId)) throw new TypeError("A non-empty transition sourceId is required");
  const normalizedTtlMs = Number.isFinite(ttlMs) && ttlMs >= 1_000 ? Math.floor(ttlMs) : defaultTtlMs;
  const getKey = (pageId) => `${prefix}:${encodeURIComponent(pageId)}`;
  const getExclusiveLockName = (pageId) => `${prefix}.exclusive:${encodeURIComponent(pageId)}`;

  function removeIfOwned(pageId, token) {
    try {
      const raw = storage?.getItem(getKey(pageId));
      if (!raw) return true;
      const record = JSON.parse(raw);
      if (record?.token !== token) return false;
      storage.removeItem(getKey(pageId));
      return true;
    } catch {
      return false;
    }
  }

  function read(pageId) {
    if (!storage || !isNonEmptyString(pageId)) return null;
    const key = getKey(pageId);
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const record = JSON.parse(raw);
      if (
        record?.schemaVersion !== transitionSchemaVersion
        || record.pageId !== pageId
        || !isNonEmptyString(record.sourceId)
        || !isNonEmptyString(record.token)
        || !isNonEmptyString(record.kind)
        || !Number.isFinite(record.expiresAt)
      ) {
        storage.removeItem(key);
        return null;
      }
      if (record.expiresAt <= now()) {
        removeIfOwned(pageId, record.token);
        return null;
      }
      return record;
    } catch {
      return null;
    }
  }

  function acquire(pageId, kind) {
    if (!storage || !isNonEmptyString(pageId) || !isNonEmptyString(kind)) return null;
    if (read(pageId)) return null;
    const record = {
      schemaVersion: transitionSchemaVersion,
      pageId,
      sourceId,
      token: createToken(sourceId),
      kind,
      expiresAt: now() + normalizedTtlMs
    };
    try {
      storage.setItem(getKey(pageId), JSON.stringify(record));
      const verified = read(pageId);
      return verified?.token === record.token ? verified : null;
    } catch {
      return null;
    }
  }

  function loadActive() {
    if (!storage) return [];
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
          if (!isNonEmptyString(value?.pageId)) continue;
          const record = read(value.pageId);
          if (record) records.push(record);
        } catch {
          // One malformed transition record must not hide another active lease.
        }
      }
      return records.sort((left, right) => left.expiresAt - right.expiresAt);
    } catch {
      return [];
    }
  }

  function owns(record) {
    if (!record?.pageId || !record?.token) return false;
    return read(record.pageId)?.token === record.token;
  }

  function renew(record) {
    if (!owns(record)) return null;
    const renewed = { ...record, expiresAt: now() + normalizedTtlMs };
    try {
      storage.setItem(getKey(record.pageId), JSON.stringify(renewed));
      return owns(renewed) ? renewed : null;
    } catch {
      return null;
    }
  }

  function release(record) {
    if (!record?.pageId || !record?.token) return false;
    return removeIfOwned(record.pageId, record.token);
  }

  async function runExclusive(pageId, action) {
    if (!isNonEmptyString(pageId) || typeof action !== "function") {
      throw new TypeError("A pageId and transition action are required");
    }
    if (typeof lockManager?.request !== "function") {
      return { acquired: true, value: await action() };
    }
    return lockManager.request(
      getExclusiveLockName(pageId),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => lock
        ? { acquired: true, value: await action() }
        : { acquired: false, value: undefined }
    );
  }

  return { prefix, ttlMs: normalizedTtlMs, read, loadActive, acquire, owns, renew, release, runExclusive };
}
