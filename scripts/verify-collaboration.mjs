import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WebSocketConnection,
  acceptWebSocketUpgrade,
  parseWebSocketProtocols
} from "../src/lib/websocket.ts";
import {
  CollaborationDocumentError,
  validateCollaborationBlockHierarchy
} from "../src/lib/collaboration-document.ts";
import {
  assessCollaborationWriteCheckpoint,
  currentCollaborationMaterializationVersion,
  needsCollaborationMaterialization
} from "../src/lib/collaboration-protocol.ts";
import { assessInitialCollaborationBootstrap } from "../src/lib/collaboration-bootstrap.ts";
import { shouldClearLocalRecoveryAfterAck } from "../public/collaboration.js";
import { createCollaborationRecoveryStore } from "../public/collaboration-recovery-store.js";
import { reconcileCanonicalAttachment } from "../public/collaboration-attachment-reconcile.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function read(relativePath) {
  return readFileSync(join(rootDir, relativePath), "utf8");
}

function assertContains(relativePath, patterns) {
  const source = read(relativePath);
  for (const pattern of patterns) {
    if (pattern instanceof RegExp) assert.match(source, pattern, `${relativePath} must match ${pattern}`);
    else assert.ok(source.includes(pattern), `${relativePath} must contain ${JSON.stringify(pattern)}`);
  }
}

function walk(directory, extensions) {
  const result = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (name === ".git" || name === "node_modules" || name === "dist") continue;
      result.push(...walk(path, extensions));
    } else if (extensions.some((extension) => name.endsWith(extension))) {
      result.push(path);
    }
  }
  return result;
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writes = [];
    this.paused = false;
  }

  write(value) {
    this.writes.push(Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), "utf8"));
    return true;
  }

  end(value) {
    if (value !== undefined) this.write(value);
    queueMicrotask(() => this.emit("end"));
    return this;
  }

  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  pause() {
    this.paused = true;
    return this;
  }

  resume() {
    this.paused = false;
    return this;
  }
}

function encodeClientFrame(opcode, payload, { fin = true, masked = true } = {}) {
  const data = Buffer.from(payload);
  const first = (fin ? 0x80 : 0) | opcode;
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const maskLength = masked ? 4 : 0;
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2 + maskLength);
    header[0] = first;
    header[1] = (masked ? 0x80 : 0) | data.length;
    if (masked) mask.copy(header, 2);
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4 + maskLength);
    header[0] = first;
    header[1] = (masked ? 0x80 : 0) | 126;
    header.writeUInt16BE(data.length, 2);
    if (masked) mask.copy(header, 4);
  } else {
    header = Buffer.alloc(10 + maskLength);
    header[0] = first;
    header[1] = (masked ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
    if (masked) mask.copy(header, 10);
  }
  if (!masked) return Buffer.concat([header, data]);
  const encoded = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) encoded[index] = data[index] ^ mask[index % 4];
  return Buffer.concat([header, encoded]);
}

