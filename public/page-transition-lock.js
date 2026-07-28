import { inspectStorageKeys } from "./storage-snapshot.js";

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
  const storagePrefix = `${prefix}:`;
  const getKey = (pageId) => `${prefix}:${encodeURIComponent(pageId)}`;
  const getExclusiveLockName = (pageId) => `${prefix}.exclusive:${encodeURIComponent(pageId)}`;

  function parsePageIdFromKey(key) {
    if (!key.startsWith(storagePrefix)) return null;
    const encodedPageId = key.slice(storagePrefix.length);
    if (!encodedPageId) return null;
    try {
      const pageId = decodeURIComponent(encodedPageId);
      return isNonEmptyString(pageId) ? pageId : null;
    } catch {
      return null;
    }
  }

  function removeIfOwned(pageId, token) {
    try {
      const raw = storage?.getItem(getKey(pageId));
      if (raw === null) return true;
      const record = JSON.parse(raw);
      if (record?.token !== token) return false;
      storage.removeItem(getKey(pageId));
      return true;
    } catch {
      return false;
    }
  }

  function inspect(pageId) {
    if (!storage || !isNonEmptyString(pageId)) {
      return { status: "error", record: null };
    }
    const key = getKey(pageId);
    let raw;
    try {
      raw = storage.getItem(key);
    } catch {
      return { status: "error", record: null };
    }
    if (raw === null) return { status: "missing", record: null };

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      return { status: "invalid", record: null };
    }
    if (
      record?.schemaVersion !== transitionSchemaVersion
      || record.pageId !== pageId
      || !isNonEmptyString(record.sourceId)
      || !isNonEmptyString(record.token)
      || !isNonEmptyString(record.kind)
      || !Number.isFinite(record.expiresAt)
    ) {
      // Do not delete an undecodable lease. Overwriting an unknown active
      // transition could let two destructive operations run concurrently.
      return { status: "invalid", record: null };
    }
    if (record.expiresAt <= now()) {
      return removeIfOwned(pageId, record.token)
        ? { status: "missing", record: null }
        : { status: "error", record: null };
    }
    return { status: "active", record };
  }

  function read(pageId) {
    const inspection = inspect(pageId);
    return inspection.status === "active" ? inspection.record : null;
  }

  function acquire(pageId, kind) {
    if (!storage || !isNonEmptyString(pageId) || !isNonEmptyString(kind)) return null;
    if (inspect(pageId).status !== "missing") return null;
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
      const verified = inspect(pageId);
      return verified.status === "active" && verified.record?.token === record.token
        ? verified.record
        : null;
    } catch {
      return null;
    }
  }

  function inspectActive() {
    if (!storage) return { records: [], reliable: false, unreadableKeys: [] };
    const snapshot = inspectStorageKeys(storage);
    const records = [];
    const unreadableKeys = [];

    for (const key of snapshot.keys) {
      if (!key.startsWith(storagePrefix)) continue;
      const pageId = parsePageIdFromKey(key);
      if (!pageId) {
        unreadableKeys.push(key);
        continue;
      }
      const inspection = inspect(pageId);
      if (inspection.status === "active") records.push(inspection.record);
      else if (inspection.status === "invalid" || inspection.status === "error") unreadableKeys.push(key);
    }

    return {
      records: records.sort((left, right) => left.expiresAt - right.expiresAt),
      reliable: snapshot.reliable,
      unreadableKeys
    };
  }

  function loadActive() {
    return inspectActive().records;
  }

  function owns(record) {
    if (!record?.pageId || !record?.token) return false;
    const inspection = inspect(record.pageId);
    return inspection.status === "active" && inspection.record?.token === record.token;
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

  return {
    prefix,
    ttlMs: normalizedTtlMs,
    inspect,
    read,
    inspectActive,
    loadActive,
    acquire,
    owns,
    renew,
    release,
    runExclusive
  };
}
