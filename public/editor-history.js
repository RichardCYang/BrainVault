// @ts-check

function cloneHistoryValue(value) {
  if (value === undefined) return null;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function serializeHistoryValue(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function estimateSerializedBytes(serialized) {
  if (serialized === null) return Number.POSITIVE_INFINITY;
  if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).byteLength;
  return serialized.length * 2;
}

function valuesMatch(left, right) {
  const leftSerialized = serializeHistoryValue(left);
  if (leftSerialized === null) return false;
  return leftSerialized === serializeHistoryValue(right);
}

/**
 * Bounded in-memory editor history. It intentionally stores no browser-persistent
 * state: durable writes remain the responsibility of the existing draft/save and
 * collaboration recovery paths.
 */
export function createEditorHistory({
  maxEntries = 80,
  maxBytes = 8 * 1024 * 1024,
  captureTimeout = 600
} = {}) {
  const entryLimit = Math.max(1, Math.trunc(maxEntries) || 1);
  const byteLimit = Math.max(1024, Math.trunc(maxBytes) || 1024);
  const timeout = Math.max(0, Math.trunc(captureTimeout) || 0);

  let activePageId = null;
  let undoStack = [];
  let redoStack = [];
  let baselines = new Map();
  let retainedBytes = 0;
  let captureEpoch = 0;

  const resetState = (pageId = null) => {
    activePageId = pageId ?? null;
    undoStack = [];
    redoStack = [];
    baselines = new Map();
    retainedBytes = 0;
    captureEpoch += 1;
  };

  const ensurePage = (pageId) => {
    const normalized = pageId ?? null;
    if (activePageId !== normalized) resetState(normalized);
    return normalized;
  };

  const clearRedo = () => {
    for (const entry of redoStack) retainedBytes -= entry.bytes;
    redoStack = [];
  };

  const trimUndo = () => {
    while (undoStack.length > entryLimit || retainedBytes > byteLimit) {
      const removed = undoStack.shift();
      if (!removed) break;
      retainedBytes -= removed.bytes;
    }
  };

  const buildEntry = ({ key, before, after, meta, captureGroup, timestamp }) => {
    const beforeValue = cloneHistoryValue(before);
    const afterValue = cloneHistoryValue(after);
    const normalizedCaptureGroup = typeof captureGroup === "string" && captureGroup ? captureGroup : null;
    const bytes = estimateSerializedBytes(serializeHistoryValue({
      before: beforeValue,
      after: afterValue,
      meta,
      captureGroup: normalizedCaptureGroup
    }));
    return {
      key,
      before: beforeValue,
      after: afterValue,
      meta: cloneHistoryValue(meta ?? null),
      captureGroup: normalizedCaptureGroup,
      timestamp,
      captureEpoch,
      bytes
    };
  };

  return {
    setPage(pageId) {
      ensurePage(pageId);
    },

    clear(pageId = activePageId) {
      resetState(pageId ?? null);
    },

    stopCapturing() {
      captureEpoch += 1;
    },

    seed(pageId, key, value) {
      ensurePage(pageId);
      if (!key || baselines.has(key)) return false;
      baselines.set(key, cloneHistoryValue(value));
      return true;
    },

    record({ pageId, key, value, meta = null, captureGroup = key, coalesce = true, now = Date.now() }) {
      ensurePage(pageId);
      if (!key) return false;
      if (!baselines.has(key)) {
        baselines.set(key, cloneHistoryValue(value));
        return false;
      }

      const before = baselines.get(key);
      if (valuesMatch(before, value)) return false;

      const timestamp = Number.isFinite(now) ? Number(now) : Date.now();
      const next = buildEntry({ key, before, after: value, meta, captureGroup, timestamp });
      baselines.set(key, cloneHistoryValue(value));
      clearRedo();

      if (!Number.isFinite(next.bytes) || next.bytes > byteLimit) {
        captureEpoch += 1;
        return false;
      }

      const previous = undoStack.at(-1);
      if (
        coalesce
        && previous
        && previous.key === key
        && previous.captureGroup === next.captureGroup
        && previous.captureEpoch === captureEpoch
        && timestamp - previous.timestamp >= 0
        && timestamp - previous.timestamp <= timeout
      ) {
        retainedBytes -= previous.bytes;
        previous.after = next.after;
        previous.meta = next.meta;
        previous.timestamp = timestamp;
        previous.bytes = estimateSerializedBytes(serializeHistoryValue({
          before: previous.before,
          after: previous.after,
          meta: previous.meta,
          captureGroup: previous.captureGroup
        }));
        retainedBytes += previous.bytes;
      } else {
        undoStack.push(next);
        retainedBytes += next.bytes;
      }

      trimUndo();
      return true;
    },

    peek(pageId, direction) {
      ensurePage(pageId);
      const stack = direction === "redo" ? redoStack : undoStack;
      const entry = stack.at(-1);
      return entry ? cloneHistoryValue(entry) : null;
    },

    commit(pageId, direction) {
      ensurePage(pageId);
      if (direction === "redo") {
        const entry = redoStack.pop();
        if (!entry) return false;
        undoStack.push(entry);
        baselines.set(entry.key, cloneHistoryValue(entry.after));
      } else {
        const entry = undoStack.pop();
        if (!entry) return false;
        redoStack.push(entry);
        baselines.set(entry.key, cloneHistoryValue(entry.before));
      }
      captureEpoch += 1;
      return true;
    },

    discard(pageId, direction) {
      ensurePage(pageId);
      const stack = direction === "redo" ? redoStack : undoStack;
      const entry = stack.pop();
      if (!entry) return false;
      retainedBytes -= entry.bytes;
      baselines.delete(entry.key);
      captureEpoch += 1;
      return true;
    },

    getState(pageId = activePageId) {
      ensurePage(pageId);
      return {
        pageId: activePageId,
        undoDepth: undoStack.length,
        redoDepth: redoStack.length,
        retainedBytes
      };
    }
  };
}