function decodeServerFrame(frame) {
  const first = frame[0];
  const second = frame[1];
  assert.equal(second & 0x80, 0, "Server frames must not be masked");
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = frame.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    length = Number(frame.readBigUInt64BE(2));
    offset = 10;
  }
  return {
    fin: Boolean(first & 0x80),
    opcode: first & 0x0f,
    payload: frame.subarray(offset, offset + length)
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function verifyWebSocketProtocol() {
  assert.deepEqual(
    parseWebSocketProtocols(["brainvault-yjs-v2", " brainvault-ticket.token , secondary"]),
    ["brainvault-yjs-v2", "brainvault-ticket.token", "secondary"]
  );

  const handshakeSocket = new FakeSocket();
  const request = {
    headers: {
      upgrade: "websocket",
      connection: "keep-alive, Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ=="
    }
  };
  const upgraded = acceptWebSocketUpgrade(request, handshakeSocket, {
    selectedProtocol: "brainvault-yjs-v2",
    maxMessageBytes: 1024
  });
  assert.ok(upgraded instanceof WebSocketConnection);
  const response = Buffer.concat(handshakeSocket.writes).toString("utf8");
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/);
  assert.match(response, /Sec-WebSocket-Protocol: brainvault-yjs-v2\r\n/);

  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket, 1024);
  const messages = [];
  connection.onMessage((message) => messages.push(message));
  connection.start();

  socket.emit("data", encodeClientFrame(0x1, Buffer.from("hello", "utf8")));
  socket.emit("data", encodeClientFrame(0x2, Buffer.from([1, 2, 3])));
  await nextTurn();
  assert.deepEqual(messages[0], { type: "text", text: "hello" });
  assert.equal(messages[1].type, "binary");
  assert.deepEqual([...messages[1].data], [1, 2, 3]);

  socket.emit("data", encodeClientFrame(0x1, Buffer.from("collab"), { fin: false }));
  socket.emit("data", encodeClientFrame(0x9, Buffer.from("p")));
  socket.emit("data", encodeClientFrame(0x0, Buffer.from("oration"), { fin: true }));
  await nextTurn();
  assert.deepEqual(messages[2], { type: "text", text: "collaboration" });
  const pong = decodeServerFrame(socket.writes.at(-1));
  assert.equal(pong.opcode, 0xA);
  assert.equal(pong.payload.toString("utf8"), "p");

  connection.sendJson({ type: "ready" });
  const jsonFrame = decodeServerFrame(socket.writes.at(-1));
  assert.equal(jsonFrame.opcode, 0x1);
  assert.deepEqual(JSON.parse(jsonFrame.payload.toString("utf8")), { type: "ready" });

  const invalidSocket = new FakeSocket();
  const invalidConnection = new WebSocketConnection(invalidSocket, 128);
  invalidConnection.start();
  invalidSocket.emit("data", encodeClientFrame(0x1, Buffer.from("unmasked"), { masked: false }));
  const closeFrame = decodeServerFrame(invalidSocket.writes.at(-1));
  assert.equal(closeFrame.opcode, 0x8);
  assert.equal(closeFrame.payload.readUInt16BE(0), 1002);

  connection.terminate();
  invalidConnection.terminate();
}

function expectApiError(action, code) {
  assert.throws(action, (error) => error instanceof CollaborationDocumentError && error.code === code);
}

function verifyCollaborationHierarchy() {
  const ordered = validateCollaborationBlockHierarchy([
    { id: "child-b", parentBlockId: "root", sortOrder: 20 },
    { id: "root", parentBlockId: null, sortOrder: 10 },
    { id: "child-a", parentBlockId: "root", sortOrder: 10 }
  ]);
  assert.deepEqual(ordered.map((block) => block.id), ["root", "child-a", "child-b"]);

  expectApiError(
    () => validateCollaborationBlockHierarchy([
      { id: "same", parentBlockId: null, sortOrder: 0 },
      { id: "same", parentBlockId: null, sortOrder: 1 }
    ]),
    "DUPLICATE_BLOCK_ID"
  );
  expectApiError(
    () => validateCollaborationBlockHierarchy([
      { id: "orphan", parentBlockId: "missing", sortOrder: 0 }
    ]),
    "INVALID_PARENT_BLOCK"
  );
  expectApiError(
    () => validateCollaborationBlockHierarchy([
      { id: "a", parentBlockId: "b", sortOrder: 0 },
      { id: "b", parentBlockId: "a", sortOrder: 0 }
    ]),
    "INVALID_PARENT_BLOCK"
  );

  const tooDeep = [];
  for (let index = 0; index < 130; index += 1) {
    tooDeep.push({
      id: `depth-${index}`,
      parentBlockId: index === 0 ? null : `depth-${index - 1}`,
      sortOrder: index
    });
  }
  expectApiError(() => validateCollaborationBlockHierarchy(tooDeep), "BLOCK_NESTING_TOO_DEEP");
}

