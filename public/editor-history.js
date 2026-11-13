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
  let nextEntryId = 1;

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
    // Baselines are already private clones and are never mutated in place.
    // Reuse that immutable snapshot; cloning it on every keystroke only creates
    // another full copy of the same structured block.
    const beforeValue = before;
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
      // The new entry owns a defensive clone. Sharing it internally is safe:
      // coalescing replaces snapshots, while peek() still returns a deep copy.
      baselines.set(key, next.after);
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

    commit(pageId, direction, { id = null, meta } = {}) {
      ensurePage(pageId);
      const from = direction === "redo" ? redoStack : undoStack;
      const to = direction === "redo" ? undoStack : redoStack;
      const index = id === null ? from.length - 1 : from.findIndex((candidate) => candidate.id === id);
      if (index < 0) return false;
      const [entry] = from.splice(index, 1);
      if (meta !== undefined) entry.meta = cloneHistoryValue(meta);
      if (index !== from.length) {
        // Newer edits landed while an asynchronous step was applied. That step
        // is done, but replaying it out of order later would be wrong.
        retainedBytes -= entry.bytes;
        captureEpoch += 1;
        return true;
      }
      to.push(entry);
      // Entries own private snapshots; peek() clones before exposing them.
      // Reuse those snapshots as baselines just as record() does, rather than
      // deep-cloning an unchanged block on every undo/redo transition.
      if (!entry.structural) baselines.set(entry.key, direction === "redo" ? entry.after : entry.before);
      captureEpoch += 1;
      return true;
    },

    discard(pageId, direction, { id = null } = {}) {
      ensurePage(pageId);
      const stack = direction === "redo" ? redoStack : undoStack;
      const index = id === null ? stack.length - 1 : stack.findIndex((candidate) => candidate.id === id);
      if (index < 0) return false;
      const [entry] = stack.splice(index, 1);
      retainedBytes -= entry.bytes;
      if (!entry.structural) baselines.delete(entry.key);
      captureEpoch += 1;
      return true;
    },

    /**
     * Records a step that changes the page structure (a block created, removed,
     * split, joined, or moved). It has no before/after value: the caller applies
     * it and validates the page itself, and may replace `meta` on commit.
     */
    push({ pageId, meta = null, now = Date.now() }) {
      ensurePage(pageId);
      const timestamp = Number.isFinite(now) ? Number(now) : Date.now();
      // Only structural steps carry an id: they finish asynchronously and are
      // committed by id. Text steps keep their original shape.
      const id = nextEntryId++;
      const entry = buildEntry({ key: `structure:${id}`, before: null, after: null, meta, captureGroup: null, timestamp });
      entry.id = id;
      entry.structural = true;
      clearRedo();
      if (!Number.isFinite(entry.bytes) || entry.bytes > byteLimit) {
        captureEpoch += 1;
        return null;
      }
      undoStack.push(entry);
      retainedBytes += entry.bytes;
      captureEpoch += 1;
      trimUndo();
      return entry.id;
    },

    /** Moves a field's baseline to a value reached without a recorded step. */
    rebase(pageId, key, value) {
      ensurePage(pageId);
      if (!key) return false;
      baselines.set(key, cloneHistoryValue(value));
      captureEpoch += 1;
      return true;
    },

    /**
     * Drops every step for the given fields and their baselines. Used when a
     * collaborator changed them: replaying a local snapshot there could
     * overwrite their newer content, while other fields stay undoable.
     */
    forget(pageId, keys) {
      ensurePage(pageId);
      const keySet = new Set(keys ?? []);
      if (!keySet.size) return 0;
      let removed = 0;
      const keep = (entry) => {
        if (entry.structural || !keySet.has(entry.key)) return true;
        retainedBytes -= entry.bytes;
        removed += 1;
        return false;
      };
      undoStack = undoStack.filter(keep);
      redoStack = redoStack.filter(keep);
      for (const key of keySet) baselines.delete(key);
      captureEpoch += 1;
      return removed;
    },

    /** Removes one step by id from either stack, e.g. after it was undone elsewhere. */
    remove(pageId, id) {
      ensurePage(pageId);
      for (const stack of [undoStack, redoStack]) {
        const index = stack.findIndex((entry) => entry.id === id);
        if (index < 0) continue;
        const [entry] = stack.splice(index, 1);
        retainedBytes -= entry.bytes;
        captureEpoch += 1;
        return true;
      }
      return false;
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
