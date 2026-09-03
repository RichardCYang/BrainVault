import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const defaultMaxQueuedMessages = 64;
const maxQueuedExtraBytes = 256 * 1024;
const maxFrameHeaderBytes = 10;
const maxFragmentsPerMessage = 1_024;
const maxTransportFramesPerSecond = 600;

export type WebSocketMessage =
  | { type: "text"; text: string }
  | { type: "binary"; data: Buffer };

type MessageHandler = (message: WebSocketMessage) => void | Promise<void>;
type CloseHandler = (code: number, reason: string) => void;

function isValidCloseCode(code: number) {
  if (code >= 1000 && code <= 1014) return ![1004, 1005, 1006].includes(code);
  return code >= 3000 && code <= 4999;
}

function encodeFrame(opcode: number, payload: Buffer, fin = true) {
  const first = (fin ? 0x80 : 0) | (opcode & 0x0f);
  if (payload.length < 126) {
    const frame = Buffer.allocUnsafe(2 + payload.length);
    frame[0] = first;
    frame[1] = payload.length;
    payload.copy(frame, 2);
    return frame;
  }
  if (payload.length <= 0xffff) {
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame[0] = first;
    frame[1] = 126;
    frame.writeUInt16BE(payload.length, 2);
    payload.copy(frame, 4);
    return frame;
  }
  const frame = Buffer.allocUnsafe(10 + payload.length);
  frame[0] = first;
  frame[1] = 127;
  frame.writeBigUInt64BE(BigInt(payload.length), 2);
  payload.copy(frame, 10);
  return frame;
}

function truncateCloseReason(reason: string) {
  let value = reason;
  while (Buffer.byteLength(value, "utf8") > 123) value = value.slice(0, -1);
  return value;
}

export class WebSocketConnection {
  private readonly socket: Socket;
  private readonly maxMessageBytes: number;
  private readBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readStart = 0;
  private readEnd = 0;
  private fragmentOpcode: 1 | 2 | null = null;
  private fragmentParts: Buffer[] = [];
  private fragmentBytes = 0;
  private frameWindowStartedAt = Date.now();
  private consumedFramesInWindow = 0;
  private messageHandler: MessageHandler | null = null;
  private closeHandler: CloseHandler | null = null;
  private messageQueue: WebSocketMessage[] = [];
  private queuedMessageBytes = 0;
  private activeMessageBytes = 0;
  private processingMessages = false;
  private acceptingMessages = true;
  private readonly maxQueuedMessageBytes: number;
  private readonly maxBufferedOutputBytes: number;
  private started = false;
  private closeSent = false;
  private closeNotified = false;
  private receivedCloseCode = 1006;
  private receivedCloseReason = "Connection closed unexpectedly";
  private open = true;

  lastPongAt = Date.now();