function verifySourceWiring() {
  assertContains("migrations/020_page_sharing_yjs_collaboration.sql", [
    "CREATE TABLE IF NOT EXISTS page_shares",
    "CREATE TABLE IF NOT EXISTS page_yjs_updates",
    "CREATE TABLE IF NOT EXISTS page_collaboration_state",
    "FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE"
  ]);
  assertContains("migrations/021_collaboration_document_epoch.sql", [
    "ADD COLUMN IF NOT EXISTS document_epoch",
    "WHERE document_epoch IS NULL OR document_epoch = ''",
    "MODIFY COLUMN document_epoch VARCHAR(64) NOT NULL"
  ]);
  assertContains("migrations/022_server_authoritative_collaboration_materialization.sql", [
    "ADD COLUMN IF NOT EXISTS materialization_version",
    "SMALLINT UNSIGNED NOT NULL DEFAULT 0"
  ]);
  assertContains("src/lib/collaboration-lineage.ts", [
    "ensureCollaborationState",
    "assertCollaborationDocumentEpoch",
    "COLLABORATION_LINEAGE_CHANGED",
    "SELECT page_id, document_epoch, materialized_update_id, materialization_version"
  ]);
  assertContains("src/lib/collaboration-token.ts", [
    "documentEpoch: string",
    "decoded.documentEpoch",
    "documentEpoch: decoded.documentEpoch"
  ]);
  assertContains("src/server.ts", [
    "attachPageCollaborationServer",
    "createHttpServer(app)",
    "createHttpsServer(poshAcmeTls.options, app)",
    "await collaborationHub.close()"
  ]);
  assertContains("src/app.ts", [
    "connectSrc: [\"'self'\", ...configuredWebSocketOrigins]",
    "app.use(\"/api\", collaborationRouter)"
  ]);
  assertContains("src/lib/collaboration-server.ts", [
    'collaborationWebSocketProtocol = "brainvault-yjs-v2"',
    "verifyCollaborationToken",
    "isAllowedOrigin(request)",
    "Never derive the expected browser host from X-Forwarded-Host",
    "currentAccess = await getPageAccess",
    "maxCollaborationUpdateBytes",
    "maxCollaborationDocumentBytes",
    "validationPool.validate",
    "validation.stateUpdate",
    "assessCollaborationWriteCheckpoint",
    "roomUpdateId: room.maxUpdateId",
    'result.reason === "room-stale"',
    "broadcastCanonicalAttachment",
    "bootstrapWritePending",
    "pendingWrites",
    "assertCollaborationDocumentEpoch(collaborationState, payload.documentEpoch)",
    "assertCollaborationDocumentEpoch(collaborationState, client.documentEpoch)",
    "invalidateRoomForLineageChange",
    "assessInitialCollaborationBootstrap",
    "currentUpdateId === 0",
    'reason: "bootstrap-mismatch"',
    "client.socket.close(4012",
    "4011"
  ]);
  const collaborationServerSource = read("src/lib/collaboration-server.ts");
  assert.ok(
    !collaborationServerSource.includes('request.headers["x-forwarded-host"]'),
    "WebSocket origin validation must not trust a client-controlled forwarded host"
  );
  assertContains("src/lib/yjs-validation.ts", [
    'import * as Y from "yjs"',
    "createValidatedYjsDocument",
    "applyValidatedYjsUpdate",
    "applyValidatedYjsStateUpdate",
    "Y.encodeStateAsUpdate",
    "Y.applyUpdate"
  ]);
  assertContains("src/lib/collaboration-protocol.ts", [
    "currentCollaborationMaterializationVersion = 1",
    "latestUpdateId !== state.materializedUpdateId",
    "state.materializationVersion !== currentCollaborationMaterializationVersion",
    "roomUpdateId !== durableUpdateId",
    'reason: "room-stale"',
    'reason: "snapshot-base-mismatch"'
  ]);
  assertContains("src/lib/collaboration-materialization.ts", [
    "materializeCollaborationUpdates",
    "createValidatedYjsDocument",
    "INVALID_COLLABORATION_DOCUMENT",
    "unsafeObjectKeys",
    "validateCollaborationBlockHierarchy"
  ]);
  assertContains("src/lib/collaboration-bootstrap.ts", [
    "assessInitialCollaborationBootstrap",
    "candidate.title !== pageTitle",
    "missingBlockCount",
    "extraBlockCount",
    "changedBlockCount",
    "candidate.deletedAttachmentIds.length"
  ]);
  assertContains("src/routes/collaboration.routes.ts", [
    "COLLABORATION_SNAPSHOT_STALE",
    "SELECT id, update_data",
    "ORDER BY id ASC",
    "FOR UPDATE",
    "materializeCollaborationUpdates",
    "currentCollaborationMaterializationVersion",
    "needsCollaborationMaterialization",
    "USE_ATTACHMENT_UPLOAD",
    "COLLABORATION_CHANGES_PENDING",
    "deletedExistingIds",
    "The block parent FK uses ON DELETE CASCADE",
    "documentEpochProtocol: z.literal(2)",
    "COLLABORATION_CLIENT_REFRESH_REQUIRED",
    "documentEpoch: session.collaborationState.document_epoch",
    "assertCollaborationDocumentEpoch(state, body.documentEpoch)",
    "WHERE page_id = ? AND document_epoch = ?"
  ]);
  const collaborationRouteSource = read("src/routes/collaboration.routes.ts");
  assert.ok(
    !/body\.(?:title|blocks|deletedAttachmentIds)/.test(collaborationRouteSource),
    "relational materialization must not consume duplicate browser content"
  );
  assert.ok(
    collaborationRouteSource.indexOf("const deletedExistingIds")
      < collaborationRouteSource.indexOf('DELETE FROM blocks WHERE id = ? AND page_id = ?'),
    "surviving children must be detached before obsolete parent rows are deleted"
  );
  assertContains("src/routes/page.routes.ts", [
    "assertCollaborationMaterialized",
    "materialization_version",
    "needsCollaborationMaterialization",
    "COLLABORATION_REQUIRED",
    "COLLABORATION_CHANGES_PENDING"
  ]);
  assertContains("src/routes/block.routes.ts", [
    "assertDirectBlockMutationAllowed",
    "broadcastCanonicalAttachment",
    "PAGE_ARCHIVED"
  ]);
  assertContains("src/lib/data-transfer.ts", [
    "FROM page_shares ps INNER JOIN pages p",
    "materialization_version",
    "needsCollaborationMaterialization",
    'disconnectPageCollaborators(pageId, "Workspace data is being restored")'
  ]);
  const dataTransferSource = read("src/lib/data-transfer.ts");
  const restoreDisconnectIndex = dataTransferSource.indexOf(
    'disconnectPageCollaborators(pageId, "Workspace data is being restored")'
  );
  const restoreImportIndex = dataTransferSource.indexOf("await importRows(", restoreDisconnectIndex);
  assert.ok(
    restoreDisconnectIndex >= 0 && restoreImportIndex > restoreDisconnectIndex,
    "live collaboration rooms must be invalidated before restored rows replace the workspace"
  );
  assertContains("public/collaboration.js", [
    'const YJS_MODULE_URL = "/vendor/yjs/yjs.mjs";',
    'const RECOVERY_ORIGIN = Object.freeze({ kind: "recovery" });',
    "Y.applyUpdate",
    "Y.encodeStateAsUpdate",
    "get hasUnconfirmedLocalChanges()",
    "persistLocalRecovery",
    "restoreLocalRecovery",
    "clearLocalRecovery",
    "The collaboration recovery state could not be encoded for synchronization",
    "The collaboration snapshot could not be queued",
    "if (this.sendDocumentUpdate(fullStateUpdate)) this.needsRecovery = false",
    "this.pendingPreparedLocalMutations,",
    "this.recoveryStore.removeDurably(",
    "this.currentRecoveryGeneration",
    "if (this.startupUpdatePending && !this.needsRecovery)",
    "if (flush && this.hasUnconfirmedLocalChanges && !this.isReady)",
    "canonical-attachment",
    'from "./collaboration-attachment-reconcile.js"',
    "reconcileCanonicalAttachment(candidate, current, availableIds)",
    "clearMaterializedAttachmentTombstones",
    "The document kept changing while it was being materialized",
    "documentEpoch: snapshot.documentEpoch",
    "updateId: snapshot.updateId",
    "body: { documentEpochProtocol: 2 }",
    "this.documentEpoch = documentEpoch",
    "this.restoreLocalRecovery(documentEpoch)",
    "record.documentEpoch === documentEpoch",
    "if (this.recoveredLocalRecords.length || this.title.length || this.blocks.size) return",
    "event.code === 4003 || event.code === 4010 || event.code === 4011",
    "event.code === 4012",
    "resetForCanonicalBootstrapRetry",
    "replaceLiveDocument(new this.Y.Doc())",
    "could not be decoded and was preserved",
    "Collaboration recovery records from different document versions cannot be merged"
  ]);
  assertContains("public/index.html", [
    '<script type="importmap">{"imports":{"lib0/":"/vendor/yjs/lib0/","isomorphic.js":"/vendor/yjs/isomorphic/browser.mjs"}}</script>'
  ]);
  assertContains("src/app.ts", [
    'app.get("/vendor/yjs/yjs.mjs"',
    'app.get("/vendor/yjs/isomorphic/browser.mjs"',
    '"/vendor/yjs/lib0"',
    "'sha256-AQrGHmNf2ToDPODxkNyXldxWl9tWr2pnwbahY0pFneE='"
  ]);
  const collaborationClientSource = read("public/collaboration.js");
  assert.ok(
    !collaborationClientSource.includes("https://cdn.jsdelivr.net/npm/yjs@"),
    "the collaboration client must not execute a remote Yjs runtime"
  );
  assert.ok(
    !collaborationClientSource.includes("body: snapshot"),
    "the browser must not submit a second, independently trusted content snapshot"
  );
  assert.ok(
    collaborationClientSource.indexOf("this.documentEpoch = documentEpoch")
      < collaborationClientSource.indexOf("this.restoreLocalRecovery(documentEpoch)"),
    "browser recovery must not be read until the server-issued document epoch is known"
  );
  assertContains("public/collaboration-exit-guard.js", ["assertCollaborationExitSafe"]);
  assertContains("public/collaboration-recovery-store.js", [
    "brainvault.collaborationRecovery.v1",
    "const recoverySchemaVersion = 3",
    "const base64RecoverySchemaVersion = 2",
    "const legacyRecoverySchemaVersion = 1",
    "encodeURIComponent(documentEpoch)",
    "bytesToBase64",
    "base64ToBytes",
    "loadPageRecords"
  ]);
  assertContains("public/page-transition-lock.js", [
    "brainvault.pageTransition.v1",
    "function acquire(pageId, kind, exclusiveId = pageId)",
    "async function runExclusive(pageId, action)",
    "ifAvailable: true"
  ]);
  assertContains("public/app.js", [
    "createPageCollaboration",
    "assertCollaborationExitSafe",
    "recoverySourceId: pageDraftSourceId",
    "recoveryStore: collaborationRecoveryStore",
    "flushMaterialization({ compact: collaborationCompact })",
    "flushPendingPageEdits({ allowLocked: true, collaborationCompact: false })",
    "pageTransitionLock.runExclusive(exclusiveTransitionIds",
    "assertNoPendingLocalPageDrafts(pageId)",
    "assertNoPendingLocalCollaborationRecovery(pageId)",
    "refreshCollaborativePageDraftRecovery",
    "adoptAttachment",
    "sharing.syncRequired",
    "collaboration-active-or-stale",
    "documentEpoch: group.documentEpoch",
    "documentEpoch: record.documentEpoch"
  ]);
  assertContains("public/index.html", ["id=\"share-page-layer\"", "id=\"collaboration-indicator\""]);
}


