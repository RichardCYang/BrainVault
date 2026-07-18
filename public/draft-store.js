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
  const blocks = {};
  if (value.blocks && typeof value.blocks === "object" && !Array.isArray(value.blocks)) {
    for (const [blockId, blockDraft] of Object.entries(value.blocks)) {
      if (!isNonEmptyString(blockId)) continue;
      const normalized = normalizeBlockDraft(blockDraft);
      if (normalized) blocks[blockId] = normalized;
    }
  }

  if (!title && Object.keys(blocks).length === 0) return null;
  return {
    schemaVersion: draftSchemaVersion,
    userId,
    pageId,
    sourceId: value.sourceId,
    updatedAt: normalizeUpdatedAt(value.updatedAt),
    title,
    blocks
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

  function readRecordByKey(key, userId, pageId, expectedSourceId = null) {
    if (!storage) return null;
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      return normalizeRecord(JSON.parse(raw), userId, pageId, expectedSourceId);
    } catch {
      return null;
    }
  }

  function loadPage(userId, pageId, recordSourceId = sourceId) {
    if (!storage || !isNonEmptyString(userId) || !isNonEmptyString(pageId) || !isNonEmptyString(recordSourceId)) {
      return null;
    }
    return readRecordByKey(getKey(userId, pageId, recordSourceId), userId, pageId, recordSourceId);
  }

  function loadPageDrafts(userId, pageId) {
    if (!storage || !isNonEmptyString(userId) || !isNonEmptyString(pageId)) return [];
    const pagePrefix = getPagePrefix(userId, pageId);
    try {
      const records = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key?.startsWith(pagePrefix)) continue;
        const record = readRecordByKey(key, userId, pageId);
        if (record) records.push(record);
      }
      return records.sort((left, right) => right.updatedAt - left.updatedAt);
    } catch {
      return [];
    }
  }

  function loadUserDrafts(userId) {
    if (!storage || !isNonEmptyString(userId)) return [];
    const userPrefix = getUserPrefix(userId);
    try {
      const records = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key?.startsWith(userPrefix)) continue;
        try {
          const raw = storage.getItem(key);
          if (!raw) continue;
          const value = JSON.parse(raw);
          const pageId = value?.pageId;
          if (!isNonEmptyString(pageId)) continue;
          const record = normalizeRecord(value, userId, pageId);
          if (record) records.push(record);
        } catch {
          // One corrupt record must not hide every other recoverable draft.
        }
      }
      return records.sort((left, right) => right.updatedAt - left.updatedAt);
    } catch {
      return [];
    }
  }

  function writePage(record) {
    if (!storage) return false;
    const hasTitle = Boolean(record.title);
    const hasBlocks = Object.keys(record.blocks ?? {}).length > 0;
    const key = getKey(record.userId, record.pageId, record.sourceId);
    try {
      if (!hasTitle && !hasBlocks) storage.removeItem(key);
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
      blocks: {}
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
    let succeeded = true;
    for (const record of loadPageDrafts(userId, pageId)) {
      for (const blockId of blockIds ?? []) delete record.blocks[blockId];
      succeeded = writePage(record) && succeeded;
    }
    return succeeded;
  }

  function clearPage(userId, pageId) {
    if (!storage || !isNonEmptyString(userId) || !isNonEmptyString(pageId)) return false;
    const pagePrefix = getPagePrefix(userId, pageId);
    try {
      const keys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(pagePrefix)) keys.push(key);
      }
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
      const keys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(userPrefix)) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  return {
    sourceId,
    loadPage,
    loadPageDrafts,
    loadUserDrafts,
    saveTitle,
    saveBlock,
    acknowledgeTitle,
    acknowledgeBlock,
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
