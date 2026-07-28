import { inspectStorageKeys } from "./storage-snapshot.js";

const draftSchemaVersion = 2;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizeVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

function normalizeUpdatedAt(value) {
  const updatedAt = Number(value);
  return Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now();
}

function normalizeTitleDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const revision = normalizeRevision(value.revision);
  const expectedVersion = normalizeVersion(value.expectedVersion);
  if (typeof value.value !== "string" || revision === null || expectedVersion === null) return null;
  return { value: value.value, revision, expectedVersion, updatedAt: normalizeUpdatedAt(value.updatedAt) };
}

function normalizeBlockDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const revision = normalizeRevision(value.revision);
  const expectedVersion = normalizeVersion(value.expectedVersion);
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) return null;
  if (revision === null || expectedVersion === null) return null;
  return { payload: value.payload, revision, expectedVersion, updatedAt: normalizeUpdatedAt(value.updatedAt) };
}

function normalizeParentBlockId(value) {
  if (value === null) return null;
  return isNonEmptyString(value) ? value : undefined;
}

function normalizeBlockOrderDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parentBlockId = normalizeParentBlockId(value.parentBlockId);
  if (parentBlockId === undefined || !isNonEmptyString(value.mutationId)) return null;
  if (!Array.isArray(value.orderedIds) || value.orderedIds.length === 0) return null;
  if (!Array.isArray(value.items) || value.items.length !== value.orderedIds.length) return null;

  const orderedIds = value.orderedIds.every(isNonEmptyString) ? [...value.orderedIds] : null;
  if (!orderedIds || new Set(orderedIds).size !== orderedIds.length) return null;

  const items = [];
  for (let index = 0; index < value.items.length; index += 1) {
    const item = value.items[index];
    const itemParentBlockId = normalizeParentBlockId(item?.parentBlockId);
    const expectedVersion = normalizeVersion(item?.expectedVersion);
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      item.id !== orderedIds[index] ||
      item.sortOrder !== index ||
      itemParentBlockId !== parentBlockId ||
      expectedVersion === null
    ) {
      return null;
    }
    items.push({ id: item.id, sortOrder: index, parentBlockId, expectedVersion });
  }

  let previousIds = null;
  if (value.previousIds !== null && value.previousIds !== undefined) {
    if (!Array.isArray(value.previousIds) || value.previousIds.length !== orderedIds.length) return null;
    if (!value.previousIds.every(isNonEmptyString) || new Set(value.previousIds).size !== orderedIds.length) return null;
    if (value.previousIds.some((id) => !orderedIds.includes(id))) return null;
    previousIds = [...value.previousIds];
  }

  return {
    parentBlockId,
    orderedIds,
    previousIds,
    mutationId: value.mutationId,
    items,
    updatedAt: normalizeUpdatedAt(value.updatedAt)
  };
}