  constructor(socket: Socket, maxMessageBytes: number) {
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.maxQueuedMessageBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      maxMessageBytes + Math.min(maxMessageBytes, maxQueuedExtraBytes)
    );
    this.maxBufferedOutputBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.maxQueuedMessageBytes + maxFrameHeaderBytes
    );
  }

  get isOpen() {
    return this.open && !this.socket.destroyed;
  }

  onMessage(handler: MessageHandler) {
    this.messageHandler = handler;
    void this.drainMessages();
  }

  onClose(handler: CloseHandler) {
    this.closeHandler = handler;
  }

  start(head: Buffer = Buffer.alloc(0)) {
    if (this.started) return;
    this.started = true;
    this.socket.on("data", (chunk: Buffer) => this.consume(chunk));
    this.socket.on("error", () => this.finishClose(1006, "Connection error"));
    this.socket.on("end", () => this.finishClose(this.receivedCloseCode, this.receivedCloseReason));
    this.socket.on("close", () => this.finishClose(this.receivedCloseCode, this.receivedCloseReason));
    if (head.length) this.consume(head);
    if (this.acceptingMessages && this.isOpen) this.socket.resume();
  }

  sendText(value: string) {
    if (!this.isOpen || this.closeSent) return;
    this.writeFrame(0x1, Buffer.from(value, "utf8"));
  }

  sendJson(value: unknown) {
    if (!this.isOpen || this.closeSent) return;
    this.sendText(JSON.stringify(value));
  }

  sendBinary(value: Uint8Array | Buffer) {
    if (!this.isOpen || this.closeSent) return;
    this.writeFrame(0x2, Buffer.isBuffer(value) ? value : Buffer.from(value));
  }

  ping(value: Uint8Array | Buffer = Buffer.alloc(0)) {
    const payload = Buffer.from(value);
    if (payload.length > 125) throw new Error("WebSocket ping payload is too large");
    this.writeFrame(0x9, payload);
  }

  close(code = 1000, reason = "") {
    if (this.closeSent || !this.isOpen) return;
    this.stopAcceptingMessages();
    const safeCode = isValidCloseCode(code) ? code : 1000;
    const safeReason = truncateCloseReason(reason);
    const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(safeReason, "utf8"));
    payload.writeUInt16BE(safeCode, 0);
    payload.write(safeReason, 2, "utf8");
    this.closeSent = true;
    this.writeFrame(0x8, payload, true);
    const timer = setTimeout(() => this.terminate(), 2_000);
    timer.unref();
  }

  terminate() {
    if (!this.open) return;
    this.stopAcceptingMessages();
    this.open = false;
    this.socket.destroy();
    this.finishClose(this.receivedCloseCode, this.receivedCloseReason);
  }

  private writeFrame(opcode: number, payload: Buffer, allowAfterClose = false) {
    if (!this.isOpen || (this.closeSent && !allowAfterClose && opcode !== 0x8)) return;
    const headerBytes = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
    const frameBytes = headerBytes + payload.length;
    const writableLength = Number(this.socket.writableLength);
    const bufferedBytes = Number.isFinite(writableLength) && writableLength > 0 ? writableLength : 0;
    if (frameBytes > this.maxBufferedOutputBytes - bufferedBytes) {
      this.receivedCloseCode = 1008;
      this.receivedCloseReason = "WebSocket output backlog exceeded";
      this.terminate();
      return;
    }
    this.socket.write(encodeFrame(opcode, payload));
  }

  private protocolError(reason: string, code = 1002) {
    this.receivedCloseCode = code;
    this.receivedCloseReason = reason;
    this.close(code, reason);
  }

  private consumeFrameRateBudget() {
    const now = Date.now();
    if (now - this.frameWindowStartedAt >= 1_000) {
      this.frameWindowStartedAt = now;
      this.consumedFramesInWindow = 0;
    }
    this.consumedFramesInWindow += 1;
    if (this.consumedFramesInWindow > maxTransportFramesPerSecond) {
      this.protocolError("WebSocket frame rate limit exceeded", 1008);
      return false;
    }
    return true;
  }

  private unreadByteLength() {
    return this.readEnd - this.readStart;
  }

  private ensureReadCapacity(extraBytes: number) {
    const unreadBytes = this.unreadByteLength();
    const neededBytes = unreadBytes + extraBytes;
    if (neededBytes <= this.readBuffer.length) {
      if (this.readEnd + extraBytes > this.readBuffer.length && this.readStart > 0) {
        this.readBuffer.copy(this.readBuffer, 0, this.readStart, this.readEnd);
        this.readStart = 0;
        this.readEnd = unreadBytes;
      }
      return;
    }

    const maxBufferBytes = this.maxMessageBytes + 64 * 1024;
    let nextCapacity = Math.max(64 * 1024, this.readBuffer.length || 1);
    while (nextCapacity < neededBytes) {
      nextCapacity = Math.min(maxBufferBytes, nextCapacity * 2);
    }
    const grown = Buffer.allocUnsafe(nextCapacity);
    if (unreadBytes) this.readBuffer.copy(grown, 0, this.readStart, this.readEnd);
    this.readBuffer = grown;
    this.readStart = 0;
    this.readEnd = unreadBytes;
  }

  private appendReadChunk(chunk: Buffer) {
    this.ensureReadCapacity(chunk.length);
    chunk.copy(this.readBuffer, this.readEnd);
    this.readEnd += chunk.length;
  }

  private consumeReadBytes(byteCount: number) {
    this.readStart += byteCount;
    if (this.readStart === this.readEnd) {
      this.readStart = 0;
      this.readEnd = 0;
    }
  }

  private consume(chunk: Buffer) {
    if (!this.isOpen || !this.acceptingMessages || !chunk.length) return;
    if (this.unreadByteLength() + chunk.length > this.maxMessageBytes + 64 * 1024) {
      this.protocolError("WebSocket message is too large", 1009);
      return;
    }
    this.appendReadChunk(chunk);

    while (this.unreadByteLength() >= 2 && this.isOpen && this.acceptingMessages) {
      const frameStart = this.readStart;
      const availableBytes = this.readEnd - frameStart;
      const first = this.readBuffer[frameStart];
      const second = this.readBuffer[frameStart + 1];
      const fin = Boolean(first & 0x80);
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        this.protocolError("Unsupported WebSocket extension");
        return;
      }
      if (!masked) {
        this.protocolError("Client WebSocket frames must be masked");
        return;
      }
      if (payloadLength === 126) {
        if (availableBytes < 4) return;
        payloadLength = this.readBuffer.readUInt16BE(frameStart + 2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (availableBytes < 10) return;
        const bigLength = this.readBuffer.readBigUInt64BE(frameStart + 2);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER) || bigLength > BigInt(this.maxMessageBytes)) {
          this.protocolError("WebSocket message is too large", 1009);
          return;
        }
        payloadLength = Number(bigLength);
        offset = 10;
      }

      const controlFrame = opcode >= 0x8;
      if (controlFrame && (!fin || payloadLength > 125)) {
        this.protocolError("Invalid WebSocket control frame");
        return;
      }
      if (payloadLength > this.maxMessageBytes || this.fragmentBytes + payloadLength > this.maxMessageBytes) {
        this.protocolError("WebSocket message is too large", 1009);
        return;
      }
      if (availableBytes < offset + 4 + payloadLength) return;
      if (!this.consumeFrameRateBudget()) return;

      const mask = this.readBuffer.subarray(frameStart + offset, frameStart + offset + 4);
      offset += 4;
      const payloadStart = frameStart + offset;
      const payload = Buffer.from(this.readBuffer.subarray(payloadStart, payloadStart + payloadLength));
      this.consumeReadBytes(offset + payloadLength);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }

      if (opcode === 0x8) {
        this.handleCloseFrame(payload);
        return;
      }
      if (opcode === 0x9) {
        this.writeFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) {
        this.lastPongAt = Date.now();
        continue;
      }
      if (opcode === 0x0) {
        if (this.fragmentOpcode === null) {
          this.protocolError("Unexpected continuation frame");
          return;
        }
        if (this.fragmentParts.length >= maxFragmentsPerMessage) {
          this.protocolError("WebSocket fragmented message has too many fragments", 1009);
          return;
        }
        this.fragmentParts.push(payload);
        this.fragmentBytes += payload.length;
        if (fin) {
          const complete = Buffer.concat(this.fragmentParts, this.fragmentBytes);
          const completeOpcode = this.fragmentOpcode;
          this.fragmentOpcode = null;
          this.fragmentParts = [];
          this.fragmentBytes = 0;
          this.dispatchPayload(completeOpcode, complete);
        }
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x2) {
        this.protocolError("Unsupported WebSocket opcode");
        return;
      }
      if (this.fragmentOpcode !== null) {
        this.protocolError("A fragmented message is already in progress");
        return;
      }
      if (fin) {
        this.dispatchPayload(opcode, payload);
      } else {
        this.fragmentOpcode = opcode;
        this.fragmentParts = [payload];
        this.fragmentBytes = payload.length;
      }
    }
  }

  private dispatchPayload(opcode: 1 | 2, payload: Buffer) {
    let message: WebSocketMessage;
    if (opcode === 1) {
      try {
        message = { type: "text", text: fatalUtf8Decoder.decode(payload) };
      } catch {
        this.protocolError("Text message is not valid UTF-8", 1007);
        return;
      }
    } else {
      message = { type: "binary", data: payload };
    }

    this.enqueueMessage(message);
  }

  private messageByteLength(message: WebSocketMessage) {
    return message.type === "text" ? Buffer.byteLength(message.text, "utf8") : message.data.length;
  }

  private enqueueMessage(message: WebSocketMessage) {
    if (!this.acceptingMessages || !this.isOpen) return;
    const messageBytes = this.messageByteLength(message);
    const backlogCount = this.messageQueue.length + (this.processingMessages ? 1 : 0);
    const backlogBytes = this.queuedMessageBytes + this.activeMessageBytes;
    if (
      backlogCount >= defaultMaxQueuedMessages ||
      messageBytes > this.maxQueuedMessageBytes - backlogBytes
    ) {
      this.rejectMessageBacklog();
      return;
    }

    this.messageQueue.push(message);
    this.queuedMessageBytes += messageBytes;
    void this.drainMessages();
  }

  private async drainMessages() {
    if (
      this.processingMessages ||
      !this.messageHandler ||
      !this.acceptingMessages ||
      !this.isOpen
    ) return;

    this.processingMessages = true;
    try {
      while (
        this.acceptingMessages &&
        this.isOpen &&
        this.messageQueue.length
      ) {
        const message = this.messageQueue.shift()!;
        const messageBytes = this.messageByteLength(message);
        this.queuedMessageBytes -= messageBytes;
        this.activeMessageBytes = messageBytes;
        await this.messageHandler(message);
        this.activeMessageBytes = 0;
      }
    } catch (error) {
      console.error("WebSocket message handler failed", error);
      this.close(1011, "WebSocket message handling failed");
    } finally {
      this.activeMessageBytes = 0;
      this.processingMessages = false;
      if (
        this.acceptingMessages &&
        this.isOpen &&
        this.messageQueue.length
      ) void this.drainMessages();
    }
  }

  private rejectMessageBacklog() {
    if (!this.acceptingMessages) return;
    this.receivedCloseCode = 1008;
    this.receivedCloseReason = "WebSocket message backlog exceeded";
    this.close(1008, this.receivedCloseReason);
  }

  private stopAcceptingMessages() {
    this.acceptingMessages = false;
    this.messageQueue = [];
    this.queuedMessageBytes = 0;
    this.readBuffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragmentParts = [];
    this.fragmentBytes = 0;
    this.socket.pause();
  }

  private handleCloseFrame(payload: Buffer) {
    let code = 1000;
    let reason = "";
    if (payload.length === 1) {
      this.protocolError("Invalid WebSocket close payload");
      return;
    }
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!isValidCloseCode(code)) {
        this.protocolError("Invalid WebSocket close code");
        return;
      }
      try {
        reason = fatalUtf8Decoder.decode(payload.subarray(2));
      } catch {
        this.protocolError("Close reason is not valid UTF-8", 1007);
        return;
      }
    }

    this.receivedCloseCode = code;
    this.receivedCloseReason = reason;
    this.stopAcceptingMessages();
    if (!this.closeSent) {
      this.closeSent = true;
      this.writeFrame(0x8, payload, true);
    }
    this.socket.end();
  }

  private finishClose(code: number, reason: string) {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.stopAcceptingMessages();
    this.open = false;
    this.closeHandler?.(code, reason);
  }
}

