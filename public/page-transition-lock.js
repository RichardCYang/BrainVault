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
  const heldExclusiveIds = new Map();
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
      || (record.exclusiveId !== undefined && !isNonEmptyString(record.exclusiveId))
    ) {
      // Do not delete an undecodable lease. Overwriting an unknown active
      // transition could let two destructive operations run concurrently.
      return { status: "invalid", record: null };
    }
    // Expiry is only a signal that a lease may be stale. A reader cannot know
    // whether the destructive callback still holds its authoritative Web Lock
    // (for example after a throttled timer or a failed localStorage renewal).
    // Keep the record as a fence until a contender proves the Web Lock is free.
    return record.expiresAt <= now()
      ? { status: "expired", record }
      : { status: "active", record };
  }

  function read(pageId) {
    const inspection = inspect(pageId);
    return inspection.status === "active" || inspection.status === "expired"
      ? inspection.record
      : null;
  }

  function isExclusiveHeld(exclusiveId) {
    return (heldExclusiveIds.get(exclusiveId) ?? 0) > 0;
  }

  function acquire(pageId, kind, exclusiveId = pageId) {
    if (
      !storage
      || !isNonEmptyString(pageId)
      || !isNonEmptyString(kind)
      || !isNonEmptyString(exclusiveId)
      || !isExclusiveHeld(exclusiveId)
    ) return null;
    if (inspect(pageId).status !== "missing") return null;
    const record = {
      schemaVersion: transitionSchemaVersion,
      pageId,
      sourceId,
      token: createToken(sourceId),
      kind,
      exclusiveId,
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
      if (inspection.status === "active" || inspection.status === "expired") records.push(inspection.record);
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
    return (
      (inspection.status === "active" || inspection.status === "expired")
      && inspection.record?.token === record.token
    );
  }

  function renew(record) {
    const exclusiveId = record?.exclusiveId ?? record?.pageId;
    if (!isExclusiveHeld(exclusiveId) || !owns(record)) return null;
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

  function releaseExpired(pageId) {
    const inspection = inspect(pageId);
    if (inspection.status === "missing") return true;
    if (inspection.status !== "expired") return false;
    const exclusiveId = inspection.record.exclusiveId;
    // New leases name their authoritative lock. Legacy leases did not, so a
    // caller must hold the page-scoped lock as well as any inferred owner lock
    // before cleaning one up. runExclusive() tracks these scopes per instance.
    if (exclusiveId ? !isExclusiveHeld(exclusiveId) : !isExclusiveHeld(pageId)) return false;
    return removeIfOwned(pageId, inspection.record.token);
  }

  async function runExclusive(pageId, action) {
    const requestedIds = Array.isArray(pageId) ? pageId : [pageId];
    if (
      !requestedIds.length
      || requestedIds.some((exclusiveId) => !isNonEmptyString(exclusiveId))
      || typeof action !== "function"
    ) {
      throw new TypeError("One or more pageIds and a transition action are required");
    }
    const exclusiveIds = [...new Set(requestedIds)].sort();
    if (typeof lockManager?.request !== "function") {
      // Web Storage has no atomic compare-and-set primitive. A durable
      // lease is useful for propagation, crash recovery, and UI state, but
      // it cannot safely replace Web Locks for a destructive transition.
      return {
        acquired: false,
        value: undefined,
        reason: "lock-manager-unavailable"
      };
    }

    async function requestAt(index) {
      if (index >= exclusiveIds.length) {
        return { acquired: true, value: await action() };
      }
      const exclusiveId = exclusiveIds[index];
      return lockManager.request(
        getExclusiveLockName(exclusiveId),
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) return { acquired: false, value: undefined };
          heldExclusiveIds.set(exclusiveId, (heldExclusiveIds.get(exclusiveId) ?? 0) + 1);
          try {
            return await requestAt(index + 1);
          } finally {
            const remaining = (heldExclusiveIds.get(exclusiveId) ?? 1) - 1;
            if (remaining > 0) heldExclusiveIds.set(exclusiveId, remaining);
            else heldExclusiveIds.delete(exclusiveId);
          }
        }
      );
    }

    return requestAt(0);
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
    releaseExpired,
    runExclusive
  };
}