function verifyInitialBootstrapFence() {
  const storedBlocks = [
    {
      id: "important",
      page_id: "page",
      parent_block_id: null,
      type: "MARKDOWN",
      markdown: "must survive",
      html_cache: "<p>must survive</p>",
      checked: 0,
      sort_order: 0,
      metadata: JSON.stringify({ nested: { z: 2, a: 1 } }),
      created_at: "2026-07-30 00:00:00",
      updated_at: "2026-07-30 00:00:00"
    }
  ];
  const exact = assessInitialCollaborationBootstrap({
    pageTitle: "Canonical page",
    storedBlocks,
    candidate: {
      title: "Canonical page",
      blocks: [{
        id: "important",
        type: "MARKDOWN",
        markdown: "must survive",
        checked: false,
        parentBlockId: null,
        sortOrder: 0,
        metadata: { nested: { a: 1, z: 2 } }
      }],
      deletedAttachmentIds: []
    }
  });
  assert.deepEqual(exact, { accepted: true });

  const incomplete = assessInitialCollaborationBootstrap({
    pageTitle: "Canonical page",
    storedBlocks,
    candidate: {
      title: "Canonical page",
      blocks: [],
      deletedAttachmentIds: []
    }
  });
  assert.equal(incomplete.accepted, false);
  assert.equal(incomplete.summary.missingBlockCount, 1);

  const reproduction = JSON.parse(execFileSync(
    process.execPath,
    ["--experimental-strip-types", join(rootDir, "scripts/reproduce-collaboration-bootstrap-loss.mjs")],
    { cwd: rootDir, encoding: "utf8" }
  ));
  assert.equal(reproduction.vulnerable.permanentLossWindowReproduced, true);
  assert.equal(reproduction.fixed.bootstrapAccepted, false);
  assert.equal(reproduction.fixed.relationalBlockCountAfterRejectedBootstrap, 2);
  assert.equal(reproduction.fixed.permanentLossWindowClosed, true);
}


