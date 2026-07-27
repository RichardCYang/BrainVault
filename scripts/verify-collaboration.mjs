import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    parseWebSocketProtocols(["brainvault-yjs-v1", " brainvault-ticket.token , secondary"]),
    ["brainvault-yjs-v1", "brainvault-ticket.token", "secondary"]
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
    selectedProtocol: "brainvault-yjs-v1",
    maxMessageBytes: 1024
  });
  assert.ok(upgraded instanceof WebSocketConnection);
  const response = Buffer.concat(handshakeSocket.writes).toString("utf8");
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/);
  assert.match(response, /Sec-WebSocket-Protocol: brainvault-yjs-v1\r\n/);

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
  assertContains("src/server.ts", [
    "attachPageCollaborationServer",
    "createServer(app)",
    "await collaborationHub.close()"
  ]);
  assertContains("src/app.ts", [
    "connectSrc: [\"'self'\", \"ws:\", \"wss:\"]",
    "app.use(\"/api\", collaborationRouter)"
  ]);
  assertContains("src/lib/collaboration-server.ts", [
    "verifyCollaborationToken",
    "isAllowedOrigin(request)",
    "Never derive the expected browser host from X-Forwarded-Host",
    "currentAccess = await getPageAccess",
    "maxYjsUpdateBytes",
    "applyValidatedYjsUpdate",
    "candidate.stateUpdate",
    "broadcastCanonicalAttachment",
    "bootstrapWritePending",
    "pendingWrites"
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
    "Y.encodeStateAsUpdate",
    "Y.applyUpdate"
  ]);
  assertContains("src/routes/collaboration.routes.ts", [
    "COLLABORATION_SNAPSHOT_STALE",
    "validateCollaborationBlockHierarchy",
    "USE_ATTACHMENT_UPLOAD",
    "COLLABORATION_CHANGES_PENDING",
    "deletedExistingIds",
    "The block parent FK uses ON DELETE CASCADE",
    "Page title cannot be blank"
  ]);
  const collaborationRouteSource = read("src/routes/collaboration.routes.ts");
  assert.ok(
    collaborationRouteSource.indexOf("const deletedExistingIds")
      < collaborationRouteSource.indexOf('DELETE FROM blocks WHERE id = ? AND page_id = ?'),
    "surviving children must be detached before obsolete parent rows are deleted"
  );
  assertContains("src/routes/page.routes.ts", [
    "assertCollaborationMaterialized",
    "COLLABORATION_REQUIRED",
    "COLLABORATION_CHANGES_PENDING"
  ]);
  assertContains("src/routes/block.routes.ts", [
    "assertDirectBlockMutationAllowed",
    "broadcastCanonicalAttachment",
    "PAGE_ARCHIVED"
  ]);
  assertContains("public/collaboration.js", [
    "https://cdn.jsdelivr.net/npm/yjs@13.6.31/+esm",
    'const RECOVERY_ORIGIN = Object.freeze({ kind: "recovery" });',
    "Y.applyUpdate",
    "Y.encodeStateAsUpdate",
    "get hasUnconfirmedLocalChanges()",
    "persistLocalRecovery",
    "restoreLocalRecovery",
    "clearLocalRecovery",
    "if (flush && this.hasUnconfirmedLocalChanges && !this.isReady)",
    "canonical-attachment",
    "clearMaterializedAttachmentTombstones",
    "The document kept changing while it was being materialized"
  ]);
  assertContains("public/collaboration-exit-guard.js", ["assertCollaborationExitSafe"]);
  assertContains("public/collaboration-recovery-store.js", [
    "brainvault.collaborationRecovery.v1",
    "bytesToBase64",
    "base64ToBytes"
  ]);
  assertContains("public/app.js", [
    "createPageCollaboration",
    "assertCollaborationExitSafe",
    "recoverySourceId: pageDraftSourceId",
    "recoveryStore: collaborationRecoveryStore",
    "flushMaterialization({ compact: collaborationCompact })",
    "flushPendingPageEdits({ collaborationCompact: false })",
    "adoptAttachment",
    "sharing.syncRequired"
  ]);
  assertContains("public/index.html", ["id=\"share-page-layer\"", "id=\"collaboration-indicator\""]);
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

function verifySyntax() {
  const sourceDirectories = ["src", "scripts", "tests", "public"];
  const files = sourceDirectories
    .flatMap((directory) => walk(join(rootDir, directory), [".ts", ".js", ".mjs"]))
    .filter((path) => !path.endsWith(".d.ts"));
  for (const path of files) {
    const args = path.endsWith(".ts")
      ? ["--experimental-strip-types", "--check", path]
      : ["--check", path];
    execFileSync(process.execPath, args, { stdio: "pipe" });
  }
  return files.length;
}

async function main() {
  verifySourceWiring();
  verifyDependencyPins();
  verifyCollaborationHierarchy();
  await verifyWebSocketProtocol();
  const checkedFiles = verifySyntax();
  console.log(`[verify-collaboration] OK: source wiring, exact Yjs dependency pins, hierarchy invariants, RFC 6455 protocol behavior, and syntax for ${checkedFiles} file(s).`);
}

main().catch((error) => {
  console.error("[verify-collaboration] FAILED");
  console.error(error);
  process.exitCode = 1;
});
