// @ts-check
import {
  CollaborationRecoveryWriteError,
  commitPreparedCollaborationMutation
} from "./collaboration-durability.js";
import { reconcileCanonicalAttachment } from "./collaboration-attachment-reconcile.js";
import {
  requireBlockMarkdownWithinLimit,
  requirePageTitleWithinLimit
} from "./editor-content-limits.js";

const YJS_MODULE_URL = "/vendor/yjs/yjs.mjs";
const REMOTE_ORIGIN = Object.freeze({ kind: "remote" });
const BOOTSTRAP_ORIGIN = Object.freeze({ kind: "bootstrap" });
const LOCAL_ORIGIN = Object.freeze({ kind: "local" });
const PREPARED_LOCAL_ORIGIN = Object.freeze({ kind: "prepared-local" });
const RECOVERY_ORIGIN = Object.freeze({ kind: "recovery" });
const COMPACTION_UPDATE_THRESHOLD = 200;
const MATERIALIZE_DELAY_MS = 900;
const AWARENESS_DELAY_MS = 80;
const COLLABORATIVE_BLOCK_TYPES = new Set([
  "MARKDOWN",
  "HEADING_1",
  "HEADING_2",
  "HEADING_3",
  "TODO",
  "UNORDERED_LIST",
  "ORDERED_LIST",
  "QUOTE",
  "CALLOUT",
  "TOGGLE",
  "ACCORDION",
  "TABLE",
  "KANBAN",
  "DATABASE",
  "TREEVIEW",
  "TIMETABLE",
  "GANTT",
  "BOOKMARK",
  "AI_CHAT",
  "MATH",
  "MERMAID",
  "CODE",
  "DIVIDER",
  "IMAGE",
  "VIDEO",
  "ATTACHMENT"
]);

let yjsPromise = null;

async function loadYjs() {
  if (!yjsPromise) {
    yjsPromise = import(YJS_MODULE_URL).catch((error) => {
      yjsPromise = null;
      throw new Error(`Yjs could not be loaded: ${error?.message || error}`);
    });
  }
  return yjsPromise;
}