function normalizeRecord(value, userId, pageId, expectedSourceId = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    value.schemaVersion !== draftSchemaVersion ||
    value.userId !== userId ||
    value.pageId !== pageId ||
    !isNonEmptyString(value.sourceId) ||
    (expectedSourceId && value.sourceId !== expectedSourceId)
  ) {
    return null;
  }

  let title = null;
  if (value.title !== null && value.title !== undefined) {
    title = normalizeTitleDraft(value.title);
    if (!title) return null;
  }

  let blockOrder = null;
  if (value.blockOrder !== null && value.blockOrder !== undefined) {
    blockOrder = normalizeBlockOrderDraft(value.blockOrder);
    if (!blockOrder) return null;
  }

  const blocks = {};
  if (value.blocks !== null && value.blocks !== undefined) {
    if (typeof value.blocks !== "object" || Array.isArray(value.blocks)) return null;
    for (const [blockId, blockDraft] of Object.entries(value.blocks)) {
      const normalized = normalizeBlockDraft(blockDraft);
      // A recovery record must be parsed losslessly. Silently dropping one bad
      // component would let the next save overwrite its last recoverable bytes.
      if (!isNonEmptyString(blockId) || !normalized) return null;
      Object.defineProperty(blocks, blockId, {
        value: normalized,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  }

  if (!title && !blockOrder && Object.keys(blocks).length === 0) return null;
  return {
    schemaVersion: draftSchemaVersion,
    userId,
    pageId,
    sourceId: value.sourceId,
    updatedAt: normalizeUpdatedAt(value.updatedAt),
    title,
    blocks,
    blockOrder
  };
}

export function createPageDraftStore(
  storage,
  { prefix = "brainvault.pageDraft.v2", sourceId = "default" } = {}
) {
  if (!isNonEmptyString(sourceId)) throw new TypeError("A non-empty draft sourceId is required");

  const getPagePrefix = (userId, pageId) =>
    `${prefix}:${encodeURIComponent(userId)}:${encodeURIComponent(pageId)}:`;
  const getKey = (userId, pageId, recordSourceId = sourceId) =>
    `${getPagePrefix(userId, pageId)}${encodeURIComponent(recordSourceId)}`;
  const getUserPrefix = (userId) => `${prefix}:${encodeURIComponent(userId)}:`;

  function snapshotStorageKeys() {
    return inspectStorageKeys(storage);
  }

  function inspectRecordByKey(key, userId, pageId, expectedSourceId = null) {
    if (!storage) return { record: null, unreadable: true };
    try {
      const raw = storage.getItem(key);
      // Storage.getItem() uses null, not an empty string, to signal absence.
      // Preserve every present but undecodable value instead of overwriting it.
      if (raw === null) return { record: null, unreadable: false };
      const record = normalizeRecord(JSON.parse(raw), userId, pageId, expectedSourceId);
      const parsedKey = parseUserDraftKey(key, userId);
      if (
        !record ||
        !parsedKey ||
        parsedKey.pageId !== pageId ||
        parsedKey.sourceId !== record.sourceId ||
        (expectedSourceId && parsedKey.sourceId !== expectedSourceId)
      ) {
        return { record: null, unreadable: true };
      }
      return { record, unreadable: false };
    } catch {
      return { record: null, unreadable: true };
    }
  }

  function readRecordByKey(key, userId, pageId, expectedSourceId = null) {
    return inspectRecordByKey(key, userId, pageId, expectedSourceId).record;
  }

  function loadPage(userId, pageId, recordSourceId = sourceId) {
    if (!storage || !isNonEmptyString(userId) || !isNonEmptyString(pageId) || !isNonEmptyString(recordSourceId)) {
      return null;
    }
    return readRecordByKey(getKey(userId, pageId, recordSourceId), userId, pageId, recordSourceId);
  }

  function parseUserDraftKey(key, userId) {
    const userPrefix = getUserPrefix(userId);
    if (!key.startsWith(userPrefix)) return null;
    const remainder = key.slice(userPrefix.length);
    const separatorIndex = remainder.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === remainder.length - 1) return null;
    try {
      const pageId = decodeURIComponent(remainder.slice(0, separatorIndex));
      const recordSourceId = decodeURIComponent(remainder.slice(separatorIndex + 1));
      return isNonEmptyString(pageId) && isNonEmptyString(recordSourceId)
        ? { pageId, sourceId: recordSourceId }
        : null;
    } catch {
      return null;
    }
  }

  function inspectPageDrafts(userId, pageId) {
    if (!storage || !isNonEmptyString(userId) || !isNonEmptyString(pageId)) {
      return { records: [], reliable: false, unreadableKeys: [] };
    }
    const pagePrefix = getPagePrefix(userId, pageId);
    const snapshot = snapshotStorageKeys();
    const records = [];
    const unreadableKeys = [];
    for (const key of snapshot.keys) {
      if (!key.startsWith(pagePrefix)) continue;
      const inspection = inspectRecordByKey(key, userId, pageId);
      if (inspection.record) records.push(inspection.record);
      else if (inspection.unreadable) unreadableKeys.push(key);
    }
    return {
      records: records.sort((left, right) => right.updatedAt - left.updatedAt),
      reliable: snapshot.reliable,
      unreadableKeys
    };
  }

  function loadPageDrafts(userId, pageId) {
    return inspectPageDrafts(userId, pageId).records;
  }

  function inspectUserDrafts(userId) {
    if (!storage || !isNonEmptyString(userId)) {
      return { records: [], reliable: false, unreadableKeys: [] };
    }
    const userPrefix = getUserPrefix(userId);
    const snapshot = snapshotStorageKeys();
    const records = [];
    const unreadableKeys = [];
    for (const key of snapshot.keys) {
      if (!key.startsWith(userPrefix)) continue;
      const parsedKey = parseUserDraftKey(key, userId);
      if (!parsedKey) {
        unreadableKeys.push(key);
        continue;
      }
      const inspection = inspectRecordByKey(key, userId, parsedKey.pageId, parsedKey.sourceId);
      if (inspection.record) records.push(inspection.record);
      else if (inspection.unreadable) unreadableKeys.push(key);
    }
    return {
      records: records.sort((left, right) => right.updatedAt - left.updatedAt),
      reliable: snapshot.reliable,
      unreadableKeys
    };
  }

  function loadUserDrafts(userId) {
    return inspectUserDrafts(userId).records;
  }

  function writePage(record) {
    if (!storage) return false;
    const hasTitle = Boolean(record.title);
    const hasBlocks = Object.keys(record.blocks ?? {}).length > 0;
    const hasBlockOrder = Boolean(record.blockOrder);
    const key = getKey(record.userId, record.pageId, record.sourceId);
    // Re-check immediately before every write/removal. A present unreadable
    // record is potentially the only recovery copy and must never be replaced.
    if (inspectRecordByKey(key, record.userId, record.pageId, record.sourceId).unreadable) return false;
    try {
      if (!hasTitle && !hasBlocks && !hasBlockOrder) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify({ ...record, updatedAt: Date.now() }));
      return true;
    } catch {
      return false;
    }
  }

  function createRecord(userId, pageId, recordSourceId = sourceId) {
    return {
      schemaVersion: draftSchemaVersion,
      userId,
      pageId,
      sourceId: recordSourceId,
      updatedAt: Date.now(),
      title: null,
      blocks: {},
      blockOrder: null
    };
  }

  function prepareRecordMutation(userId, pageId, recordSourceId, { createIfMissing = false } = {}) {
    if (
      !isNonEmptyString(userId) ||
      !isNonEmptyString(pageId) ||
      !isNonEmptyString(recordSourceId)
    ) {
      return { record: null, writable: false };
    }
    const inspection = inspectRecordByKey(
      getKey(userId, pageId, recordSourceId),
      userId,
      pageId,
      recordSourceId
    );
    if (inspection.unreadable) return { record: null, writable: false };
    return {
      record: inspection.record ?? (createIfMissing ? createRecord(userId, pageId, recordSourceId) : null),
      writable: true
    };
  }

  function saveTitle({ userId, pageId, value, expectedVersion, revision, sourceId: recordSourceId = sourceId }) {
    const normalizedVersion = normalizeVersion(expectedVersion);
    const normalizedRevision = normalizeRevision(revision);
    if (
      !isNonEmptyString(userId) ||
      !isNonEmptyString(pageId) ||
      !isNonEmptyString(recordSourceId) ||
      typeof value !== "string"
    ) {
      return false;
    }
    if (normalizedVersion === null || normalizedRevision === null) return false;
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId, { createIfMissing: true });
    if (!prepared.writable || !prepared.record) return false;
    const record = prepared.record;
    const updatedAt = Date.now();
    record.title = { value, expectedVersion: normalizedVersion, revision: normalizedRevision, updatedAt };
    record.updatedAt = updatedAt;
    return writePage(record);
  }

  function saveBlock({
    userId,
    pageId,
    blockId,
    payload,
    expectedVersion,
    revision,
    sourceId: recordSourceId = sourceId
  }) {
    const normalizedVersion = normalizeVersion(expectedVersion);
    const normalizedRevision = normalizeRevision(revision);
    if (
      !isNonEmptyString(userId) ||
      !isNonEmptyString(pageId) ||
      !isNonEmptyString(blockId) ||
      !isNonEmptyString(recordSourceId)
    ) {
      return false;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    if (normalizedVersion === null || normalizedRevision === null) return false;
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId, { createIfMissing: true });
    if (!prepared.writable || !prepared.record) return false;
    const record = prepared.record;
    const updatedAt = Date.now();
    record.blocks[blockId] = {
      payload,
      expectedVersion: normalizedVersion,
      revision: normalizedRevision,
      updatedAt
    };
    record.updatedAt = updatedAt;
    return writePage(record);
  }

  function saveBlockOrder({
    userId,
    pageId,
    parentBlockId = null,
    orderedIds,
    previousIds = null,
    mutationId,
    items,
    sourceId: recordSourceId = sourceId
  }) {
    if (!isNonEmptyString(userId) || !isNonEmptyString(pageId) || !isNonEmptyString(recordSourceId)) {
      return false;
    }
    const normalized = normalizeBlockOrderDraft({
      parentBlockId,
      orderedIds,
      previousIds,
      mutationId,
      items,
      updatedAt: Date.now()
    });
    if (!normalized) return false;
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId, { createIfMissing: true });
    if (!prepared.writable || !prepared.record) return false;
    const record = prepared.record;
    record.blockOrder = normalized;
    record.updatedAt = normalized.updatedAt;
    return writePage(record);
  }

  function acknowledgeTitle({
    userId,
    pageId,
    revision,
    nextExpectedVersion,
    sourceId: recordSourceId = sourceId
  }) {
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId);
    const acknowledgedRevision = normalizeRevision(revision);
    const nextVersion = normalizeVersion(nextExpectedVersion);
    if (!prepared.writable || acknowledgedRevision === null || nextVersion === null) return false;
    const record = prepared.record;
    if (!record?.title) return true;
    if (record.title.revision <= acknowledgedRevision) record.title = null;
    else record.title.expectedVersion = nextVersion;
    return writePage(record);
  }

  function acknowledgeBlock({
    userId,
    pageId,
    blockId,
    revision,
    nextExpectedVersion,
    sourceId: recordSourceId = sourceId
  }) {
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId);
    const acknowledgedRevision = normalizeRevision(revision);
    const nextVersion = normalizeVersion(nextExpectedVersion);
    if (!prepared.writable || acknowledgedRevision === null || nextVersion === null) return false;
    const record = prepared.record;
    const draft = record?.blocks?.[blockId];
    if (!record || !draft) return true;
    if (draft.revision <= acknowledgedRevision) delete record.blocks[blockId];
    else draft.expectedVersion = nextVersion;
    return writePage(record);
  }

  function acknowledgeBlockOrder({
    userId,
    pageId,
    mutationId,
    sourceId: recordSourceId = sourceId
  }) {
    if (
      !isNonEmptyString(userId) ||
      !isNonEmptyString(pageId) ||
      !isNonEmptyString(recordSourceId) ||
      !isNonEmptyString(mutationId)
    ) {
      return false;
    }
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId);
    if (!prepared.writable) return false;
    const record = prepared.record;
    if (!record?.blockOrder || record.blockOrder.mutationId !== mutationId) return true;
    record.blockOrder = null;
    return writePage(record);
  }

  function removeTitleIfUnchanged({ userId, pageId, sourceId: recordSourceId, value, expectedVersion, revision }) {
    const normalizedVersion = normalizeVersion(expectedVersion);
    const normalizedRevision = normalizeRevision(revision);
    if (
      !isNonEmptyString(userId) ||
      !isNonEmptyString(pageId) ||
      !isNonEmptyString(recordSourceId) ||
      typeof value !== "string" ||
      normalizedVersion === null ||
      normalizedRevision === null
    ) {
      return false;
    }
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId);
    if (!prepared.writable) return false;
    const record = prepared.record;
    if (!record?.title) return true;
    if (
      record.title.value !== value ||
      record.title.expectedVersion !== normalizedVersion ||
      record.title.revision !== normalizedRevision
    ) {
      return true;
    }
    record.title = null;
    return writePage(record);
  }

  function removeBlockIfUnchanged({
    userId,
    pageId,
    blockId,
    sourceId: recordSourceId,
    payload,
    expectedVersion,
    revision
  }) {
    const normalizedVersion = normalizeVersion(expectedVersion);
    const normalizedRevision = normalizeRevision(revision);
    if (
      !isNonEmptyString(userId) ||
      !isNonEmptyString(pageId) ||
      !isNonEmptyString(blockId) ||
      !isNonEmptyString(recordSourceId) ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      normalizedVersion === null ||
      normalizedRevision === null
    ) {
      return false;
    }
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId);
    if (!prepared.writable) return false;
    const record = prepared.record;
    const draft = record?.blocks?.[blockId];
    if (!record || !draft) return true;
    if (
      draft.expectedVersion !== normalizedVersion ||
      draft.revision !== normalizedRevision ||
      JSON.stringify(draft.payload) !== JSON.stringify(payload)
    ) {
      return true;
    }
    delete record.blocks[blockId];
    return writePage(record);
  }

  function removeTitle(userId, pageId, recordSourceId) {
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId);
    if (!prepared.writable) return false;
    const record = prepared.record;
    if (!record) return true;
    record.title = null;
    return writePage(record);
  }

  function removeBlock(userId, pageId, blockId, recordSourceId) {
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId);
    if (!prepared.writable) return false;
    const record = prepared.record;
    if (!record) return true;
    delete record.blocks[blockId];
    if (record.blockOrder?.orderedIds.includes(blockId)) record.blockOrder = null;
    return writePage(record);
  }

  // Destructive actions use source-scoped removal so another tab's unsaved work survives.
  function removeBlocks(userId, pageId, blockIds, recordSourceId = sourceId) {
    let succeeded = true;
    for (const blockId of blockIds ?? []) {
      succeeded = removeBlock(userId, pageId, blockId, recordSourceId) && succeeded;
    }
    return succeeded;
  }

  function removePage(userId, pageId, recordSourceId = sourceId) {
    if (
      !storage ||
      !isNonEmptyString(userId) ||
      !isNonEmptyString(pageId) ||
      !isNonEmptyString(recordSourceId)
    ) {
      return false;
    }
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId);
    if (!prepared.writable) return false;
    if (!prepared.record) return true;
    try {
      storage.removeItem(getKey(userId, pageId, recordSourceId));
      return true;
    } catch {
      return false;
    }
  }

  function removePages(userId, pageIds, recordSourceId = sourceId) {
    let succeeded = true;
    for (const pageId of pageIds ?? []) {
      succeeded = removePage(userId, pageId, recordSourceId) && succeeded;
    }
    return succeeded;
  }

  function clearBlocks(userId, pageId, blockIds) {
    const inspection = inspectPageDrafts(userId, pageId);
    if (!inspection.reliable || inspection.unreadableKeys.length) return false;
    let succeeded = true;
    const removedIds = new Set(blockIds ?? []);
    for (const record of inspection.records) {
      for (const blockId of removedIds) delete record.blocks[blockId];
      if (record.blockOrder?.orderedIds.some((blockId) => removedIds.has(blockId))) record.blockOrder = null;
      succeeded = writePage(record) && succeeded;
    }
    return succeeded;
  }

  function clearPage(userId, pageId) {
    if (!storage || !isNonEmptyString(userId) || !isNonEmptyString(pageId)) return false;
    const inspection = inspectPageDrafts(userId, pageId);
    if (!inspection.reliable || inspection.unreadableKeys.length) return false;
    let succeeded = true;
    for (const record of inspection.records) {
      succeeded = removePage(userId, pageId, record.sourceId) && succeeded;
    }
    return succeeded;
  }

  function clearPages(userId, pageIds) {
    let succeeded = true;
    for (const pageId of pageIds ?? []) succeeded = clearPage(userId, pageId) && succeeded;
    return succeeded;
  }

  function clearUser(userId) {
    if (!storage || !isNonEmptyString(userId)) return false;
    const inspection = inspectUserDrafts(userId);
    if (!inspection.reliable || inspection.unreadableKeys.length) return false;
    let succeeded = true;
    for (const record of inspection.records) {
      succeeded = removePage(userId, record.pageId, record.sourceId) && succeeded;
    }
    return succeeded;
  }

  return {
    sourceId,
    loadPage,
    inspectPageDrafts,
    loadPageDrafts,
    inspectUserDrafts,
    loadUserDrafts,
    saveTitle,
    saveBlock,
    saveBlockOrder,
    acknowledgeTitle,
    acknowledgeBlock,
    acknowledgeBlockOrder,
    removeTitleIfUnchanged,
    removeBlockIfUnchanged,
    removeTitle,
    removeBlock,
    removeBlocks,
    removePage,
    removePages,
    clearBlocks,
    clearPage,
    clearPages,
    clearUser
  };
}