function verifyMaterializationProvenance() {
  assert.equal(needsCollaborationMaterialization({
    latestUpdateId: 0,
    materializedUpdateId: 0,
    materializationVersion: 0
  }), false);
  assert.equal(needsCollaborationMaterialization({
    latestUpdateId: 9,
    materializedUpdateId: 9,
    materializationVersion: 0
  }), true);
  assert.equal(needsCollaborationMaterialization({
    latestUpdateId: 9,
    materializedUpdateId: 9,
    materializationVersion: currentCollaborationMaterializationVersion
  }), false);
  assert.equal(needsCollaborationMaterialization({
    latestUpdateId: 9,
    materializedUpdateId: 10,
    materializationVersion: currentCollaborationMaterializationVersion
  }), true);

  const reproduction = JSON.parse(execFileSync(
    process.execPath,
    [join(rootDir, "scripts/reproduce-collaboration-materialization-loss.mjs")],
    { cwd: rootDir, encoding: "utf8" }
  ));
  assert.equal(reproduction.vulnerable.permanentLossWindowReproduced, true);
  assert.equal(reproduction.fixed.requestCarriesContent, false);
  assert.equal(reproduction.fixed.legacyCheckpointRequiresRematerialization, true);
  assert.equal(reproduction.fixed.permanentLossWindowClosed, true);
}


