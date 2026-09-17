import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketFragmentBudget } from "../src/lib/websocket.ts";
import {
  makeWebSocketModule, FakeSocket, clientFrame, settle
} from "./helpers/resource-followup-harness.mjs";

function setup({ budget = new WebSocketFragmentBudget(1024), limit = 512 } = {}) {
  const module = makeWebSocketModule();
  const socket = new FakeSocket();
  const messages = [];
  const connection = new module.WebSocketConnection(socket, limit, budget);
  connection.onMessage((message) => { messages.push(message); });
  connection.start();
  return { ...module, connection, socket, messages, budget };
}
function closeCode(socket) {
  const frame = socket.writes.find((value) => (value[0] & 15) === 8);
  return frame?.readUInt16BE(2) ?? null;
}

test("pongs cannot keep an incomplete fragmented message alive beyond its deadline", () => {
  const h = setup();
  h.socket.emit("data", clientFrame(2, Buffer.alloc(500), { fin: false }));
  for (let i = 0; i < 14; i += 1) {
    h.clock.tick(1000);
    h.socket.emit("data", clientFrame(10, []));
  }
  assert.equal(h.connection.lastPongAt, 14000);
  assert.equal(h.budget.retainedBytes, 500);
  h.clock.tick(1000);
  assert.equal(closeCode(h.socket), 1008);
  assert.equal(h.messages.length, 0);
  assert.equal(h.connection.fragmentParts.length, 0);
  assert.equal(h.connection.readBuffer.length, 0);
  assert.equal(h.budget.retainedBytes, 0);
  h.connection.terminate();
});

test("continuation progress does not renew the absolute message deadline", () => {
  const h = setup();
  h.socket.emit("data", clientFrame(2, [1], { fin: false }));
  h.clock.tick(10000);
  h.socket.emit("data", clientFrame(0, [2], { fin: false }));
  h.clock.tick(5000);
  assert.equal(closeCode(h.socket), 1008);
  assert.equal(h.budget.retainedBytes, 0);
  h.connection.terminate();
});

test("a partially received first fragment expires and releases its scratch buffer", () => {
  const h = setup();
  const frame = clientFrame(2, Buffer.alloc(500), { fin: false });
  h.socket.emit("data", frame.subarray(0, 100));
  assert.ok(h.connection.readBuffer.length > 0);
  assert.equal(h.connection.fragmentParts.length, 0);
  h.clock.tick(15000);
  assert.equal(closeCode(h.socket), 1008);
  assert.equal(h.connection.readBuffer.length, 0);
  h.connection.terminate();
});

test("valid completion releases the budget and the next message gets a fresh deadline", async () => {
  const h = setup();
  h.socket.emit("data", clientFrame(2, [1, 2], { fin: false }));
  h.clock.tick(14999);
  h.socket.emit("data", clientFrame(0, [3]));
  await settle();
  assert.deepEqual(h.messages[0].data, Buffer.from([1, 2, 3]));
  assert.equal(h.budget.retainedBytes, 0);
  assert.equal(h.connection.fragmentCompletionTimer, null);
  h.socket.emit("data", clientFrame(2, [4], { fin: false }));
  h.clock.tick(14999);
  assert.equal(closeCode(h.socket), null);
  h.clock.tick(1);
  assert.equal(closeCode(h.socket), 1008);
  h.connection.terminate();
});

test("control payloads are not charged to a full-size fragmented message", async () => {
  const h = setup({ limit: 4 });
  h.socket.emit("data", clientFrame(2, [1, 2, 3, 4], { fin: false }));
  h.socket.emit("data", clientFrame(9, [7]));
  assert.equal(closeCode(h.socket), null);
  assert.equal(h.budget.retainedBytes, 4);
  assert.ok(h.socket.writes.some((frame) => (frame[0] & 15) === 10));
  h.socket.emit("data", clientFrame(0, []));
  await settle();
  assert.deepEqual(h.messages[0].data, Buffer.from([1, 2, 3, 4]));
  assert.equal(h.budget.retainedBytes, 0);
  h.connection.terminate();
});

test("aggregate fragment reservations are shared and reusable after completion", async () => {
  const budget = new WebSocketFragmentBudget(12);
  const a = setup({ budget }), b = setup({ budget }), c = setup({ budget });
  try {
    a.socket.emit("data", clientFrame(2, Buffer.alloc(8), { fin: false }));
    b.socket.emit("data", clientFrame(2, Buffer.alloc(8), { fin: false }));
    assert.equal(closeCode(b.socket), 1008);
    assert.equal(budget.retainedBytes, 8);
    a.socket.emit("data", clientFrame(0, []));
    await settle();
    assert.equal(budget.retainedBytes, 0);
    c.socket.emit("data", clientFrame(2, Buffer.alloc(12), { fin: false }));
    assert.equal(closeCode(c.socket), null);
    assert.equal(budget.retainedBytes, 12);
  } finally {
    for (const h of [a, b, c]) h.connection.terminate();
  }
  assert.equal(budget.retainedBytes, 0);
});

for (const action of ["terminate", "close", "peer-close", "error", "end", "protocol-error"]) {
  test(`fragment timer and reservation are released exactly once on ${action}`, async () => {
    const h = setup();
    h.socket.emit("data", clientFrame(2, [1, 2, 3], { fin: false }));
    if (action === "terminate") h.connection.terminate();
    else if (action === "close") h.connection.close();
    else if (action === "peer-close") h.socket.emit("data", clientFrame(8, [3, 232]));
    else if (action === "error") h.socket.emit("error", new Error("Test transport failure"));
    else if (action === "end") h.socket.emit("end");
    else h.socket.emit("data", clientFrame(2, [9]));
    await settle();
    assert.equal(h.budget.retainedBytes, 0);
    assert.equal(h.connection.fragmentCompletionTimer, null);
    h.connection.terminate();
    h.clock.tick(20000);
    assert.equal(h.budget.retainedBytes, 0);
  });
}

test("empty unfinished messages expire, while idle connections have no fragment deadline", () => {
  const idle = setup(), fragmented = setup();
  fragmented.socket.emit("data", clientFrame(2, [], { fin: false }));
  idle.clock.tick(20000);
  fragmented.clock.tick(15000);
  assert.equal(closeCode(idle.socket), null);
  assert.equal(closeCode(fragmented.socket), 1008);
  idle.connection.terminate();
  fragmented.connection.terminate();
});

test("the production aggregate budget is 128 MiB and rejects invalid accounting", () => {
  const budget = new WebSocketFragmentBudget();
  assert.equal(budget.tryReserve(128 * 1024 * 1024), true);
  assert.equal(budget.tryReserve(1), false);
  assert.equal(budget.tryReserve(-1), false);
  budget.release(128 * 1024 * 1024);
  assert.equal(budget.retainedBytes, 0);
  assert.throws(() => budget.release(1), RangeError);
});