export function parseWebSocketProtocols(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header.join(",") : header ?? "";
  return value
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

export function rejectWebSocketUpgrade(socket: Socket, statusCode: number, message: string) {
  if (socket.destroyed) return;
  const safeMessage = message.replace(/[\r\n]/g, " ");
  const body = Buffer.from(safeMessage, "utf8");
  const statusText = statusCode === 401
    ? "Unauthorized"
    : statusCode === 403
      ? "Forbidden"
      : statusCode === 404
        ? "Not Found"
        : statusCode === 426
          ? "Upgrade Required"
          : statusCode === 429
            ? "Too Many Requests"
            : statusCode === 500
              ? "Internal Server Error"
              : statusCode === 503
                ? "Service Unavailable"
                : "Bad Request";
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n` +
      "\r\n" +
      safeMessage
  );
}

export function acceptWebSocketUpgrade(
  request: IncomingMessage,
  socket: Socket,
  {
    selectedProtocol,
    maxMessageBytes
  }: {
    selectedProtocol: string;
    maxMessageBytes: number;
  }
) {
  const upgrade = String(request.headers.upgrade ?? "").toLowerCase();
  const connection = String(request.headers.connection ?? "").toLowerCase();
  const version = String(request.headers["sec-websocket-version"] ?? "");
  const key = String(request.headers["sec-websocket-key"] ?? "");

  let keyBytes: Buffer;
  try {
    keyBytes = Buffer.from(key, "base64");
  } catch {
    keyBytes = Buffer.alloc(0);
  }
  const canonicalKey = /^[A-Za-z0-9+/]{22}==$/.test(key)
    && keyBytes.length === 16
    && keyBytes.toString("base64") === key;
  if (
    upgrade !== "websocket" ||
    !connection.split(",").some((value) => value.trim() === "upgrade") ||
    version !== "13" ||
    !canonicalKey
  ) {
    rejectWebSocketUpgrade(socket, 426, "A valid RFC 6455 WebSocket upgrade is required");
    return null;
  }

  const accept = createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
  socket.pause();
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      `Sec-WebSocket-Protocol: ${selectedProtocol}\r\n` +
      "\r\n"
  );
  return new WebSocketConnection(socket, maxMessageBytes);
}
