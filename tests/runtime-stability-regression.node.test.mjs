import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WebSocketConnection } from "../src/lib/websocket.ts";

class FaultInjectingSocket extends EventEmitter {
  destroyed = false;
  paused = false;
  writableLength = 0;
  writes = [];
  throwOnWrite = false;

  write(value) {
    if (this.throwOnWrite) throw new Error("injected socket write failure");
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

function createClientFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.from(payload);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  assert.ok(data.length < 126, "test helper only supports short payloads");
  const header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
  const encoded = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) {
    encoded[index] = data[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, encoded]);
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

function withMutedConsoleError(action) {
  const original = console.error;
  console.error = () => {};
  try {
    return action();
  } finally {
    console.error = original;
  }
}

test("WebSocket constructor rejects invalid runtime message limits before buffer arithmetic", () => {
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new WebSocketConnection(new FaultInjectingSocket(), invalid),
      { name: "RangeError" },
      `expected maxMessageBytes=${String(invalid)} to be rejected`
    );
  }
});

test("WebSocket sendJson contains JSON serialization edge cases instead of throwing into callers", () => {
  const circular = {};
  circular.self = circular;
  for (const value of [undefined, 1n, circular]) {
    const socket = new FaultInjectingSocket();
    const connection = new WebSocketConnection(socket, 1024);

    withMutedConsoleError(() => {
      assert.doesNotThrow(() => connection.sendJson(value));
    });

    assert.deepEqual(parseCloseFrame(socket.writes), {
      code: 1011,
      reason: "WebSocket JSON serialization failed"
    });
    connection.terminate();
  }
});

test("WebSocket socket write failures cannot escape the EventEmitter data callback", () => {
  const socket = new FaultInjectingSocket();
  const connection = new WebSocketConnection(socket, 1024);
  connection.start();
  socket.throwOnWrite = true;

  withMutedConsoleError(() => {
    assert.doesNotThrow(() => socket.emit("data", createClientFrame(0x9)));
  });

  assert.equal(socket.destroyed, true);
  assert.equal(connection.isOpen, false);
});

test("WebSocket close callbacks cannot crash the process event boundary", () => {
  const socket = new FaultInjectingSocket();
  const connection = new WebSocketConnection(socket, 1024);
  connection.onClose(() => {
    throw new Error("injected close callback failure");
  });
  connection.start();

  withMutedConsoleError(() => {
    assert.doesNotThrow(() => socket.emit("error", new Error("injected transport error")));
  });

  assert.equal(connection.isOpen, false);
});

test("collaboration presence fan-out observes every detached promise outcome", () => {
  const source = readFileSync(new URL("../src/lib/collaboration-server.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const start = source.indexOf("  private broadcastPresenceUpdate(");
  const end = source.indexOf("  private clearBootstrapLeaderTimer(", start);
  assert.ok(start >= 0 && end > start, "missing broadcastPresenceUpdate source section");
  const section = source.slice(start, end);

  assert.doesNotMatch(section, /void Promise\.all\(/, "detached Promise.all can reject without an observer");
  assert.match(section, /Promise\.allSettled\(/, "presence fan-out should settle every recipient task");
});
