import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocketConnection } from "../src/lib/websocket.ts";

class FakeSocket extends EventEmitter {
  destroyed = false;
  paused = false;
  writableLength = 0;
  writes = [];

  write(value) {
    this.writes.push(Buffer.from(value));
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

class SlowSocket extends FakeSocket {
  write(value) {
    this.writableLength += Buffer.byteLength(value);
    this.writes.push(Buffer.from(value));
    return false;
  }
}

function createClientFrame(opcode, payload) {
  const data = Buffer.from(payload);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const header = Buffer.alloc(2 + (data.length < 126 ? 0 : data.length <= 0xffff ? 2 : 8));
  header[0] = 0x80 | opcode;
  let offset = 2;
  if (data.length < 126) {
    header[1] = 0x80 | data.length;
  } else if (data.length <= 0xffff) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
    offset = 4;
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
    offset = 10;
  }
  const encoded = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) {
    encoded[index] = data[index] ^ mask[index % 4];
  }
  return Buffer.concat([header.subarray(0, offset), mask, encoded]);
}

function parseCloseFrame(writes) {
  const frame = [...writes].reverse().find((value) => (value[0] & 0x0f) === 0x08);
  assert.ok(frame, "expected a WebSocket close frame");
  const payloadLength = frame[1] & 0x7f;
  const payload = frame.subarray(2, 2 + payloadLength);
  return {
    code: payload.readUInt16BE(0),
    reason: payload.subarray(2).toString("utf8")
  };
}

test("WebSocket async handlers cannot accumulate an unbounded inbound message backlog", async () => {
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket, 1_024);
  let releaseHandler;
  const blocked = new Promise((resolve) => {
    releaseHandler = resolve;
  });
  let handledMessages = 0;

  connection.onMessage(async () => {
    handledMessages += 1;
    await blocked;
  });
  connection.start();
  for (let index = 0; index < 100; index += 1) {
    socket.emit("data", createClientFrame(0x2, Buffer.from([index])));
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(parseCloseFrame(socket.writes), {
    code: 1008,
    reason: "WebSocket message backlog exceeded"
  });
  assert.equal(socket.paused, true);
  assert.equal(handledMessages, 1);

  releaseHandler();
  connection.terminate();
});

test("WebSocket slow consumers are terminated before output buffering grows without bound", () => {
  const socket = new SlowSocket();
  const connection = new WebSocketConnection(socket, 1024 * 1024);

  for (let index = 0; index < 10_000 && connection.isOpen; index += 1) {
    connection.sendBinary(Buffer.alloc(64 * 1024));
  }

  assert.equal(socket.destroyed, true);
  assert.equal(connection.isOpen, false);
  assert.ok(socket.writes.length <= 32, `unexpected write count: ${socket.writes.length}`);
  assert.ok(socket.writableLength <= 2_100_000, `unexpected buffered bytes: ${socket.writableLength}`);
});

test("WebSocket receive buffering does not repeatedly concatenate a drip-fed frame", async () => {
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket, 512 * 1024);
  const frame = createClientFrame(0x2, Buffer.alloc(256 * 1024, 0x5a));
  let message = null;
  connection.onMessage((value) => {
    message = value;
  });
  connection.start();

  const originalConcat = Buffer.concat;
  let concatCalls = 0;
  Buffer.concat = function patchedConcat(...args) {
    concatCalls += 1;
    return originalConcat.apply(Buffer, args);
  };
  try {
    for (let index = 0; index < frame.length; index += 1) {
      socket.emit("data", frame.subarray(index, index + 1));
    }
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    Buffer.concat = originalConcat;
    connection.terminate();
  }

  assert.equal(concatCalls, 0, "drip-fed receive path must not recopy the accumulated buffer");
  assert.equal(message?.type, "binary");
  assert.equal(message?.data.length, 256 * 1024);
});
