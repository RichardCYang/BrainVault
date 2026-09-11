import { inspectStorageKeys } from "./storage-snapshot.js";

const draftSchemaVersion = 2;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// Recovery records have already crossed JSON decoding. Coercing strings or
// synthesizing missing timestamps here would make a malformed record appear
// writable and let an unrelated mutation destroy its original recovery bytes.
function normalizeVersion(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function normalizeRevision(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function normalizeUpdatedAt(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeTitleDraft(value) {
  if (!hasOnlyKnownEnumerableDataProperties(value, titleDraftKeys)) return null;
  const revision = normalizeRevision(value.revision);
  const expectedVersion = normalizeVersion(value.expectedVersion);
  const updatedAt = normalizeUpdatedAt(value.updatedAt);
  if (
    typeof value.value !== "string"
    || revision === null
    || expectedVersion === null
    || updatedAt === null
  ) return null;
  return { value: value.value, revision, expectedVersion, updatedAt };
}

const titleDraftKeys = new Set(["value", "revision", "expectedVersion", "updatedAt"]);
const blockDraftKeys = new Set(["payload", "revision", "expectedVersion", "updatedAt"]);
const blockDraftPayloadKeys = new Set(["type", "markdown", "checked", "metadata"]);
const blockOrderDraftKeys = new Set([
  "parentBlockId",
  "orderedIds",
  "previousIds",
  "mutationId",
  "items",
  "updatedAt"
]);
const blockOrderItemKeys = new Set(["id", "sortOrder", "parentBlockId", "expectedVersion"]);
const pageDraftRecordKeys = new Set([
  "schemaVersion",
  "userId",
  "pageId",
  "sourceId",
  "updatedAt",
  "title",
  "blocks",
  "blockOrder"
]);

function createBlockDraftMap() {
  // Resource ids are valid object keys, including names inherited from Object.prototype.
  // A null-prototype map makes every dynamic lookup own-data-only by construction.
  return Object.create(null);
}

// JSON.parse() keeps only one value when an object contains duplicate names.
// Recovery is an evidence-preservation boundary, so detect duplicates in the raw
// JSON before normalization can erase a shadowed title, block, or metadata field.
function hasDuplicateJsonObjectKeys(raw) {
  let index = 0;

  const skipWhitespace = () => {
    while (
      raw[index] === " "
      || raw[index] === "\t"
      || raw[index] === "\r"
      || raw[index] === "\n"
    ) {
      index += 1;
    }
  };

  const scanString = (decode = false) => {
    const start = index;
    index += 1;
    while (index < raw.length) {
      if (raw[index] === "\\") {
        index += 2;
        continue;
      }
      if (raw[index] === "\"") {
        index += 1;
        return decode ? JSON.parse(raw.slice(start, index)) : null;
      }
      index += 1;
    }
    throw new SyntaxError("Unterminated JSON string");
  };

  const scanPrimitive = () => {
    while (
      index < raw.length
      && raw[index] !== ","
      && raw[index] !== "]"
      && raw[index] !== "}"
      && raw[index] !== " "
      && raw[index] !== "\t"
      && raw[index] !== "\r"
      && raw[index] !== "\n"
    ) {
      index += 1;
    }
  };

  function scanValue() {
    skipWhitespace();
    if (raw[index] === "{") return scanObject();
    if (raw[index] === "[") return scanArray();
    if (raw[index] === "\"") {
      scanString();
      return false;
    }
    scanPrimitive();
    return false;
  }

  function scanObject() {
    index += 1;
    skipWhitespace();
    if (raw[index] === "}") {
      index += 1;
      return false;
    }

    const names = new Set();
    while (index < raw.length) {
      skipWhitespace();
      const name = scanString(true);
      if (names.has(name)) return true;
      names.add(name);

      skipWhitespace();
      index += 1; // colon; JSON.parse() already validated the grammar.
      if (scanValue()) return true;

      skipWhitespace();
      if (raw[index] === "}") {
        index += 1;
        return false;
      }
      index += 1; // comma
    }
    return false;
  }

  function scanArray() {
    index += 1;
    skipWhitespace();
    if (raw[index] === "]") {
      index += 1;
      return false;
    }

    while (index < raw.length) {
      if (scanValue()) return true;
      skipWhitespace();
      if (raw[index] === "]") {
        index += 1;
        return false;
      }
      index += 1; // comma
    }
    return false;
  }

  return scanValue();
}

function parseRecoveryJson(raw) {
  try {
    const value = JSON.parse(raw);
    if (hasDuplicateJsonObjectKeys(raw)) return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function hasOnlyKnownEnumerableDataProperties(value, allowedKeys) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;

    const ownPropertyNames = Object.getOwnPropertyNames(value);
    const enumerableKeys = Object.keys(value);
    if (
      ownPropertyNames.length !== enumerableKeys.length
      || ownPropertyNames.some((key, index) => key !== enumerableKeys[index])
      || enumerableKeys.some((key) => !allowedKeys.has(key))
    ) {
      return false;
    }

    return enumerableKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(
        descriptor?.enumerable
        && Object.prototype.hasOwnProperty.call(descriptor, "value")
      );
    });
  } catch {
    return false;
  }
}

function cloneLosslessJsonValue(root) {
  const pending = [];
  const seen = new WeakSet();
  let clonedRoot;

  pending.push({
    source: root,
    assign(value) {
      clonedRoot = value;
    }
  });

  try {
    while (pending.length) {
      const { source: value, assign } = pending.pop();
      if (value === null || typeof value === "string" || typeof value === "boolean") {
        assign(value);
        continue;
      }
      if (typeof value === "number") {
        // JSON.stringify(-0) emits 0, and integers outside the safe range may
        // already have been rounded by JSON.parse. Accepting either case would
        // silently change metadata at the recovery persistence boundary.
        if (
          !Number.isFinite(value)
          || Object.is(value, -0)
          || (Number.isInteger(value) && !Number.isSafeInteger(value))
        ) {
          return { ok: false };
        }
        assign(value);
        continue;
      }
      if (!value || typeof value !== "object") return { ok: false };
      if (seen.has(value)) return { ok: false };
      seen.add(value);

      if (Array.isArray(value)) {
        if (Object.getOwnPropertySymbols(value).length > 0) return { ok: false };
        const ownPropertyNames = Object.getOwnPropertyNames(value);
        const enumerableKeys = Object.keys(value);
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (
          !lengthDescriptor
          || !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0
        ) {
          return { ok: false };
        }
        const length = lengthDescriptor.value;
        // A JSON array can preserve only its indexed values. Reject sparse arrays,
        // hidden/extra properties, and accessor-backed indexes instead of dropping
        // data or invoking user-defined getters during recovery admission.
        if (
          ownPropertyNames.length !== length + 1
          || ownPropertyNames[ownPropertyNames.length - 1] !== "length"
          || enumerableKeys.length !== length
        ) {
          return { ok: false };
        }

        const clone = new Array(length);
        assign(clone);
        for (let index = length - 1; index >= 0; index -= 1) {
          const key = String(index);
          if (ownPropertyNames[index] !== key || enumerableKeys[index] !== key) return { ok: false };
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (
            !descriptor?.enumerable
            || !Object.prototype.hasOwnProperty.call(descriptor, "value")
          ) {
            return { ok: false };
          }
          pending.push({
            source: descriptor.value,
            assign(clonedValue) {
              clone[index] = clonedValue;
            }
          });
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return { ok: false };
      if (Object.getOwnPropertySymbols(value).length > 0) return { ok: false };
      const ownPropertyNames = Object.getOwnPropertyNames(value);
      const enumerableKeys = Object.keys(value);
      if (
        ownPropertyNames.length !== enumerableKeys.length
        || ownPropertyNames.some((key, index) => key !== enumerableKeys[index])
      ) {
        return { ok: false };
      }

      const clone = {};
      assign(clone);
      // Queue in reverse so assignment happens in the original JSON key order.
      for (let index = enumerableKeys.length - 1; index >= 0; index -= 1) {
        const key = enumerableKeys[index];
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          return { ok: false };
        }
        pending.push({
          source: descriptor.value,
          assign(clonedValue) {
            Object.defineProperty(clone, key, {
              value: clonedValue,
              enumerable: true,
              configurable: true,
              writable: true
            });
          }
        });
      }
    }
  } catch {
    // Proxies and exotic objects can throw from reflective operations. Recovery
    // validation must fail closed rather than let that exception interrupt draft
    // persistence or replace the last known-good recovery record.
    return { ok: false };
  }

  return { ok: true, value: clonedRoot };
}
function normalizeBlockDraftPayload(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;

    const ownPropertyNames = Object.getOwnPropertyNames(value);
    if (
      ownPropertyNames.length !== blockDraftPayloadKeys.size
      || ownPropertyNames.some((key) => !blockDraftPayloadKeys.has(key))
    ) {
      return null;
    }

    const captured = {};
    for (const key of blockDraftPayloadKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return null;
      captured[key] = descriptor.value;
    }

    if (
      !isNonEmptyString(captured.type)
      || typeof captured.markdown !== "string"
      || typeof captured.checked !== "boolean"
    ) {
      return null;
    }

    let metadata = null;
    if (captured.metadata !== null) {
      if (
        !captured.metadata
        || typeof captured.metadata !== "object"
        || Array.isArray(captured.metadata)
      ) {
        return null;
      }
      const clonedMetadata = cloneLosslessJsonValue(captured.metadata);
      if (!clonedMetadata.ok) return null;
      metadata = clonedMetadata.value;
    }

    return {
      type: captured.type,
      markdown: captured.markdown,
      checked: captured.checked,
      metadata
    };
  } catch {
    // Treat reflective failures on the payload itself like invalid recovery data.
    // The caller will leave any existing durable record untouched.
    return null;
  }
}
function normalizeBlockDraft(value) {
  if (!hasOnlyKnownEnumerableDataProperties(value, blockDraftKeys)) return null;
  const revision = normalizeRevision(value.revision);
  const expectedVersion = normalizeVersion(value.expectedVersion);
  const updatedAt = normalizeUpdatedAt(value.updatedAt);
  const payload = normalizeBlockDraftPayload(value.payload);
  if (revision === null || expectedVersion === null || updatedAt === null || !payload) return null;
  return { payload, revision, expectedVersion, updatedAt };
}

function normalizeParentBlockId(value) {
  if (value === null) return null;
  return isNonEmptyString(value) ? value : undefined;
}

function normalizeBlockOrderDraft(value) {
  if (!hasOnlyKnownEnumerableDataProperties(value, blockOrderDraftKeys)) return null;
  const parentBlockId = normalizeParentBlockId(value.parentBlockId);
  if (parentBlockId === undefined || !isNonEmptyString(value.mutationId)) return null;
  if (!Array.isArray(value.orderedIds) || value.orderedIds.length === 0) return null;
  if (!Array.isArray(value.items) || value.items.length !== value.orderedIds.length) return null;

  const orderedIds = value.orderedIds.every(isNonEmptyString) ? [...value.orderedIds] : null;
  if (!orderedIds || new Set(orderedIds).size !== orderedIds.length) return null;

  const items = [];
  for (let index = 0; index < value.items.length; index += 1) {
    const item = value.items[index];
    if (!hasOnlyKnownEnumerableDataProperties(item, blockOrderItemKeys)) return null;
    const itemParentBlockId = normalizeParentBlockId(item.parentBlockId);
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

  const updatedAt = normalizeUpdatedAt(value.updatedAt);
  if (updatedAt === null) return null;
  return {
    parentBlockId,
    orderedIds,
    previousIds,
    mutationId: value.mutationId,
    items,
    updatedAt
  };
}

function normalizeRecord(value, userId, pageId, expectedSourceId = null) {
  // Every accepted record can later be rewritten by an acknowledgement,
  // save, or delete. Reject unknown/hidden/accessor-backed wrapper fields
  // instead of projecting them away and silently deleting recovery data
  // written by a newer build or left by a partially damaged record.
  if (!hasOnlyKnownEnumerableDataProperties(value, pageDraftRecordKeys)) return null;
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

  const blocks = createBlockDraftMap();
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

  const updatedAt = normalizeUpdatedAt(value.updatedAt);
  if (!title && !blockOrder && Object.keys(blocks).length === 0) return null;
  if (updatedAt === null) return null;
  return {
    schemaVersion: draftSchemaVersion,
    userId,
    pageId,
    sourceId: value.sourceId,
    updatedAt,
    title,
    blocks,
    blockOrder
  };
}

function cloneDraftRecord(record) {
  return record ? JSON.parse(JSON.stringify(record)) : null;
}

function normalizeExpectedRecordSnapshot(value) {
  // Cleanup candidates are deletion authorities for recovery data. Snapshot
  // them through the same lossless JSON boundary as stored drafts so custom
  // toJSON hooks, accessors, Proxies, or hidden fields cannot impersonate a
  // different durable record during an equality check.
  const snapshot = cloneLosslessJsonValue(value);
  if (!snapshot.ok || !snapshot.value || typeof snapshot.value !== "object" || Array.isArray(snapshot.value)) {
    return null;
  }
  const candidate = snapshot.value;
  if (
    !isNonEmptyString(candidate.userId)
    || !isNonEmptyString(candidate.pageId)
    || !isNonEmptyString(candidate.sourceId)
  ) {
    return null;
  }
  return normalizeRecord(candidate, candidate.userId, candidate.pageId, candidate.sourceId);
}

function getOwnBlockDraft(record, blockId) {
  if (!record?.blocks || !Object.prototype.hasOwnProperty.call(record.blocks, blockId)) return null;
  return record.blocks[blockId];
}

function storedRecordMatchesExpected(storedValue, expectedRecord) {
  if (typeof storedValue !== "string") return false;
  const normalizedExpected = normalizeExpectedRecordSnapshot(expectedRecord);
  if (!normalizedExpected) return false;
  const parsed = parseRecoveryJson(storedValue);
  if (!parsed.ok) return false;
  try {
    const current = normalizeRecord(
      parsed.value,
      normalizedExpected.userId,
      normalizedExpected.pageId,
      normalizedExpected.sourceId
    );
    return Boolean(current) && JSON.stringify(current) === JSON.stringify(normalizedExpected);
  } catch {
    return false;
  }
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
      const parsed = parseRecoveryJson(raw);
      if (!parsed.ok) return { record: null, unreadable: true };
      const record = normalizeRecord(parsed.value, userId, pageId, expectedSourceId);
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

  function writePage(record, expectedRecord = null) {
    if (!storage) return false;
    const hasTitle = Boolean(record.title);
    const hasBlocks = Object.keys(record.blocks ?? {}).length > 0;
    const hasBlockOrder = Boolean(record.blockOrder);
    const key = getKey(record.userId, record.pageId, record.sourceId);
    // Re-check immediately before every write/removal. A present unreadable
    // record is potentially the only recovery copy and must never be replaced.
    if (inspectRecordByKey(key, record.userId, record.pageId, record.sourceId).unreadable) return false;

    let nextValue;
    try {
      nextValue = !hasTitle && !hasBlocks && !hasBlockOrder
        ? null
        : JSON.stringify({ ...record, updatedAt: Date.now() });
    } catch {
      // Recovery persistence is a data-preservation boundary. Unexpected values
      // must fail closed rather than escaping as an exception or partially
      // replacing the only durable recovery copy.
      return false;
    }

    // Recovery reconciliation intentionally inspects drafts created by other tabs.
    // Its synchronous mirror can lag a newer IndexedDB commit from that tab, so a
    // read/modify/write against a foreign source must be an atomic durable CAS.
    // Otherwise acknowledging one stale component can overwrite unrelated newer
    // unsaved edits that share the same page-draft record.
    if (record.sourceId !== sourceId) {
      if (!expectedRecord || expectedRecord.sourceId !== record.sourceId) return false;
      const matchesExpected = (storedValue) => storedRecordMatchesExpected(storedValue, expectedRecord);
      try {
        if (nextValue === null) {
          if (typeof storage.compareAndRemove !== "function") return false;
          void storage.compareAndRemove(key, matchesExpected).catch(() => undefined);
        } else {
          if (typeof storage.compareAndSet !== "function") return false;
          void storage.compareAndSet(key, matchesExpected, nextValue).catch(() => undefined);
        }
        return true;
      } catch {
        return false;
      }
    }

    try {
      if (nextValue === null) storage.removeItem(key);
      else storage.setItem(key, nextValue);
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
      blocks: createBlockDraftMap(),
      blockOrder: null
    };
  }

  function prepareRecordMutation(userId, pageId, recordSourceId, { createIfMissing = false } = {}) {
    if (
      !isNonEmptyString(userId) ||
      !isNonEmptyString(pageId) ||
      !isNonEmptyString(recordSourceId)
    ) {
      return { record: null, expectedRecord: null, writable: false };
    }
    const inspection = inspectRecordByKey(
      getKey(userId, pageId, recordSourceId),
      userId,
      pageId,
      recordSourceId
    );
    if (inspection.unreadable) return { record: null, expectedRecord: null, writable: false };
    return {
      record: inspection.record ?? (createIfMissing ? createRecord(userId, pageId, recordSourceId) : null),
      expectedRecord: cloneDraftRecord(inspection.record),
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
    return writePage(record, prepared.expectedRecord);
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
    const normalizedPayload = normalizeBlockDraftPayload(payload);
    if (!normalizedPayload || normalizedVersion === null || normalizedRevision === null) return false;
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId, { createIfMissing: true });
    if (!prepared.writable || !prepared.record) return false;
    const record = prepared.record;
    const updatedAt = Date.now();
    // Resource identifiers are allowed to contain names such as "__proto__".
    // Define an own data property explicitly so recovery never routes a draft
    // through Object.prototype setters or silently drops it from JSON storage.
    Object.defineProperty(record.blocks, blockId, {
      value: {
        payload: normalizedPayload,
        expectedVersion: normalizedVersion,
        revision: normalizedRevision,
        updatedAt
      },
      enumerable: true,
      configurable: true,
      writable: true
    });
    record.updatedAt = updatedAt;
    return writePage(record, prepared.expectedRecord);
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
    return writePage(record, prepared.expectedRecord);
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
    return writePage(record, prepared.expectedRecord);
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
    const draft = getOwnBlockDraft(record, blockId);
    if (!record || !draft) return true;
    if (draft.revision <= acknowledgedRevision) delete record.blocks[blockId];
    else draft.expectedVersion = nextVersion;
    return writePage(record, prepared.expectedRecord);
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
    return writePage(record, prepared.expectedRecord);
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
    return writePage(record, prepared.expectedRecord);
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
    const normalizedPayload = normalizeBlockDraftPayload(payload);
    if (
      !isNonEmptyString(userId) ||
      !isNonEmptyString(pageId) ||
      !isNonEmptyString(blockId) ||
      !isNonEmptyString(recordSourceId) ||
      !normalizedPayload ||
      normalizedVersion === null ||
      normalizedRevision === null
    ) {
      return false;
    }
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId);
    if (!prepared.writable) return false;
    const record = prepared.record;
    const draft = getOwnBlockDraft(record, blockId);
    if (!record || !draft) return true;
    if (
      draft.expectedVersion !== normalizedVersion ||
      draft.revision !== normalizedRevision ||
      JSON.stringify(draft.payload) !== JSON.stringify(normalizedPayload)
    ) {
      return true;
    }
    delete record.blocks[blockId];
    return writePage(record, prepared.expectedRecord);
  }

  function removeTitle(userId, pageId, recordSourceId) {
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId);
    if (!prepared.writable) return false;
    const record = prepared.record;
    if (!record) return true;
    record.title = null;
    return writePage(record, prepared.expectedRecord);
  }

  function removeBlock(userId, pageId, blockId, recordSourceId) {
    const prepared = prepareRecordMutation(userId, pageId, recordSourceId);
    if (!prepared.writable) return false;
    const record = prepared.record;
    if (!record) return true;
    delete record.blocks[blockId];
    if (record.blockOrder?.orderedIds.includes(blockId)) record.blockOrder = null;
    return writePage(record, prepared.expectedRecord);
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
    const record = prepared.record;
    record.title = null;
    record.blocks = createBlockDraftMap();
    record.blockOrder = null;
    return writePage(record, prepared.expectedRecord);
  }

  function removePageIfUnchanged(expectedRecord) {
    const normalizedExpected = normalizeExpectedRecordSnapshot(expectedRecord);
    if (!normalizedExpected) return false;
    const prepared = prepareRecordMutation(
      normalizedExpected.userId,
      normalizedExpected.pageId,
      normalizedExpected.sourceId
    );
    if (!prepared.writable) return false;
    if (!prepared.record) return true;
    // A server upload can overlap a newer local edit. Delete only the exact
    // validated record that was uploaded; otherwise retain browser recovery.
    if (JSON.stringify(prepared.record) !== JSON.stringify(normalizedExpected)) return false;
    const record = prepared.record;
    record.title = null;
    record.blocks = createBlockDraftMap();
    record.blockOrder = null;
    return writePage(record, prepared.expectedRecord);
  }


  async function removePageIfUnchangedDurably(expectedRecord) {
    if (typeof storage?.compareAndRemove !== "function") return false;
    const normalizedExpected = normalizeExpectedRecordSnapshot(expectedRecord);
    if (!normalizedExpected) return false;

    const key = getKey(
      normalizedExpected.userId,
      normalizedExpected.pageId,
      normalizedExpected.sourceId
    );
    return storage.compareAndRemove(
      key,
      (storedValue) => storedRecordMatchesExpected(storedValue, normalizedExpected)
    );
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
      const expectedRecord = cloneDraftRecord(record);
      for (const blockId of removedIds) delete record.blocks[blockId];
      if (record.blockOrder?.orderedIds.some((blockId) => removedIds.has(blockId))) record.blockOrder = null;
      succeeded = writePage(record, expectedRecord) && succeeded;
    }
    return succeeded;
  }

  function clearPage(userId, pageId) {
    if (!storage || !isNonEmptyString(userId) || !isNonEmptyString(pageId)) return false;
    const inspection = inspectPageDrafts(userId, pageId);
    if (!inspection.reliable || inspection.unreadableKeys.length) return false;
    let succeeded = true;
    for (const record of inspection.records) {
      // Cleanup must stay bound to the record that was inspected. Re-reading
      // by source id and deleting that newer value can erase another tab's
      // unsaved edit if it lands between enumeration and cleanup.
      succeeded = removePageIfUnchanged(record) && succeeded;
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
      // Keep account-wide cleanup snapshot-bound for the same cross-tab race
      // handled by clearPage(). A newer record is preserved and cleanup fails
      // closed instead of adopting the newer draft as deletion authority.
      succeeded = removePageIfUnchanged(record) && succeeded;
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
    removePageIfUnchanged,
    removePageIfUnchangedDurably,
    removePages,
    clearBlocks,
    clearPage,
    clearPages,
    clearUser
  };
}