function verifyCrossInstanceWriteFence() {
  assert.deepEqual(assessCollaborationWriteCheckpoint({
    durableUpdateId: 10,
    roomUpdateId: 9,
    snapshot: false,
    snapshotBaseUpdateId: null
  }), {
    accepted: false,
    currentUpdateId: 10,
    reason: "room-stale"
  });
  assert.deepEqual(assessCollaborationWriteCheckpoint({
    durableUpdateId: 10,
    roomUpdateId: 10,
    snapshot: true,
    snapshotBaseUpdateId: 9
  }), {
    accepted: false,
    currentUpdateId: 10,
    reason: "snapshot-base-mismatch"
  });
  assert.deepEqual(assessCollaborationWriteCheckpoint({
    durableUpdateId: 10,
    roomUpdateId: 10,
    snapshot: true,
    snapshotBaseUpdateId: 10
  }), { accepted: true });

  const reproduction = JSON.parse(execFileSync(
    process.execPath,
    [join(rootDir, "scripts/reproduce-cross-instance-compaction-loss.mjs")],
    { cwd: rootDir, encoding: "utf8" }
  ));
  assert.equal(reproduction.vulnerable.permanentLossWindowReproduced, true);
  assert.equal(reproduction.fixed.staleNormalWriteRejected, true);
  assert.equal(reproduction.fixed.staleRoomInvalidated, true);
  assert.equal(reproduction.fixed.permanentLossWindowClosed, true);
}


