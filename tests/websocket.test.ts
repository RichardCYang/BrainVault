import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  WebSocketConnection,
  acceptWebSocketUpgrade,
  parseWebSocketProtocols
} from "../src/lib/websocket.js";

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: Buffer[] = [];
  paused = false;

  write(value: string | Uint8Array) {
    this.writes.push(Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value));
    return true;
  }

  end(value?: string | Uint8Array) {
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

function clientFrame(opcode: number, payload: Uint8Array, masked = true, fin = true) {
  const data = Buffer.from(payload);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const header = Buffer.alloc(2 + (masked ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = (masked ? 0x80 : 0) | data.length;
  if (!masked) return Buffer.concat([header, data]);
  mask.copy(header, 2);
  const encoded = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) encoded[index] = data[index] ^ mask[index % 4];
  return Buffer.concat([header, encoded]);
}

function serverFrame(frame: Buffer) {
  const length = frame[1] & 0x7f;
  return { opcode: frame[0] & 0x0f, payload: frame.subarray(2, 2 + length) };
}

describe("dependency-free RFC 6455 transport", () => {
  it("parses offered protocols and produces the RFC handshake accept value", () => {
    expect(parseWebSocketProtocols(["brainvault-yjs-v2", " brainvault-ticket.jwt "])).toEqual([
      "brainvault-yjs-v2",
      "brainvault-ticket.jwt"
    ]);

    const socket = new FakeSocket();
    const connection = acceptWebSocketUpgrade(
      {
        headers: {
          upgrade: "websocket",
          connection: "keep-alive, Upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ=="
        }
      } as never,
      socket as never,
      { selectedProtocol: "brainvault-yjs-v2", maxMessageBytes: 1024 }
    );

    expect(connection).toBeInstanceOf(WebSocketConnection);
    const response = Buffer.concat(socket.writes).toString("utf8");
    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(response).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    expect(response).toContain("Sec-WebSocket-Protocol: brainvault-yjs-v2");
    connection?.terminate();
  });

  it("accepts masked text/binary frames and rejects an unmasked client frame", async () => {
    const socket = new FakeSocket();
    const connection = new WebSocketConnection(socket as never, 1024);
    const messages: unknown[] = [];
    connection.onMessage((message) => {
      messages.push(message);
    });
    connection.start();
    socket.emit("data", clientFrame(0x1, Buffer.from("hello")));
    socket.emit("data", clientFrame(0x2, Buffer.from([1, 2, 3])));
    await new Promise((resolve) => setImmediate(resolve));

    expect(messages[0]).toEqual({ type: "text", text: "hello" });
    expect(messages[1]).toEqual({ type: "binary", data: Buffer.from([1, 2, 3]) });

    const invalidSocket = new FakeSocket();
    const invalid = new WebSocketConnection(invalidSocket as never, 1024);
    invalid.start();
    invalidSocket.emit("data", clientFrame(0x1, Buffer.from("bad"), false));
    const close = serverFrame(invalidSocket.writes.at(-1)!);
    expect(close.opcode).toBe(0x8);
    expect(close.payload.readUInt16BE(0)).toBe(1002);
    connection.terminate();
    invalid.terminate();
  });
});
