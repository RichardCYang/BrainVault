const YJS_MODULE_URL = "https://cdn.jsdelivr.net/npm/yjs@13.6.31/+esm";
const REMOTE_ORIGIN = Object.freeze({ kind: "remote" });
const BOOTSTRAP_ORIGIN = Object.freeze({ kind: "bootstrap" });
const LOCAL_ORIGIN = Object.freeze({ kind: "local" });
const COMPACTION_UPDATE_THRESHOLD = 200;
const MATERIALIZE_DELAY_MS = 900;
const AWARENESS_DELAY_MS = 80;
const COLLABORATIVE_BLOCK_TYPES = new Set([
  "MARKDOWN",
  "HEADING_1",
  "HEADING_2",
  "HEADING_3",
  "TODO",
  "QUOTE",
  "CALLOUT",
  "TABLE",
  "KANBAN",
  "DATABASE",
  "BOOKMARK",
  "AI_CHAT",
  "MATH",
  "CODE",
  "DIVIDER",
  "IMAGE",
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
    markdown: String(block?.markdown ?? "").slice(0, 20_000),
    checked: Boolean(block?.checked),
    parentBlockId: block?.parentBlockId ? String(block.parentBlockId).slice(0, 64) : null,
    sortOrder: Number.isFinite(numericSortOrder)
      ? Math.min(2_147_483_647, Math.max(0, Math.trunc(numericSortOrder)))
      : 0,
    metadata: isPlainObject(block?.metadata) ? block.metadata : null
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
    this.api = options.api;
    this.onSnapshot = options.onSnapshot ?? (() => undefined);
    this.onPresence = options.onPresence ?? (() => undefined);
    this.onStatus = options.onStatus ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.onAccessChanged = options.onAccessChanged ?? (() => undefined);
    this.onMaterialized = options.onMaterialized ?? (() => undefined);
    this.doc = new Y.Doc();
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
    this.lastAwareness = { blockId: null, field: null, selection: null };
    this.presence = new Map();
    this.lastUpdateId = 0;
    this.pendingLocalUpdates = 0;
    this.pendingWaiters = [];
    this.needsRecovery = false;
    this.startupUpdatePending = false;
    this.updatesSinceCompaction = 0;
    this.compactionPending = false;
    this.materializeQueue = Promise.resolve(null);
    this.snapshotScheduledByUpdate = false;

    this.doc.on("update", (update, origin) => {
      const source = origin === REMOTE_ORIGIN ? "remote" : origin === BOOTSTRAP_ORIGIN ? "bootstrap" : "local";
      this.emitSnapshot(source);
      if (origin !== REMOTE_ORIGIN && origin !== BOOTSTRAP_ORIGIN) {
        if (this.synced) this.sendDocumentUpdate(update);
        else this.needsRecovery = true;
      }
      if (origin !== REMOTE_ORIGIN) this.scheduleMaterialization();
    });
  }

  async start() {
    await this.connect();
    return this;
  }

  get isReady() {
    return this.ready && this.synced && this.socket?.readyState === WebSocket.OPEN;
  }

  get isDestroyed() {
    return this.destroyed;
  }

  get hasPendingChanges() {
    return Boolean(this.pendingLocalUpdates || this.materializeTimer || this.needsRecovery);
  }

  getSnapshot() {
    const blocks = [];
    const blockIds = new Set();
    const deletedAttachmentIds = new Set(this.deletedAttachments.keys());
    for (const [id, value] of this.blocks.entries()) {
      if (!(value instanceof this.Y.Map)) continue;
      const plain = readYValue(this.Y, value);
      const normalized = normalizeBlock({ id, ...plain });
      // A tombstone wins over a concurrently retained/re-created block. This
      // keeps the SQL materialization payload internally consistent and avoids
      // resurrecting an attachment after its file has been removed.
      if (deletedAttachmentIds.has(normalized.id)) continue;
      if (!normalized.id || blockIds.has(normalized.id)) continue;
      blockIds.add(normalized.id);
      blocks.push(normalized);
    }
    blocks.sort((left, right) => {
      const leftParent = left.parentBlockId ?? "";
      const rightParent = right.parentBlockId ?? "";
      return leftParent.localeCompare(rightParent) || left.sortOrder - right.sortOrder || left.id.localeCompare(right.id);
    });
    return {
      title: this.title.toString().slice(0, 160),
      blocks,
      deletedAttachmentIds: [...deletedAttachmentIds].sort(),
      updateId: this.lastUpdateId
    };
  }

  setTitle(value) {
    this.assertWritable();
    this.doc.transact(() => replaceYText(this.title, String(value ?? "").slice(0, 160)), LOCAL_ORIGIN);
  }

  upsertBlock(block, { allowDisconnected = false } = {}) {
    this.assertWritable({ allowDisconnected });
    const normalized = normalizeBlock(block);
    this.doc.transact(() => {
      let map = this.blocks.get(normalized.id);
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
      if (normalized.type === "ATTACHMENT") this.deletedAttachments.delete(normalized.id);
    }, LOCAL_ORIGIN);
    return normalized;
  }

  upsertBlocks(blocks, { allowDisconnected = false } = {}) {
    this.assertWritable({ allowDisconnected });
    const normalized = blocks.map(normalizeBlock);
    this.doc.transact(() => {
      for (const block of normalized) {
        let map = this.blocks.get(block.id);
        if (!(map instanceof this.Y.Map)) {
          map = new this.Y.Map();
          this.blocks.set(block.id, map);
        }
        reconcileYMap(this.Y, map, {
          type: block.type,
          markdown: block.markdown,
          checked: block.checked,
          parentBlockId: block.parentBlockId,
          sortOrder: block.sortOrder,
          metadata: block.metadata
        });
        if (block.type === "ATTACHMENT") this.deletedAttachments.delete(block.id);
      }
    }, LOCAL_ORIGIN);
    return normalized;
  }

  deleteBlock(blockId, { cascade = true, allowDisconnected = false } = {}) {
    this.assertWritable({ allowDisconnected });
    const ids = new Set([blockId]);
    let changed = cascade;
    while (changed) {
      changed = false;
      for (const [id, value] of this.blocks.entries()) {
        if (!(value instanceof this.Y.Map) || ids.has(id)) continue;
        const parent = readYValue(this.Y, value.get("parentBlockId"));
        if (typeof parent === "string" && ids.has(parent)) {
          ids.add(id);
          changed = true;
        }
      }
    }
    this.doc.transact(() => {
      for (const id of ids) {
        const value = this.blocks.get(id);
        if (value instanceof this.Y.Map && readYValue(this.Y, value.get("type")) === "ATTACHMENT") {
          this.deletedAttachments.set(id, true);
        }
        this.blocks.delete(id);
      }
    }, LOCAL_ORIGIN);
    return [...ids];
  }

  adoptAttachment(block) {
    if (this.destroyed || String(block?.type) !== "ATTACHMENT") return null;
    return this.upsertBlock(block, { allowDisconnected: true });
  }

  reconcileServerAttachments(blocks, { origin = LOCAL_ORIGIN } = {}) {
    if (this.destroyed) return 0;
    const candidates = flattenBlocks(blocks ?? [])
      .map(normalizeBlock)
      .filter((block) => block.type === "ATTACHMENT");
    const availableIds = new Set([...this.blocks.keys(), ...candidates.map((block) => block.id)]);
    let reconciled = 0;
    this.doc.transact(() => {
      for (const candidate of candidates) {
        if (this.deletedAttachments.has(candidate.id)) continue;
        const normalized = {
          ...candidate,
          parentBlockId: candidate.parentBlockId && availableIds.has(candidate.parentBlockId)
            ? candidate.parentBlockId
            : null
        };
        let map = this.blocks.get(normalized.id);
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
                body: snapshot
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
    if (flush && this.isReady) await this.flushMaterialization().catch(() => undefined);
    this.destroyed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.materializeTimer);
    clearTimeout(this.awarenessTimer);
    this.socket?.close(1000, "Page closed");
    this.socket = null;
    this.doc.destroy();
    this.resolvePendingWaiters();
  }

  assertWritable({ allowDisconnected = false } = {}) {
    if (this.destroyed) throw new Error("The real-time collaboration session is closed");
    if (!allowDisconnected && !this.isReady) throw new Error("Wait for real-time synchronization before editing");
  }

  initializeFromPage() {
    if (this.title.length || this.blocks.size) return;
    const page = this.bootstrapPage ?? this.page;
    this.doc.transact(() => {
      replaceYText(this.title, String(page.title ?? "").slice(0, 160));
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
        method: "POST"
      });
      if (this.destroyed) return;
      if (session?.document && typeof session.document === "object") {
        this.bootstrapPage = {
          ...this.page,
          title: String(session.document.title ?? this.page.title ?? "").slice(0, 160),
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
      this.scheduleReconnect();
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
        this.needsRecovery = false;
        this.startupUpdatePending = true;
        this.sendDocumentUpdate(this.Y.encodeStateAsUpdate(this.doc));
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
        this.resolvePendingWaiters();
        if (this.startupUpdatePending) {
          this.startupUpdatePending = false;
          this.markReady();
        }
      }
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
      if (message.state === null) this.presence.delete(message.connectionId);
      else this.presence.set(message.connectionId, message);
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
    if (this.pendingLocalUpdates > 0 || this.startupUpdatePending) {
      this.needsRecovery = true;
      this.pendingLocalUpdates = 0;
      this.startupUpdatePending = false;
      this.resolvePendingWaiters();
    }
    if (this.destroyed) return;
    if (event.code === 4003 || event.code === 4010) {
      this.onStatus("offline");
      this.onAccessChanged({ code: event.code, reason: event.reason });
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
    if (!this.synced || this.socket?.readyState !== WebSocket.OPEN) {
      this.needsRecovery = true;
      return;
    }
    this.pendingLocalUpdates += 1;
    this.socket.send(createBinaryMessage(1, update));
  }

  requestCompaction() {
    if (this.compactionPending || !this.isReady || this.pendingLocalUpdates) return;
    this.compactionPending = true;
    this.pendingLocalUpdates += 1;
    this.socket.send(createBinaryMessage(2, this.Y.encodeStateAsUpdate(this.doc), this.lastUpdateId));
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

export async function createPageCollaboration(options) {
  const Y = await loadYjs();
  const session = new PageCollaborationSession(Y, options);
  return session.start();
}

export { YJS_MODULE_URL };