function verifyAttachmentPositionReconciliation() {
  const canonical = {
    id: "att_1",
    type: "ATTACHMENT",
    markdown: "canonical.pdf",
    checked: false,
    parentBlockId: "old_parent",
    sortOrder: 8,
    metadata: { attachment: { originalName: "canonical.pdf", size: 10 } }
  };
  const current = {
    ...canonical,
    markdown: "untrusted-name.txt",
    parentBlockId: "new_parent",
    sortOrder: 2,
    metadata: { attachment: { originalName: "untrusted-name.txt", size: 1 } }
  };
  const reconciled = reconcileCanonicalAttachment(
    canonical,
    current,
    new Set(["att_1", "old_parent", "new_parent"])
  );
  assert.equal(reconciled.parentBlockId, "new_parent");
  assert.equal(reconciled.sortOrder, 2);
  assert.equal(reconciled.markdown, "canonical.pdf");
  assert.deepEqual(reconciled.metadata, canonical.metadata);

  const reproduction = JSON.parse(execFileSync(
    process.execPath,
    [join(rootDir, "scripts/reproduce-attachment-position-loss.mjs")],
    { cwd: rootDir, encoding: "utf8" }
  ));
  assert.equal(reproduction.vulnerable.permanentLossWindowReproduced, true);
  assert.equal(reproduction.fixed.acknowledgedMoveSurvived, true);
  assert.equal(reproduction.fixed.canonicalImmutableContentPreserved, true);
  assert.equal(reproduction.fixed.missingAttachmentUsesSqlLocation, true);
  assert.equal(reproduction.fixed.permanentLossWindowClosed, true);
}


function createMemoryStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

function verifyRecoveryLineageIsolation() {
  const storage = createMemoryStorage();
  const store = createCollaborationRecoveryStore(storage);
  const oldGeneration = store.save("user", "page", "tab", "epoch_old", new Uint8Array([1]));
  const newGeneration = store.save("user", "page", "tab", "epoch_new", new Uint8Array([2]));
  assert.ok(oldGeneration && newGeneration && oldGeneration !== newGeneration);

  const recordsByEpoch = new Map(
    store.loadAll("user", "page").map((record) => [record.documentEpoch, [...record.update]])
  );
  assert.deepEqual(recordsByEpoch.get("epoch_old"), [1]);
  assert.deepEqual(recordsByEpoch.get("epoch_new"), [2]);
  assert.equal(store.remove("user", "page", "tab", "epoch_old", oldGeneration), true);
  assert.deepEqual(store.loadAll("user", "page").map((record) => record.documentEpoch), ["epoch_new"]);

  storage.setItem(
    "brainvault.collaborationRecovery.v1:user:legacy-page:tab",
    JSON.stringify({
      schemaVersion: 1,
      accountId: "user",
      pageId: "legacy-page",
      sourceId: "tab",
      generation: "legacy-generation",
      updatedAt: 1,
      update: btoa(String.fromCharCode(9))
    })
  );
  assert.deepEqual(
    store.loadAll("user", "legacy-page").map(({ documentEpoch, legacy }) => ({ documentEpoch, legacy })),
    [{ documentEpoch: null, legacy: true }]
  );

  const corruptKey = "brainvault.collaborationRecovery.v1:user:page:corrupt";
  storage.setItem(corruptKey, "{not-json");
  assert.deepEqual(store.loadAll("user", "page").map((record) => record.documentEpoch), ["epoch_new"]);
  assert.equal(storage.getItem(corruptKey), "{not-json", "undecodable recovery bytes must be preserved");
}