function createClientId(prefix = "blk") {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${value}`.slice(0, 64);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function replaceYText(text, value) {
  const next = String(value ?? "");
  const current = text.toString();
  if (current === next) return;
  let prefix = 0;
  while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < next.length - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix += 1;
  const deleteLength = current.length - prefix - suffix;
  const insertValue = next.slice(prefix, next.length - suffix);
  if (deleteLength) text.delete(prefix, deleteLength);
  if (insertValue) text.insert(prefix, insertValue);
}

function isYType(Y, value) {
  return value instanceof Y.Text || value instanceof Y.Array || value instanceof Y.Map;
}

function isCompatibleYValue(Y, current, value) {
  if (typeof value === "string") return current instanceof Y.Text;
  if (Array.isArray(value)) return current instanceof Y.Array;
  if (isPlainObject(value)) return current instanceof Y.Map;
  return !isYType(Y, current);
}

function createYValue(Y, value) {
  if (typeof value === "string") {
    const text = new Y.Text();
    if (value) text.insert(0, value);
    return text;
  }
  if (Array.isArray(value)) {
    const array = new Y.Array();
    if (value.length) array.insert(0, value.map((item) => createYValue(Y, item)));
    return array;
  }
  if (isPlainObject(value)) {
    const map = new Y.Map();
    for (const [key, item] of Object.entries(value)) map.set(key, createYValue(Y, item));
    return map;
  }
  return value === undefined ? null : value;
}

function reconcileYArray(Y, array, values) {
  const next = Array.isArray(values) ? values : [];
  while (array.length > next.length) array.delete(next.length, array.length - next.length);
  for (let index = 0; index < next.length; index += 1) {
    const current = array.get(index);
    if (index >= array.length) {
      array.insert(index, [createYValue(Y, next[index])]);
      continue;
    }
    if (!isCompatibleYValue(Y, current, next[index])) {
      array.delete(index, 1);
      array.insert(index, [createYValue(Y, next[index])]);
      continue;
    }
    reconcileYValue(Y, current, next[index], (replacement) => {
      array.delete(index, 1);
      array.insert(index, [replacement]);
    });
  }
}

function reconcileYMap(Y, map, value) {
  const source = isPlainObject(value) ? value : {};
  for (const key of [...map.keys()]) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) map.delete(key);
  }
  for (const [key, item] of Object.entries(source)) {
    const current = map.get(key);
    if (current === undefined || !isCompatibleYValue(Y, current, item)) {
      map.set(key, createYValue(Y, item));
      continue;
    }
    reconcileYValue(Y, current, item, (replacement) => map.set(key, replacement));
  }
}

function reconcileYValue(Y, current, value, replace) {
  if (current instanceof Y.Text) {
    replaceYText(current, value);
  } else if (current instanceof Y.Array) {
    reconcileYArray(Y, current, value);
  } else if (current instanceof Y.Map) {
    reconcileYMap(Y, current, value);
  } else if (!Object.is(current, value)) {
    replace(createYValue(Y, value));
  }
}

function readYValue(Y, value) {
  if (value instanceof Y.Text) return value.toString();
  if (value instanceof Y.Array) return value.toArray().map((item) => readYValue(Y, item));
  if (value instanceof Y.Map) {
    const result = {};
    for (const [key, item] of value.entries()) result[key] = readYValue(Y, item);
    return result;
  }
  return value ?? null;
}

function flattenBlocks(blocks) {
  const result = [];
  const stack = [...(blocks ?? [])].reverse();
  while (stack.length) {
    const block = stack.pop();
    if (!block?.id) continue;
    const { children, ...flat } = block;
    result.push(flat);
    if (Array.isArray(children)) {
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
  }
  return result;
}

function normalizeBlock(block) {
  const type = String(block?.type || "MARKDOWN");
  const numericSortOrder = Number(block?.sortOrder);
  return {
    id: String(block?.id || createClientId("blk")).slice(0, 64),
    type: COLLABORATIVE_BLOCK_TYPES.has(type) ? type : "MARKDOWN",
    markdown: requireBlockMarkdownWithinLimit(block?.markdown),
    checked: Boolean(block?.checked),
    parentBlockId: block?.parentBlockId ? String(block.parentBlockId).slice(0, 64) : null,
    sortOrder: Number.isFinite(numericSortOrder)
      ? Math.min(2_147_483_647, Math.max(0, Math.trunc(numericSortOrder)))
      : 0,
    metadata: isPlainObject(block?.metadata) ? block.metadata : null
  };
}

function plainValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => plainValuesEqual(item, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) =>
        key === rightKeys[index] && plainValuesEqual(left[key], right[key])
      );
  }
  return false;
}

export function matchesCollaborativeBlockSnapshot(currentBlock, expectedBlock) {
  if (!currentBlock?.id || !expectedBlock?.id) return false;
  const current = normalizeBlock(currentBlock);
  const expected = normalizeBlock(expectedBlock);
  return (
    current.id === expected.id
    && current.type === expected.type
    && current.markdown === expected.markdown
    && current.checked === expected.checked
    && current.parentBlockId === expected.parentBlockId
    && current.sortOrder === expected.sortOrder
    && plainValuesEqual(current.metadata, expected.metadata)
  );
}

export function matchesCollaborativeReplacementSource(currentBlock, expectedBlock) {
  return matchesCollaborativeBlockSnapshot(currentBlock, expectedBlock);
}

export function planCollaborativeBlockReplacement(
  snapshot,
  targetId,
  replacementBlock,
  { expectedSourceBlock = null, expectedReplacementBlock = null } = {}
) {
  const replacement = normalizeBlock(replacementBlock);
  const normalizedTargetId = String(targetId ?? "");
  if (!normalizedTargetId || replacement.id === normalizedTargetId) {
    throw new Error("A collaborative replacement must use a distinct block id");
  }

  // The upload endpoint broadcasts the canonical attachment before returning its
  // HTTP response, so the replacement may already exist in the Yjs document.
  // If a collaborator has moved or otherwise changed that attachment since the
  // broadcast, a delayed upload completion must not overwrite the newer Yjs state.
  const normalizedSnapshot = (snapshot ?? []).map(normalizeBlock);
  const currentReplacement = normalizedSnapshot.find((block) => block.id === replacement.id);
  if (
    expectedReplacementBlock
    && currentReplacement
    && !matchesCollaborativeBlockSnapshot(currentReplacement, expectedReplacementBlock)
  ) {
    return null;
  }

  // Exclude the unchanged canonical copy while locating the source block's actual slot.
  const preparedSnapshot = normalizedSnapshot.filter((block) => block.id !== replacement.id);
  const target = preparedSnapshot.find((block) => block.id === normalizedTargetId);
  if (!target) return null;
  if (expectedSourceBlock) {
    if (String(expectedSourceBlock?.id ?? "") !== normalizedTargetId) {
      throw new Error("The collaborative replacement source snapshot does not match the target block");
    }
    if (!matchesCollaborativeReplacementSource(target, expectedSourceBlock)) return null;
  }

  const children = preparedSnapshot
    .filter((block) => block.parentBlockId === normalizedTargetId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const siblings = preparedSnapshot
    .filter((block) => block.parentBlockId === target.parentBlockId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const targetIndex = siblings.findIndex((block) => block.id === normalizedTargetId);
  if (targetIndex < 0) throw new Error("The collaborative block hierarchy is inconsistent");

  const resultingSiblings = siblings.filter((block) => block.id !== normalizedTargetId);
  resultingSiblings.splice(
    targetIndex,
    0,
    { ...replacement, parentBlockId: target.parentBlockId },
    ...children
  );

  return {
    target,
    children,
    updates: resultingSiblings.map((block, sortOrder) => ({
      ...block,
      parentBlockId: target.parentBlockId,
      sortOrder
    }))
  };
}

function readDocumentSnapshot(Y, title, blocks, deletedAttachments, updateId = 0) {
  const normalizedBlocks = [];
  const blockIds = new Set();
  const deletedAttachmentIds = new Set(deletedAttachments.keys());
  for (const [id, value] of blocks.entries()) {
    if (!(value instanceof Y.Map)) continue;
    const plain = readYValue(Y, value);
    const normalized = normalizeBlock({ id, ...plain });
    // A tombstone wins over a concurrently retained/re-created block. This
    // keeps the SQL materialization payload internally consistent and avoids
    // resurrecting an attachment after its file has been removed.
    if (deletedAttachmentIds.has(normalized.id)) continue;
    if (!normalized.id || blockIds.has(normalized.id)) continue;
    blockIds.add(normalized.id);
    normalizedBlocks.push(normalized);
  }
  normalizedBlocks.sort((left, right) => {
    const leftParent = left.parentBlockId ?? "";
    const rightParent = right.parentBlockId ?? "";
    return leftParent.localeCompare(rightParent)
      || left.sortOrder - right.sortOrder
      || left.id.localeCompare(right.id);
  });
  return {
    title: requirePageTitleWithinLimit(title.toString()),
    blocks: normalizedBlocks,
    deletedAttachmentIds: [...deletedAttachmentIds].sort(),
    updateId
  };
}

function createBinaryMessage(kind, update, baseUpdateId = 0) {
  const bytes = update instanceof Uint8Array ? update : new Uint8Array(update);
  if (kind === 1) {
    const message = new Uint8Array(1 + bytes.byteLength);
    message[0] = 1;
    message.set(bytes, 1);
    return message;
  }
  const message = new Uint8Array(9 + bytes.byteLength);
  message[0] = 2;
  new DataView(message.buffer).setBigUint64(1, BigInt(baseUpdateId), false);
  message.set(bytes, 9);
  return message;
}

function websocketUrl(path) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class PageCollaborationSession {
  constructor(Y, options) {
    this.Y = Y;
    this.page = options.page;
    this.bootstrapPage = options.page;
    this.accountId = typeof options.accountId === "string" ? options.accountId : "";
    this.recoverySourceId = typeof options.recoverySourceId === "string" ? options.recoverySourceId : "";
    this.recoveryStore = options.recoveryStore ?? null;
    this.recoveredLocalRecords = [];
    this.currentRecoveryGeneration = null;
    this.recoveryCleanupQueue = Promise.resolve();
    this.recoveryStorageWarningShown = false;
    this.recoveryLineageWarningShown = false;
    this.documentEpoch = null;
    this.recoveryLoadedEpoch = null;
    this.api = options.api;
    this.onSnapshot = options.onSnapshot ?? (() => undefined);
    this.onPresence = options.onPresence ?? (() => undefined);
    this.onStatus = options.onStatus ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.onAccessChanged = options.onAccessChanged ?? (() => undefined);
    this.onMaterialized = options.onMaterialized ?? (() => undefined);
    this.onBeforeLocalRecoveryApply = options.onBeforeLocalRecoveryApply ?? (() => true);
    this.doc = new Y.Doc();
    this.localMutationDoc = null;
    this.title = this.doc.getText("title");
    this.blocks = this.doc.getMap("blocks");
    this.deletedAttachments = this.doc.getMap("deletedAttachments");
    this.socket = null;
    this.destroyed = false;
    this.synced = false;
    this.ready = false;
    this.connecting = false;
    this.connectionId = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.materializeTimer = null;
    this.awarenessTimer = null;
    this.lastAwareness = { blockId: null, field: null, control: null, selection: null };
    this.presence = new Map();
    this.lastUpdateId = 0;
    this.pendingLocalUpdates = 0;
    this.pendingWaiters = [];
    this.needsRecovery = false;
    this.startupUpdatePending = false;
    this.updatesSinceCompaction = 0;
    this.compactionPending = false;
    this.materializeQueue = Promise.resolve(null);
    this.localMutationQueue = Promise.resolve();
    this.pendingPreparedLocalMutations = 0;
    this.snapshotScheduledByUpdate = false;

    this.handleDocumentUpdate = (update, origin) => {
      const source = origin === REMOTE_ORIGIN ? "remote" : origin === BOOTSTRAP_ORIGIN ? "bootstrap" : "local";
      this.emitSnapshot(source);
      if (origin !== REMOTE_ORIGIN && origin !== BOOTSTRAP_ORIGIN && origin !== RECOVERY_ORIGIN) {
        // PREPARED_LOCAL_ORIGIN was persisted from an isolated staging document
        // before this live update became visible. Every other local-origin update
        // keeps the older best-effort persistence path because it is derived from
        // already durable server state (for example canonical attachments).
        if (origin !== PREPARED_LOCAL_ORIGIN) this.persistLocalRecovery();
        if (this.synced) this.sendDocumentUpdate(update);
        else this.needsRecovery = true;
      }
      if (origin !== REMOTE_ORIGIN) this.scheduleMaterialization();
    };
    this.doc.on("update", this.handleDocumentUpdate);
  }

  async start() {
    await this.connect();
    return this;
  }

  restoreLocalRecovery(documentEpoch) {
    const inspection = this.recoveryStore?.inspectAll?.(this.accountId, this.page.id) ?? {
      records: [],
      reliable: false,
      unreadableKeys: []
    };
    if (!inspection.reliable || inspection.unreadableKeys.length > 0) {
      const error = new Error("Local collaboration recovery could not be inspected safely");
      error.code = "COLLABORATION_RECOVERY_INSPECTION_FAILED";
      throw error;
    }

    const records = inspection.records;
    if (!records.length) return false;
    const matchingRecords = records.filter((record) => record.documentEpoch === documentEpoch);
    const preservedRecords = records.filter((record) => record.documentEpoch !== documentEpoch);
    // Old-lineage bytes are intentionally never merged into the current Yjs
    // document, but they must still be surfaced even when there is no current-
    // lineage record. Returning before this warning silently stranded recovery.
    if (preservedRecords.length && !this.recoveryLineageWarningShown) {
      this.recoveryLineageWarningShown = true;
      this.onError(new Error(
        `Preserved ${preservedRecords.length} local collaboration recovery record(s) from an earlier document version without merging them`
      ));
    }
    if (!matchingRecords.length) return false;
    // The host must be able to change its visible editability state before any
    // recovered Yjs transaction is applied. Returning false preserves the local
    // recovery bytes without mutating the live document.
    if (this.onBeforeLocalRecoveryApply({
      documentEpoch,
      recordCount: matchingRecords.length
    }) === false) return false;
    const recovered = [];
    let decodeFailure = null;
    for (const record of matchingRecords) {
      try {
        this.Y.applyUpdate(this.doc, record.update, RECOVERY_ORIGIN);
        recovered.push({
          sourceId: record.sourceId,
          documentEpoch: record.documentEpoch,
          generation: record.generation
        });
      } catch (error) {
        // Preserve undecodable bytes for manual recovery. A newer application
        // or a forensic export may still be able to recover part of the state.
        decodeFailure ??= error;
        this.onError(new Error(
          `A local collaboration recovery record could not be decoded and was preserved: ${error?.message || error}`
        ));
      }
    }
    if (decodeFailure) {
      const error = new Error("A local collaboration recovery record cannot be decoded safely");
      error.code = "COLLABORATION_RECOVERY_DECODE_FAILED";
      error.cause = decodeFailure;
      throw error;
    }
    if (!recovered.length) return false;
    this.recoveredLocalRecords = recovered;
    this.needsRecovery = true;
    return true;
  }

  persistRecoveryState(stateUpdate) {
    if (!this.recoveryStore || !this.accountId || !this.recoverySourceId || !this.documentEpoch) return null;
    const recoverySourceId = this.recoverySourceId;
    const documentEpoch = this.documentEpoch;
    const result = this.recoveryStore.save(
      this.accountId,
      this.page.id,
      recoverySourceId,
      documentEpoch,
      stateUpdate
    );
    const rememberGeneration = (generation) => {
      if (
        typeof generation === "string"
        && generation.length > 0
        && this.recoverySourceId === recoverySourceId
        && this.documentEpoch === documentEpoch
      ) {
        this.currentRecoveryGeneration = generation;
        // A best-effort recovery write can finish after its WebSocket update was
        // already acknowledged. Re-check cleanup once the exact durable
        // generation is known, but never while a prepared mutation is pending.
        queueMicrotask(() => this.maybeClearLocalRecoveryAfterAck());
      }
      return generation;
    };
    return result && typeof result.then === "function"
      ? result.then(rememberGeneration)
      : rememberGeneration(result);
  }

  reportRecoveryStorageFailure(error = null) {
    if (this.recoveryStorageWarningShown) return;
    this.recoveryStorageWarningShown = true;
    this.onError(
      error instanceof Error
        ? error
        : new CollaborationRecoveryWriteError()
    );
  }

  persistLocalRecovery() {
    let stateUpdate;
    try {
      stateUpdate = this.Y.encodeStateAsUpdate(this.doc);
    } catch (error) {
      this.onError(new Error(`The collaboration recovery state could not be encoded: ${error?.message || error}`));
      return false;
    }
    try {
      const generation = this.persistRecoveryState(stateUpdate);
      if (generation && typeof generation.then === "function") {
        void generation.then(
          (value) => { if (!value) this.reportRecoveryStorageFailure(); },
          (error) => this.reportRecoveryStorageFailure(
            new CollaborationRecoveryWriteError(undefined, { cause: error })
          )
        );
        return true;
      }
      if (!generation) this.reportRecoveryStorageFailure();
      return Boolean(generation);
    } catch (error) {
      this.reportRecoveryStorageFailure(new CollaborationRecoveryWriteError(undefined, { cause: error }));
      return false;
    }
  }

  resetLocalMutationDoc() {
    this.localMutationDoc?.destroy();
    this.localMutationDoc = null;
  }

  replaceLiveDocument(document) {
    const previous = this.doc;
    previous.off("update", this.handleDocumentUpdate);
    this.resetLocalMutationDoc();
    this.doc = document;
    this.title = document.getText("title");
    this.blocks = document.getMap("blocks");
    this.deletedAttachments = document.getMap("deletedAttachments");
    document.on("update", this.handleDocumentUpdate);
    previous.destroy();
  }

  resetForCanonicalBootstrapRetry() {
    clearTimeout(this.materializeTimer);
    this.materializeTimer = null;
    this.replaceLiveDocument(new this.Y.Doc());
    this.lastUpdateId = 0;
    this.updatesSinceCompaction = 0;
    this.compactionPending = false;
    this.snapshotScheduledByUpdate = false;
  }

  prepareLocalMutationDoc() {
    try {
      if (!this.localMutationDoc) this.localMutationDoc = new this.Y.Doc();
      const stateVector = this.Y.encodeStateVector(this.localMutationDoc);
      const missingLiveState = this.Y.encodeStateAsUpdate(this.doc, stateVector);
      this.Y.applyUpdate(this.localMutationDoc, missingLiveState, BOOTSTRAP_ORIGIN);
      return {
        doc: this.localMutationDoc,
        title: this.localMutationDoc.getText("title"),
        blocks: this.localMutationDoc.getMap("blocks"),
        deletedAttachments: this.localMutationDoc.getMap("deletedAttachments")
      };
    } catch (error) {
      this.resetLocalMutationDoc();
      throw new Error(`The collaboration draft could not be prepared safely: ${error?.message || error}`);
    }
  }

  commitLocalMutation(mutator, { allowDisconnected = false, beforeCommit = null } = {}) {
    this.pendingPreparedLocalMutations += 1;
    const operation = this.localMutationQueue.then(async () => {
      this.assertWritable({ allowDisconnected });
      // A queued destructive intent may have been superseded while waiting for
      // earlier local mutations. Evaluate its caller-provided fence immediately
      // before touching the prepared Yjs document.
      if (beforeCommit?.() === false) return false;
      const prepared = this.prepareLocalMutationDoc();
      const updates = [];
      const captureUpdate = (update, origin) => {
        if (origin === PREPARED_LOCAL_ORIGIN) updates.push(update);
      };
      prepared.doc.on("update", captureUpdate);
      try {
        prepared.doc.transact(() => mutator(prepared), PREPARED_LOCAL_ORIGIN);
      } catch (error) {
        this.resetLocalMutationDoc();
        throw error;
      } finally {
        prepared.doc.off("update", captureUpdate);
      }
      if (!updates.length) return false;

      let recoveryUpdate;
      let liveUpdate;
      try {
        recoveryUpdate = this.Y.encodeStateAsUpdate(prepared.doc);
        liveUpdate = updates.length === 1 ? updates[0] : this.Y.mergeUpdates(updates);
      } catch (error) {
        this.resetLocalMutationDoc();
        throw new Error(`The collaboration draft could not be encoded safely: ${error?.message || error}`);
      }

      try {
        await commitPreparedCollaborationMutation({
          recoveryUpdate,
          liveUpdate,
          persistRecovery: (update) => this.persistRecoveryState(update),
          applyLiveUpdate: (update) => this.Y.applyUpdate(this.doc, update, PREPARED_LOCAL_ORIGIN)
        });
        return true;
      } catch (error) {
        if (error instanceof CollaborationRecoveryWriteError) {
          this.resetLocalMutationDoc();
          this.reportRecoveryStorageFailure(error);
          throw error;
        }

        this.resetLocalMutationDoc();
        this.needsRecovery = true;
        this.ready = false;
        this.synced = false;
        this.recoveryLoadedEpoch = null;
        const failure = new Error(
          `A durable collaboration draft could not be applied to the live document: ${error?.message || error}`
        );
        failure.code = "COLLABORATION_LOCAL_APPLY_FAILED";
        failure.cause = error;
        this.onError(failure);
        try {
          this.socket?.close(1011, "Unable to apply durable collaboration draft");
        } catch {
          this.scheduleReconnect();
        }
        throw failure;
      }
    });

    const trackedOperation = operation.finally(() => {
      this.pendingPreparedLocalMutations = Math.max(0, this.pendingPreparedLocalMutations - 1);
      this.maybeClearLocalRecoveryAfterAck();
    });
    this.localMutationQueue = trackedOperation.catch(() => undefined);
    return trackedOperation;
  }

  clearLocalRecovery() {
    if (!this.recoveryStore || !this.accountId || typeof this.recoveryStore.removeDurably !== "function") {
      return Promise.resolve(false);
    }

    const currentRecord = (
      this.recoverySourceId
      && this.documentEpoch
      && typeof this.currentRecoveryGeneration === "string"
      && this.currentRecoveryGeneration.length > 0
    ) ? {
      sourceId: this.recoverySourceId,
      documentEpoch: this.documentEpoch,
      generation: this.currentRecoveryGeneration
    } : null;
    const recoveredRecords = this.recoveredLocalRecords.map((record) => ({ ...record }));

    const operation = this.recoveryCleanupQueue.then(async () => {
      if (currentRecord) {
        const removed = await this.recoveryStore.removeDurably(
          this.accountId,
          this.page.id,
          currentRecord.sourceId,
          currentRecord.documentEpoch,
          currentRecord.generation
        );
        if (removed && this.currentRecoveryGeneration === currentRecord.generation) {
          this.currentRecoveryGeneration = null;
        }
      }

      for (const record of recoveredRecords) {
        await this.recoveryStore.removeDurably(
          this.accountId,
          this.page.id,
          record.sourceId,
          record.documentEpoch,
          record.generation
        );
      }

      if (recoveredRecords.length) {
        const cleared = new Set(
          recoveredRecords.map((record) => [record.sourceId, record.documentEpoch, record.generation].join("\u0000"))
        );
        this.recoveredLocalRecords = this.recoveredLocalRecords.filter((record) => !cleared.has(
          [record.sourceId, record.documentEpoch, record.generation].join("\u0000")
        ));
      }
      return true;
    });
    this.recoveryCleanupQueue = operation.catch(() => undefined);
    return operation;
  }

  maybeClearLocalRecoveryAfterAck() {
    if (!shouldClearLocalRecoveryAfterAck(
      this.pendingLocalUpdates,
      this.pendingPreparedLocalMutations,
      this.needsRecovery
    )) return false;
    void this.clearLocalRecovery().catch((error) => {
      this.onError(new Error(
        `Acknowledged collaboration recovery could not be cleaned up safely and was preserved: ${error?.message || error}`
      ));
    });
    return true;
  }

  get isReady() {
    return this.ready && this.synced && this.socket?.readyState === WebSocket.OPEN;
  }

  get isDestroyed() {
    return this.destroyed;
  }

  get hasUnconfirmedLocalChanges() {
    return Boolean(
      this.pendingPreparedLocalMutations
      || this.pendingLocalUpdates
      || this.needsRecovery
      || this.startupUpdatePending
    );
  }

  get hasPendingChanges() {
    return Boolean(this.hasUnconfirmedLocalChanges || this.materializeTimer);
  }

  getSnapshot() {
    return {
      ...readDocumentSnapshot(
        this.Y,
        this.title,
        this.blocks,
        this.deletedAttachments,
        this.lastUpdateId
      ),
      documentEpoch: this.documentEpoch
    };
  }

  setTitle(value) {
    const normalized = requirePageTitleWithinLimit(value);
    return this.commitLocalMutation(({ title }) => {
      replaceYText(title, normalized);
    });
  }

  upsertBlock(block, { allowDisconnected = false, beforeCommit = null } = {}) {
    const normalized = normalizeBlock(block);
    return this.commitLocalMutation(({ blocks, deletedAttachments }) => {
      let map = blocks.get(normalized.id);
      if (!(map instanceof this.Y.Map)) {
        map = new this.Y.Map();
        blocks.set(normalized.id, map);
      }
      reconcileYMap(this.Y, map, {
        type: normalized.type,
        markdown: normalized.markdown,
        checked: normalized.checked,
        parentBlockId: normalized.parentBlockId,
        sortOrder: normalized.sortOrder,
        metadata: normalized.metadata
      });
      if (normalized.type === "ATTACHMENT") deletedAttachments.delete(normalized.id);
    }, { allowDisconnected, beforeCommit }).then(() => normalized);
  }

  upsertBlocks(blocks, { allowDisconnected = false, beforeCommit = null } = {}) {
    const normalized = blocks.map(normalizeBlock);
    return this.commitLocalMutation(({ blocks: stagedBlocks, deletedAttachments }) => {
      for (const block of normalized) {
        let map = stagedBlocks.get(block.id);
        if (!(map instanceof this.Y.Map)) {
          map = new this.Y.Map();
          stagedBlocks.set(block.id, map);
        }
        reconcileYMap(this.Y, map, {
          type: block.type,
          markdown: block.markdown,
          checked: block.checked,
          parentBlockId: block.parentBlockId,
          sortOrder: block.sortOrder,
          metadata: block.metadata
        });
        if (block.type === "ATTACHMENT") deletedAttachments.delete(block.id);
      }
    }, { allowDisconnected, beforeCommit }).then(() => normalized);
  }

  async deleteBlock(blockId, {
    cascade = true,
    promoteChildren = false,
    allowDisconnected = false,
    beforeCommit = null
  } = {}) {
    if (cascade && promoteChildren) {
      throw new Error("A collaborative block deletion cannot cascade and promote children together");
    }

    let deletedIds = [];
    await this.commitLocalMutation(({ blocks, deletedAttachments }) => {
      // Build the hierarchy from the prepared mutation document, not from the live
      // document before the queued mutation starts. This keeps the delete plan aligned
      // with any collaboration updates incorporated while waiting for prior local work.
      const snapshot = [];
      for (const [id, value] of blocks.entries()) {
        if (!(value instanceof this.Y.Map)) continue;
        snapshot.push(normalizeBlock({ id, ...readYValue(this.Y, value) }));
      }
      const target = snapshot.find((block) => block.id === blockId);
      if (!target) return;

      const children = snapshot
        .filter((block) => block.parentBlockId === blockId)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
      if (!cascade && !promoteChildren && children.length) {
        throw new Error("A collaborative block with children cannot be deleted without cascading or promoting its children");
      }

      const ids = new Set([blockId]);
      let changed = cascade;
      while (changed) {
        changed = false;
        for (const block of snapshot) {
          if (ids.has(block.id)) continue;
          if (block.parentBlockId && ids.has(block.parentBlockId)) {
            ids.add(block.id);
            changed = true;
          }
        }
      }

      let promotedOrder = [];
      if (promoteChildren) {
        const siblings = snapshot
          .filter((block) => block.parentBlockId === target.parentBlockId)
          .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
        const targetIndex = siblings.findIndex((block) => block.id === blockId);
        if (targetIndex < 0) throw new Error("The collaborative block hierarchy is inconsistent");
        promotedOrder = siblings.filter((block) => block.id !== blockId);
        promotedOrder.splice(targetIndex, 0, ...children);
      }

      const snapshotById = new Map(snapshot.map((block) => [block.id, block]));
      for (const [sortOrder, block] of promotedOrder.entries()) {
        const value = blocks.get(block.id);
        const current = snapshotById.get(block.id);
        if (!(value instanceof this.Y.Map) || !current) continue;
        reconcileYMap(this.Y, value, {
          ...current,
          parentBlockId: target.parentBlockId,
          sortOrder
        });
      }
      for (const id of ids) {
        const value = blocks.get(id);
        if (value instanceof this.Y.Map && readYValue(this.Y, value.get("type")) === "ATTACHMENT") {
          deletedAttachments.set(id, true);
        }
        blocks.delete(id);
      }
      deletedIds = [...ids];
    }, { allowDisconnected, beforeCommit });
    return deletedIds;
  }

  async replaceBlockWithAttachmentPreservingChildren(blockId, replacementBlock, {
    expectedSourceBlock = null,
    allowDisconnected = false,
    beforeCommit = null
  } = {}) {
    const replacement = normalizeBlock(replacementBlock);
    if (replacement.type !== "ATTACHMENT") {
      throw new Error("Collaborative attachment replacement requires a canonical attachment block");
    }
    if (!expectedSourceBlock || String(expectedSourceBlock?.id ?? "") !== String(blockId ?? "")) {
      throw new Error("Collaborative attachment replacement requires the source block snapshot captured before upload");
    }

    let deletedIds = [];
    let replaced = false;
    await this.commitLocalMutation(({ blocks, deletedAttachments }) => {
      // Plan the entire replacement against the prepared mutation document. The
      // source delete, child promotion, attachment placement, and dense sibling
      // ordering therefore become one recoverable Yjs mutation instead of three
      // independently acknowledged operations.
      const snapshot = [];
      for (const [id, value] of blocks.entries()) {
        if (!(value instanceof this.Y.Map)) continue;
        snapshot.push(normalizeBlock({ id, ...readYValue(this.Y, value) }));
      }
      const plan = planCollaborativeBlockReplacement(snapshot, blockId, replacement, {
        expectedSourceBlock,
        expectedReplacementBlock: replacement
      });
      // The source may have gained text, metadata, a new type, or a new position
      // while the upload was in flight. In that case preserve it and let the UI
      // fall back to an ordinary attachment insertion instead of deleting data.
      if (!plan) return;

      const snapshotById = new Map(snapshot.map((block) => [block.id, block]));
      for (const update of plan.updates) {
        let value = blocks.get(update.id);
        if (!(value instanceof this.Y.Map)) {
          if (update.id !== replacement.id) {
            throw new Error("The collaborative block hierarchy changed while replacing an attachment");
          }
          value = new this.Y.Map();
          blocks.set(update.id, value);
        }
        const current = update.id === replacement.id ? replacement : snapshotById.get(update.id);
        if (!current) {
          throw new Error("The collaborative block hierarchy changed while replacing an attachment");
        }
        reconcileYMap(this.Y, value, {
          ...current,
          parentBlockId: update.parentBlockId,
          sortOrder: update.sortOrder
        });
      }
      deletedAttachments.delete(replacement.id);

      const targetValue = blocks.get(blockId);
      if (targetValue instanceof this.Y.Map && readYValue(this.Y, targetValue.get("type")) === "ATTACHMENT") {
        deletedAttachments.set(blockId, true);
      }
      blocks.delete(blockId);
      deletedIds = [blockId];
      replaced = true;
    }, { allowDisconnected, beforeCommit });
    return { deletedIds, replaced };
  }

  async placeAttachmentAfterSourceIfUnchanged(sourceBlockId, attachmentBlock, {
    allowDisconnected = false
  } = {}) {
    const attachment = normalizeBlock(attachmentBlock);
    if (attachment.type !== "ATTACHMENT") {
      throw new Error("Collaborative attachment placement requires a canonical attachment block");
    }

    let placed = false;
    let preservedConcurrentPosition = false;
    await this.commitLocalMutation(({ blocks, deletedAttachments }) => {
      const snapshot = [];
      for (const [id, value] of blocks.entries()) {
        if (!(value instanceof this.Y.Map)) continue;
        snapshot.push(normalizeBlock({ id, ...readYValue(this.Y, value) }));
      }

      const currentAttachment = snapshot.find((block) => block.id === attachment.id);
      if (
        currentAttachment
        && !matchesCollaborativeBlockSnapshot(currentAttachment, attachment)
      ) {
        // Another collaborator already moved or changed the canonical attachment.
        // Preserve that newer state instead of replaying the uploader's stale slot.
        preservedConcurrentPosition = true;
        return;
      }

      const source = snapshot.find((block) => block.id === String(sourceBlockId ?? ""));
      if (!source) {
        // If the source disappeared concurrently, do not invent a new hierarchy
        // decision. The server-canonical attachment can remain where it was created.
        if (!currentAttachment) {
          let map = blocks.get(attachment.id);
          if (!(map instanceof this.Y.Map)) {
            map = new this.Y.Map();
            blocks.set(attachment.id, map);
          }
          reconcileYMap(this.Y, map, {
            type: attachment.type,
            markdown: attachment.markdown,
            checked: attachment.checked,
            parentBlockId: attachment.parentBlockId,
            sortOrder: attachment.sortOrder,
            metadata: attachment.metadata
          });
          deletedAttachments.delete(attachment.id);
          placed = true;
        }
        return;
      }

      const siblings = snapshot
        .filter((block) => block.id !== attachment.id && block.parentBlockId === source.parentBlockId)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
      const sourceIndex = siblings.findIndex((block) => block.id === source.id);
      if (sourceIndex < 0) throw new Error("The collaborative block hierarchy is inconsistent");

      const resultingSiblings = [...siblings];
      resultingSiblings.splice(sourceIndex + 1, 0, {
        ...attachment,
        parentBlockId: source.parentBlockId
      });
      const snapshotById = new Map(snapshot.map((block) => [block.id, block]));

      for (const [sortOrder, block] of resultingSiblings.entries()) {
        let map = blocks.get(block.id);
        if (block.id === attachment.id) {
          if (!(map instanceof this.Y.Map)) {
            map = new this.Y.Map();
            blocks.set(attachment.id, map);
          }
          reconcileYMap(this.Y, map, {
            type: attachment.type,
            markdown: attachment.markdown,
            checked: attachment.checked,
            parentBlockId: source.parentBlockId,
            sortOrder,
            metadata: attachment.metadata
          });
          deletedAttachments.delete(attachment.id);
          continue;
        }

        const current = snapshotById.get(block.id);
        if (!(map instanceof this.Y.Map) || !current) continue;
        reconcileYMap(this.Y, map, {
          ...current,
          parentBlockId: source.parentBlockId,
          sortOrder
        });
      }
      placed = true;
    }, { allowDisconnected });

    return { placed, preservedConcurrentPosition };
  }

  adoptAttachment(block) {
    if (this.destroyed || String(block?.type) !== "ATTACHMENT") return null;
    const normalized = normalizeBlock(block);
    this.reconcileServerAttachments([normalized]);
    return normalized;
  }

  /**
   * @param {unknown[]} blocks
   * @param {{ origin?: unknown }} [options]
   */
  reconcileServerAttachments(blocks, { origin = LOCAL_ORIGIN } = {}) {
    if (this.destroyed) return 0;
    const candidates = flattenBlocks(blocks ?? [])
      .map(normalizeBlock)
      .filter((block) => block.type === "ATTACHMENT");
    const availableIds = new Set([
      ...[...this.blocks.keys()].filter((id) => !this.deletedAttachments.has(id)),
      ...candidates
        .filter((block) => !this.deletedAttachments.has(block.id))
        .map((block) => block.id)
    ]);
    let reconciled = 0;
    this.doc.transact(() => {
      for (const candidate of candidates) {
        if (this.deletedAttachments.has(candidate.id)) continue;
        let map = this.blocks.get(candidate.id);
        const current = map instanceof this.Y.Map
          ? normalizeBlock({ id: candidate.id, ...readYValue(this.Y, map) })
          : null;
        const normalized = reconcileCanonicalAttachment(candidate, current, availableIds);
        if (!(map instanceof this.Y.Map)) {
          map = new this.Y.Map();
          this.blocks.set(normalized.id, map);
        }
        reconcileYMap(this.Y, map, {
          type: normalized.type,
          markdown: normalized.markdown,
          checked: normalized.checked,
          parentBlockId: normalized.parentBlockId,
          sortOrder: normalized.sortOrder,
          metadata: normalized.metadata
        });
        reconciled += 1;
      }
    }, origin);
    return reconciled;
  }

  clearMaterializedAttachmentTombstones(ids) {
    if (this.destroyed || !ids?.length) return 0;
    let cleared = 0;
    this.doc.transact(() => {
      for (const id of ids) {
        // A concurrent map assignment can coexist with the tombstone at the
        // CRDT level. Once SQL confirms deletion, remove both representations
        // in one Yjs transaction so a later materialization cannot resurrect it.
        if (this.blocks.has(id)) this.blocks.delete(id);
        if (!this.deletedAttachments.has(id)) continue;
        this.deletedAttachments.delete(id);
        cleared += 1;
      }
    }, LOCAL_ORIGIN);
    return cleared;
  }

  setAwareness(state) {
    this.lastAwareness = {
      blockId: typeof state?.blockId === "string" ? state.blockId.slice(0, 64) : null,
      field: typeof state?.field === "string" ? state.field.slice(0, 32) : null,
      control: typeof state?.control === "string" ? state.control.slice(0, 32) : null,
      selection: Number.isSafeInteger(state?.selection?.anchor) && Number.isSafeInteger(state?.selection?.head)
        ? { anchor: Math.max(0, state.selection.anchor), head: Math.max(0, state.selection.head) }
        : null
    };
    clearTimeout(this.awarenessTimer);
    this.awarenessTimer = setTimeout(() => this.sendAwareness(), AWARENESS_DELAY_MS);
  }

  async flushMaterialization({ compact = true } = {}) {
    if (this.destroyed) return null;
    if (!this.isReady || this.needsRecovery) {
      throw new Error("The real-time document is not synchronized yet");
    }
    await this.waitForPendingUpdates();
    if (!this.isReady || this.needsRecovery) throw new Error("The real-time document lost synchronization");
    clearTimeout(this.materializeTimer);
    this.materializeTimer = null;

    this.materializeQueue = this.materializeQueue
      .catch(() => null)
      .then(async () => {
        const submitSnapshot = async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await this.waitForPendingUpdates();
            const snapshot = this.getSnapshot();
            try {
              const result = await this.api(`/api/pages/${encodeURIComponent(this.page.id)}/collaboration/snapshot`, {
                method: "PUT",
                body: {
                  documentEpoch: snapshot.documentEpoch,
                  updateId: snapshot.updateId
                }
              });
              return { result, snapshot };
            } catch (error) {
              if (error?.code !== "COLLABORATION_SNAPSHOT_STALE" || attempt === 2) throw error;
              await wait(80 * (attempt + 1));
            }
          }
          return null;
        };

        let result = null;
        for (let round = 0; round < 5; round += 1) {
          await this.waitForPendingUpdates();
          if (!this.isReady || this.needsRecovery) {
            throw new Error("The real-time document lost synchronization");
          }
          clearTimeout(this.materializeTimer);
          this.materializeTimer = null;

          const submitted = await submitSnapshot();
          result = submitted?.result ?? null;
          this.reconcileServerAttachments(result?.blocks ?? []);
          this.clearMaterializedAttachmentTombstones(submitted?.snapshot.deletedAttachmentIds ?? []);
          this.onMaterialized(result);

          await this.waitForPendingUpdates();
          if (!this.isReady || this.needsRecovery) {
            throw new Error("The real-time document lost synchronization");
          }
          const materializedUpdateId = Number(result?.materializedUpdateId ?? 0);
          if (
            Number.isSafeInteger(materializedUpdateId)
            && materializedUpdateId === this.lastUpdateId
            && this.pendingLocalUpdates === 0
            && this.getSnapshot().deletedAttachmentIds.length === 0
          ) {
            if (compact && this.updatesSinceCompaction >= COMPACTION_UPDATE_THRESHOLD) this.requestCompaction();
            return result;
          }
        }
        throw new Error("The document kept changing while it was being materialized");
      })
      .catch((error) => {
        this.onError(error);
        throw error;
      });
    return this.materializeQueue;
  }

  async destroy({ flush = true } = {}) {
    if (this.destroyed) return;
    if (flush && this.hasUnconfirmedLocalChanges && !this.isReady) {
      throw new Error("Wait for real-time synchronization before closing the document");
    }
    if (flush && this.isReady) await this.flushMaterialization();
    this.destroyed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.materializeTimer);
    clearTimeout(this.awarenessTimer);
    this.socket?.close(1000, "Page closed");
    this.socket = null;
    this.resetLocalMutationDoc();
    this.doc.off("update", this.handleDocumentUpdate);
    this.doc.destroy();
    this.resolvePendingWaiters();
  }

  assertWritable({ allowDisconnected = false } = {}) {
    if (this.destroyed) throw new Error("The real-time collaboration session is closed");
    if (!allowDisconnected && !this.isReady) throw new Error("Wait for real-time synchronization before editing");
  }

  initializeFromPage() {
    if (this.recoveredLocalRecords.length || this.title.length || this.blocks.size) return;
    const page = this.bootstrapPage ?? this.page;
    this.doc.transact(() => {
      replaceYText(this.title, requirePageTitleWithinLimit(page.title));
      for (const block of flattenBlocks(page.blocks ?? [])) {
        const normalized = normalizeBlock(block);
        const map = new this.Y.Map();
        reconcileYMap(this.Y, map, {
          type: normalized.type,
          markdown: normalized.markdown,
          checked: normalized.checked,
          parentBlockId: normalized.parentBlockId,
          sortOrder: normalized.sortOrder,
          metadata: normalized.metadata
        });
        this.blocks.set(normalized.id, map);
      }
    }, BOOTSTRAP_ORIGIN);
  }

  /** @param {unknown} origin */
  mergeCanonicalAttachments(origin = LOCAL_ORIGIN) {
    const page = this.bootstrapPage ?? this.page;
    return this.reconcileServerAttachments(page.blocks ?? [], { origin }) > 0;
  }

  async connect() {
    if (this.destroyed || this.connecting) return;
    this.connecting = true;
    this.ready = false;
    this.synced = false;
    this.onStatus("connecting");
    try {
      const session = await this.api(`/api/pages/${encodeURIComponent(this.page.id)}/collaboration/session`, {
        method: "POST",
        body: { documentEpochProtocol: 2 }
      });
      if (this.destroyed) return;
      const documentEpoch = typeof session?.documentEpoch === "string"
        ? session.documentEpoch
        : "";
      if (!documentEpoch || documentEpoch.length > 64) {
        throw new Error("The collaboration server returned an invalid document version");
      }
      if (this.documentEpoch && this.documentEpoch !== documentEpoch) {
        if (this.hasUnconfirmedLocalChanges) this.persistLocalRecovery();
        this.onAccessChanged({ code: 4011, reason: "The collaboration document was replaced" });
        return;
      }
      this.documentEpoch = documentEpoch;
      if (this.recoveryLoadedEpoch !== documentEpoch) {
        this.restoreLocalRecovery(documentEpoch);
        this.recoveryLoadedEpoch = documentEpoch;
      }
      if (session?.document && typeof session.document === "object") {
        this.bootstrapPage = {
          ...this.page,
          title: requirePageTitleWithinLimit(session.document.title ?? this.page.title),
          blocks: Array.isArray(session.document.blocks) ? session.document.blocks : this.page.blocks
        };
      }
      const socket = new WebSocket(websocketUrl(session.path), [session.protocol, session.ticketProtocol]);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.socket !== socket) return;
        this.reconnectAttempt = 0;
        this.onStatus("syncing");
      });
      socket.addEventListener("message", (event) => this.handleSocketMessage(socket, event));
      socket.addEventListener("error", () => {
        if (this.socket === socket) this.onStatus("error");
      });
      socket.addEventListener("close", (event) => this.handleSocketClose(socket, event));
    } catch (error) {
      this.onError(error);
      this.onStatus("error");
      const recoveryIntegrityFailure =
        error?.code === "COLLABORATION_RECOVERY_INSPECTION_FAILED"
        || error?.code === "COLLABORATION_RECOVERY_DECODE_FAILED";
      if (!recoveryIntegrityFailure) this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  handleSocketMessage(socket, event) {
    if (socket !== this.socket || this.destroyed) return;
    if (typeof event.data === "string") {
      this.handleControlMessage(event.data);
      return;
    }
    const data = new Uint8Array(event.data);
    if (data.byteLength < 10 || data[0] !== 1) return;
    const updateId = Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, false));
    if (!Number.isSafeInteger(updateId)) return;
    this.lastUpdateId = Math.max(this.lastUpdateId, updateId);
    try {
      this.Y.applyUpdate(this.doc, data.subarray(9), REMOTE_ORIGIN);
    } catch (error) {
      this.needsRecovery = true;
      this.onError(new Error(`The collaboration server sent an invalid Yjs update: ${error?.message || error}`));
      socket.close(1003, "Invalid Yjs update");
      return;
    }
    this.updatesSinceCompaction += 1;
    this.scheduleMaterialization();
  }

  handleControlMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.type === "sync-complete") {
      this.connectionId = message.connectionId ?? null;
      this.lastUpdateId = Math.max(this.lastUpdateId, Number(message.lastUpdateId) || 0);
      this.synced = true;
      const mustSendFullState = Boolean(message.bootstrap || this.needsRecovery);
      if (message.bootstrap) this.initializeFromPage();
      else this.mergeCanonicalAttachments(mustSendFullState ? BOOTSTRAP_ORIGIN : LOCAL_ORIGIN);
      if (mustSendFullState) {
        let fullStateUpdate;
        try {
          fullStateUpdate = this.Y.encodeStateAsUpdate(this.doc);
        } catch (error) {
          this.needsRecovery = true;
          this.startupUpdatePending = false;
          this.onError(new Error(`The collaboration recovery state could not be encoded for synchronization: ${error?.message || error}`));
          try {
            this.socket?.close(1011, "Unable to encode collaboration recovery state");
          } catch {
            // A later connection attempt can retry without clearing the durable copy.
          }
          return;
        }
        this.startupUpdatePending = true;
        if (this.sendDocumentUpdate(fullStateUpdate)) this.needsRecovery = false;
        else this.startupUpdatePending = false;
      } else if (this.pendingLocalUpdates > 0) {
        this.startupUpdatePending = true;
      } else {
        this.markReady();
      }
      return;
    }
    if (message.type === "bootstrap-wait") {
      this.onStatus("syncing");
      return;
    }
    if (message.type === "update-ack") {
      this.lastUpdateId = Math.max(this.lastUpdateId, Number(message.updateId) || 0);
      this.pendingLocalUpdates = Math.max(0, this.pendingLocalUpdates - 1);
      if (message.snapshot) {
        this.compactionPending = false;
        this.updatesSinceCompaction = 0;
        this.scheduleMaterialization();
      }
      if (this.pendingLocalUpdates === 0) {
        // A different update may have failed to queue while this acknowledgement
        // was in flight. Keep the durable full-document recovery copy until every
        // local change is known to have reached the server.
        this.maybeClearLocalRecoveryAfterAck();
        this.resolvePendingWaiters();
        if (this.startupUpdatePending && !this.needsRecovery) {
          this.startupUpdatePending = false;
          this.markReady();
        }
      }
      return;
    }
    if (message.type === "compaction-complete") {
      this.lastUpdateId = Math.max(this.lastUpdateId, Number(message.updateId) || 0);
      this.updatesSinceCompaction = 0;
      this.scheduleMaterialization();
      return;
    }
    if (message.type === "snapshot-rejected") {
      this.compactionPending = false;
      this.lastUpdateId = Math.max(this.lastUpdateId, Number(message.lastUpdateId) || 0);
      this.pendingLocalUpdates = Math.max(0, this.pendingLocalUpdates - 1);
      if (this.pendingLocalUpdates === 0) this.resolvePendingWaiters();
      return;
    }
    if (message.type === "canonical-attachment") {
      try {
        this.adoptAttachment(message.block);
      } catch (error) {
        this.onError(error);
      }
      return;
    }
    if (message.type === "presence") {
      this.presence.clear();
      for (const client of message.clients ?? []) this.presence.set(client.connectionId, client);
      this.emitPresence();
      return;
    }
    if (message.type === "awareness-update") {
      if (message.state === null) {
        this.presence.delete(message.connectionId);
      } else {
        const previous = this.presence.get(message.connectionId) ?? {};
        this.presence.set(message.connectionId, { ...previous, ...message });
      }
      this.emitPresence();
      return;
    }
    if (message.type === "error") this.onError(new Error(message.message || "Collaboration error"));
  }

  handleSocketClose(socket, event) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.ready = false;
    this.synced = false;
    this.presence.clear();
    this.emitPresence();

    const retryCanonicalBootstrap = event.code === 4012
      && this.startupUpdatePending
      && !this.needsRecovery
      && this.recoveredLocalRecords.length === 0;
    if (retryCanonicalBootstrap) {
      // The server proved that this first Yjs state was not an exact copy of
      // SQL. Discard only the unacknowledged startup document, fetch a fresh
      // locked snapshot, and rebuild instead of ever persisting truncation.
      this.pendingLocalUpdates = 0;
      this.startupUpdatePending = false;
      this.needsRecovery = false;
      this.resetForCanonicalBootstrapRetry();
      this.resolvePendingWaiters();
    } else if (this.pendingLocalUpdates > 0 || this.startupUpdatePending) {
      this.needsRecovery = true;
      this.pendingLocalUpdates = 0;
      this.startupUpdatePending = false;
      this.resolvePendingWaiters();
    }
    if (this.destroyed) return;
    if (event.code === 4003 || event.code === 4010 || event.code === 4011) {
      this.onStatus("offline");
      this.onAccessChanged({ code: event.code, reason: event.reason });
      return;
    }
    if (event.code === 4012 && !retryCanonicalBootstrap) {
      const error = new Error(
        "The initial collaboration state did not match the saved page. Local recovery data was preserved instead of being overwritten."
      );
      error.code = "COLLABORATION_BOOTSTRAP_MISMATCH";
      this.onError(error);
      this.onStatus("offline");
      return;
    }
    this.onStatus("reconnecting");
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = Math.min(10_000, 500 * (2 ** Math.min(this.reconnectAttempt, 5)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  markReady() {
    if (!this.synced || this.destroyed) return;
    this.ready = true;
    this.reconcileServerAttachments(this.bootstrapPage?.blocks ?? this.page.blocks ?? []);
    this.onStatus("synced");
    this.emitSnapshot("ready");
    this.sendAwareness();
    this.scheduleMaterialization();
  }

  sendDocumentUpdate(update) {
    const socket = this.socket;
    if (!this.synced || socket?.readyState !== WebSocket.OPEN) {
      this.needsRecovery = true;
      return false;
    }
    this.pendingLocalUpdates += 1;
    try {
      socket.send(createBinaryMessage(1, update));
      return true;
    } catch (error) {
      this.pendingLocalUpdates = Math.max(0, this.pendingLocalUpdates - 1);
      this.needsRecovery = true;
      if (this.pendingLocalUpdates === 0) this.resolvePendingWaiters();
      this.onError(new Error(`The collaboration update could not be queued: ${error?.message || error}`));
      try {
        socket.close(1011, "Unable to queue collaboration update");
      } catch {
        // The reconnect path will resend the durable recovery snapshot.
      }
      return false;
    }
  }

  requestCompaction() {
    if (this.compactionPending || !this.isReady || this.pendingLocalUpdates) return;
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    let message;
    try {
      message = createBinaryMessage(2, this.Y.encodeStateAsUpdate(this.doc), this.lastUpdateId);
    } catch (error) {
      this.onError(new Error(`The collaboration snapshot could not be encoded: ${error?.message || error}`));
      return;
    }

    this.compactionPending = true;
    this.pendingLocalUpdates += 1;
    try {
      socket.send(message);
    } catch (error) {
      this.compactionPending = false;
      this.pendingLocalUpdates = Math.max(0, this.pendingLocalUpdates - 1);
      if (this.pendingLocalUpdates === 0) this.resolvePendingWaiters();
      this.onError(new Error(`The collaboration snapshot could not be queued: ${error?.message || error}`));
      try {
        socket.close(1011, "Unable to queue collaboration snapshot");
      } catch {
        // The next materialization can retry compaction on a healthy connection.
      }
    }
  }

  waitForPendingUpdates() {
    if (this.pendingLocalUpdates === 0) return Promise.resolve();
    return new Promise((resolve, reject) => this.pendingWaiters.push({ resolve, reject }));
  }

  resolvePendingWaiters() {
    const waiters = this.pendingWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  sendAwareness() {
    clearTimeout(this.awarenessTimer);
    this.awarenessTimer = null;
    if (!this.isReady) return;
    this.socket.send(JSON.stringify({ type: "awareness", state: this.lastAwareness }));
  }

  emitSnapshot(source = "remote") {
    try {
      this.onSnapshot(this.getSnapshot(), { source });
    } catch (error) {
      this.onError(error);
    }
  }

  emitPresence() {
    this.onPresence([...this.presence.values()]);
  }

  scheduleMaterialization() {
    if (!this.isReady || this.destroyed) return;
    clearTimeout(this.materializeTimer);
    this.materializeTimer = setTimeout(() => {
      this.materializeTimer = null;
      void this.flushMaterialization().catch(() => undefined);
    }, MATERIALIZE_DELAY_MS);
  }
}

/**
 * @param {number} pendingLocalUpdates
 * @param {number} pendingPreparedLocalMutations
 * @param {boolean} needsRecovery
 */
export function shouldClearLocalRecoveryAfterAck(
  pendingLocalUpdates,
  pendingPreparedLocalMutations,
  needsRecovery
) {
  return pendingLocalUpdates === 0
    && pendingPreparedLocalMutations === 0
    && needsRecovery !== true;
}

export async function decodeCollaborationRecoveryRecords(records) {
  const normalizedRecords = [...(records ?? [])];
  const documentEpochs = new Set(
    normalizedRecords.map((record) => record?.documentEpoch == null
      ? "legacy:"
      : `epoch:${record.documentEpoch}`)
  );
  if (documentEpochs.size > 1) {
    throw new Error("Collaboration recovery records from different document versions cannot be merged");
  }
  const Y = await loadYjs();
  const doc = new Y.Doc();
  try {
    for (const record of normalizedRecords.sort(
      (left, right) => Number(left?.updatedAt ?? 0) - Number(right?.updatedAt ?? 0)
    )) {
      const update = record?.update instanceof Uint8Array
        ? record.update
        : new Uint8Array(record?.update ?? 0);
      if (!update.byteLength) continue;
      Y.applyUpdate(doc, update, RECOVERY_ORIGIN);
    }
    return readDocumentSnapshot(
      Y,
      doc.getText("title"),
      doc.getMap("blocks"),
      doc.getMap("deletedAttachments")
    );
  } finally {
    doc.destroy();
  }
}

export async function createPageCollaboration(options) {
  const Y = await loadYjs();
  const session = new PageCollaborationSession(Y, options);
  return session.start();
}

export { YJS_MODULE_URL };
