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

  const title = normalizeTitleDraft(value.title);
  const blockOrder = normalizeBlockOrderDraft(value.blockOrder);
  const blocks = {};
  if (value.blocks && typeof value.blocks === "object" && !Array.isArray(value.blocks)) {
    for (const [blockId, blockDraft] of Object.entries(value.blocks)) {
      if (!isNonEmptyString(blockId)) continue;
      const normalized = normalizeBlockDraft(blockDraft);
      if (normalized) blocks[blockId] = normalized;
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
      if (!raw) return { record: null, unreadable: false };
      const record = normalizeRecord(JSON.parse(raw), userId, pageId, expectedSourceId);
      return { record, unreadable: !record };
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
    const record = loadPage(userId, pageId, recordSourceId) ?? createRecord(userId, pageId, recordSourceId);
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
    const record = loadPage(userId, pageId, recordSourceId) ?? createRecord(userId, pageId, recordSourceId);
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
    const record = loadPage(userId, pageId, recordSourceId) ?? createRecord(userId, pageId, recordSourceId);
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
    const record = loadPage(userId, pageId, recordSourceId);
    const acknowledgedRevision = normalizeRevision(revision);
    const nextVersion = normalizeVersion(nextExpectedVersion);
    if (!record?.title || acknowledgedRevision === null || nextVersion === null) return true;
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
    const record = loadPage(userId, pageId, recordSourceId);
    const acknowledgedRevision = normalizeRevision(revision);
    const nextVersion = normalizeVersion(nextExpectedVersion);
    const draft = record?.blocks?.[blockId];
    if (!record || !draft || acknowledgedRevision === null || nextVersion === null) return true;
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
    const record = loadPage(userId, pageId, recordSourceId);
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
    const record = loadPage(userId, pageId, recordSourceId);
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
    const record = loadPage(userId, pageId, recordSourceId);
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
    const record = loadPage(userId, pageId, recordSourceId);
    if (!record) return true;
    record.title = null;
    return writePage(record);
  }

  function removeBlock(userId, pageId, blockId, recordSourceId) {
    const record = loadPage(userId, pageId, recordSourceId);
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
    const pagePrefix = getPagePrefix(userId, pageId);
    try {
      const snapshot = snapshotStorageKeys();
      if (!snapshot.reliable) return false;
      const keys = snapshot.keys.filter((key) => key.startsWith(pagePrefix));
      for (const key of keys) storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  function clearPages(userId, pageIds) {
    let succeeded = true;
    for (const pageId of pageIds ?? []) succeeded = clearPage(userId, pageId) && succeeded;
    return succeeded;
  }

  function clearUser(userId) {
    if (!storage || !isNonEmptyString(userId)) return false;
    const userPrefix = getUserPrefix(userId);
    try {
      const snapshot = snapshotStorageKeys();
      if (!snapshot.reliable) return false;
      const keys = snapshot.keys.filter((key) => key.startsWith(userPrefix));
      for (const key of keys) storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
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