function verifyRecoveryAcknowledgementSafety() {
  assert.equal(shouldClearLocalRecoveryAfterAck(0, 0, true), false);
  assert.equal(shouldClearLocalRecoveryAfterAck(1, 0, false), false);
  assert.equal(shouldClearLocalRecoveryAfterAck(0, 1, false), false);
  assert.equal(shouldClearLocalRecoveryAfterAck(0, 0, false), true);
}

function verifyDependencyPins() {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  assert.equal(packageJson.dependencies?.yjs, "13.6.31", "package.json must pin Yjs exactly");
  assert.equal(packageLock.packages?.[""]?.dependencies?.yjs, "13.6.31");
  assert.equal(packageLock.packages?.["node_modules/yjs"]?.version, "13.6.31");
  assert.equal(
    packageLock.packages?.["node_modules/yjs"]?.integrity,
    "sha512-Eq+5BRfbeGyqGVrTJL3bEcr8gKkxPuyuoHmAwpk52fDb8kOVMrfVSTRPd6yiGgX5Fskb96qCRjzjbRjrL4YEnw=="
  );
  assert.equal(packageLock.packages?.["node_modules/lib0"]?.version, "0.2.99");
  assert.equal(packageLock.packages?.["node_modules/isomorphic.js"]?.version, "0.2.5");
}

function checkSyntax(path) {
  const args = path.endsWith(".ts")
    ? ["--experimental-strip-types", "--check", path]
    : ["--check", path];
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, NODE_NO_WARNINGS: "1" }
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const details = String(stderr ?? "").trim();
        error.message = `Syntax check failed for ${path}: ${error.message}${details ? `\n${details}` : ""}`;
        reject(error);
      }
    );
  });
}

async function verifySyntax() {
  const sourceDirectories = ["src", "scripts", "tests", "public"];
  const files = sourceDirectories
    .flatMap((directory) => walk(join(rootDir, directory), [".ts", ".js", ".mjs"]))
    .filter((path) => !path.endsWith(".d.ts"));
  const workerCount = Math.min(8, Math.max(1, files.length));
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < files.length) {
      const path = files[nextIndex];
      nextIndex += 1;
      await checkSyntax(path);
    }
  }));
  return files.length;
}

async function main() {
  verifySourceWiring();
  verifyDependencyPins();
  verifyRecoveryAcknowledgementSafety();
  verifyRecoveryLineageIsolation();
  verifyCollaborationHierarchy();
  verifyInitialBootstrapFence();
  verifyMaterializationProvenance();
  verifyCrossInstanceWriteFence();
  verifyAttachmentPositionReconciliation();
  await verifyWebSocketProtocol();
  const checkedFiles = await verifySyntax();
  console.log(`[verify-collaboration] OK: source wiring, exact Yjs dependency pins, recovery acknowledgement safety, document-lineage isolation, server-authoritative materialization provenance, SQL-fenced first-document bootstrap, cross-instance durable-room freshness, stale-SQL attachment-position fencing, hierarchy invariants, RFC 6455 protocol behavior, and syntax for ${checkedFiles} file(s).`);
}

main().catch((error) => {
  console.error("[verify-collaboration] FAILED");
  console.error(error);
  process.exitCode = 1;
});
