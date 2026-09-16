import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketConnection as NativeConnection } from '../src/lib/websocket.ts';
import { makeWebSocketModule, FakeSocket, clientFrame, sendChunked, settle, randomGenerator } from './helpers/resource-followup-harness.mjs';

const MiB = 1024 * 1024;
function setup(mode = 'current', handler = () => {}, limit = 2 * MiB) {
  const module = makeWebSocketModule(mode), socket = new FakeSocket();
  const connection = new module.WebSocketConnection(socket, limit);
  connection.onMessage(handler); connection.start();
  return { ...module, socket, connection };
}
function closeCode(socket) {
  const close = [...socket.writes].reverse().find(frame => (frame[0] & 15) === 8);
  return close ? close.readUInt16BE(2) : null;
}

for (const bytes of [0, 1, 125, 126, 65535, 65536, MiB]) test(`WebSocket ${bytes}-byte payload is identical before/after idle release`, async () => {
  for (const mode of ['baseline', 'current']) {
    const delivered = [], h = setup(mode, m => delivered.push(m));
    const payload = Buffer.alloc(bytes, 0x6b), frame = clientFrame(2, payload);
    sendChunked(h.socket, frame); await settle();
    assert.equal(delivered.length, 1); assert.deepEqual(delivered[0].data, payload);
    const capacity = h.connection.readBuffer.length;
    h.clock.tick(4999); assert.equal(h.connection.readBuffer.length, capacity);
    h.clock.tick(1);
    assert.equal(h.connection.readBuffer.length, mode === 'current' && capacity > 65536 ? 0 : capacity);
    sendChunked(h.socket, clientFrame(1, '한글😀 after idle')); await settle();
    assert.deepEqual(delivered[1], { type: 'text', text: '한글😀 after idle' });
    assert.deepEqual(delivered[0].data, payload, 'delivered payload must not alias the released scratch buffer');
    h.connection.terminate(); await settle();
  }
});

test('reproduction: an idle 1MiB message retains 2MiB scratch in original, zero in fixed', async () => {
  const result = [];
  for (const mode of ['baseline', 'current']) {
    const h = setup(mode); sendChunked(h.socket, clientFrame(2, Buffer.alloc(MiB, 17))); await settle();
    assert.equal(h.connection.readBuffer.length, 2 * MiB);
    h.clock.tick(60000); result.push(h.connection.readBuffer.length);
    h.connection.terminate(); await settle();
  }
  assert.deepEqual(result, [2 * MiB, 0]);
});

test('small interactive frames do not allocate a release timer', async () => {
  const h = setup();
  for (let i = 0; i < 100; i += 1) { h.socket.emit('data', clientFrame(1, 'note')); await settle(); }
  assert.equal(h.clock.metrics.created, 0); assert.equal(h.connection.readBuffer.length, 65536);
  h.connection.terminate(); await settle();
});

test('large bursts reuse both capacity and one unreferenced refreshable timer', async () => {
  const h = setup(), frame = clientFrame(2, Buffer.alloc(MiB, 33));
  sendChunked(h.socket, frame); await settle();
  const buffer = h.connection.readBuffer, timer = h.connection.readBufferReleaseTimer;
  assert.equal(timer.hasRef(), false);
  for (let i = 0; i < 20; i += 1) {
    h.clock.tick(100); sendChunked(h.socket, frame); await settle();
    assert.strictEqual(h.connection.readBuffer, buffer);
    assert.strictEqual(h.connection.readBufferReleaseTimer, timer);
    assert.equal(h.clock.timers.size, 1);
  }
  assert.equal(h.clock.metrics.created, 1); assert.equal(h.clock.metrics.refreshed, 20);
  h.clock.tick(4999); assert.strictEqual(h.connection.readBuffer, buffer);
  h.clock.tick(1); assert.equal(h.connection.readBuffer.length, 0);
  h.connection.terminate(); await settle();
});

for (const prefix of [1, 3, 10, 100, 32768]) test(`incomplete ${prefix}-byte frame prefix survives an expired idle timer`, async () => {
  const delivered = [], h = setup('current', m => delivered.push(m));
  sendChunked(h.socket, clientFrame(2, Buffer.alloc(MiB, 11))); await settle();
  const payload = Buffer.alloc(128000, 52), frame = clientFrame(2, payload);
  h.socket.emit('data', frame.subarray(0, prefix));
  const capacity = h.connection.readBuffer.length;
  h.clock.tick(5000);
  assert.equal(h.connection.readBuffer.length, capacity);
  assert.equal(h.connection.readEnd - h.connection.readStart, prefix);
  sendChunked(h.socket, frame.subarray(prefix)); await settle();
  assert.equal(delivered.length, 2); assert.deepEqual(delivered[1].data, payload);
  h.clock.tick(5000); assert.equal(h.connection.readBuffer.length, 0);
  h.connection.terminate(); await settle();
});

test('fragment payloads and split UTF-8 survive scratch-buffer release between frames', async () => {
  for (const mode of ['baseline', 'current']) {
    const delivered = [], h = setup(mode, m => delivered.push(m));
    const full = Buffer.from('한'.repeat(40000) + '😀 end');
    const first = full.subarray(0, 90001), last = full.subarray(90001);
    sendChunked(h.socket, clientFrame(1, first, { fin: false })); await settle();
    assert.equal(delivered.length, 0); h.clock.tick(5000);
    if (mode === 'current') assert.equal(h.connection.readBuffer.length, 0);
    h.socket.emit('data', clientFrame(9, 'ping'));
    sendChunked(h.socket, clientFrame(0, last)); await settle();
    assert.deepEqual(delivered, [{ type: 'text', text: full.toString('utf8') }]);
    assert.equal(h.socket.writes[0][0] & 15, 10);
    h.connection.terminate(); await settle();
  }
});

test('active async handler and queued messages remain owned when scratch is released', async () => {
  const delivered = []; let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = setup('current', async m => { delivered.push(m); if (delivered.length === 1) await blocked; });
  const payload = Buffer.alloc(MiB, 82);
  sendChunked(h.socket, clientFrame(2, payload));
  h.socket.emit('data', clientFrame(1, 'second'));
  assert.equal(h.connection.activeMessageBytes, MiB);
  h.clock.tick(5000); assert.equal(h.connection.readBuffer.length, 0);
  assert.equal(h.connection.activeMessageBytes, MiB);
  assert.deepEqual(delivered[0].data, payload);
  release(); await settle(); await settle();
  assert.equal(delivered[1].text, 'second'); assert.equal(h.connection.activeMessageBytes, 0);
  h.connection.terminate(); await settle();
});

for (const action of ['terminate', 'local-close', 'peer-close', 'error', 'end', 'close']) test(`release timer is cancelled on ${action}`, async () => {
  const h = setup(); sendChunked(h.socket, clientFrame(2, Buffer.alloc(MiB))); await settle();
  assert.equal(h.clock.timers.size, 1);
  if (action === 'terminate') h.connection.terminate();
  else if (action === 'local-close') h.connection.close(1000, 'done');
  else if (action === 'peer-close') h.socket.emit('data', clientFrame(8, Buffer.from([3, 232])));
  else h.socket.emit(action, ...(action === 'error' ? [new Error('test transport failure')] : []));
  await settle();
  assert.equal(h.connection.readBufferReleaseTimer, null);
  assert.equal([...h.clock.timers.values()].filter(x => x.delay === 5000).length, 0);
  assert.equal(h.connection.readBuffer.length, 0);
  h.clock.tick(30000); await settle();
});

const badFrames = [
  ['unmasked', () => clientFrame(1, 'x', { masked: false }), 1002],
  ['invalid-utf8', () => clientFrame(1, Buffer.from([0xff, 0xff])), 1007],
  ['invalid-opcode', () => clientFrame(3, 'x'), 1002],
  ['unexpected-continuation', () => clientFrame(0, 'x'), 1002],
  ['oversized-control', () => clientFrame(9, Buffer.alloc(126)), 1002],
  ['fragmented-control', () => clientFrame(9, 'x', { fin: false }), 1002],
  ['invalid-close-length', () => clientFrame(8, Buffer.from([0])), 1002],
  ['reserved-bits', () => { const f = clientFrame(1, 'x'); f[0] |= 0x40; return f; }, 1002],
  ['oversized-header', () => { const f = Buffer.alloc(14); f[0] = 0x82; f[1] = 0xff; f.writeBigUInt64BE(BigInt(3 * MiB), 2); return f; }, 1009]
];
for (const [name, frame, expected] of badFrames) test(`protocol security after buffer release: ${name}`, async () => {
  for (const mode of ['baseline', 'current']) {
    const h = setup(mode); sendChunked(h.socket, clientFrame(2, Buffer.alloc(MiB))); await settle();
    h.clock.tick(5000); h.socket.emit('data', frame());
    assert.equal(closeCode(h.socket), expected);
    h.connection.terminate(); await settle();
  }
});

test('100 deterministic fragmented/coalesced frame streams remain byte-identical', async () => {
  const random = randomGenerator(123);
  for (let run = 0; run < 100; run += 1) {
    const expected = '메시지😀' + run + 'x'.repeat(Math.floor(random() * 90000));
    const input = Buffer.from(expected), split = Math.floor(random() * input.length);
    const frames = Buffer.concat([clientFrame(1, input.subarray(0, split), { fin: false }), clientFrame(9, 'p'), clientFrame(0, input.subarray(split))]);
    const outputs = [];
    for (const mode of ['baseline', 'current']) {
      const received = [], h = setup(mode, m => received.push(m));
      sendChunked(h.socket, frames, 1 + (run * 101 % 5000)); await settle(); h.clock.tick(5000);
      outputs.push({ received, writes: h.socket.writes.map(b => b.toString('hex')) });
      assert.deepEqual(received, [{ type: 'text', text: expected }]);
      h.connection.terminate(); await settle();
    }
    assert.deepEqual(outputs[0], outputs[1]);
  }
});

test('native production Timeout releases capacity without a timer mock', async () => {
  const socket = new FakeSocket(), connection = new NativeConnection(socket, 2 * MiB);
  let received = 0; connection.onMessage(() => { received += 1; }); connection.start();
  try {
    sendChunked(socket, clientFrame(2, Buffer.alloc(MiB, 79))); await settle();
    assert.equal(connection.readBuffer.length, 2 * MiB);
    assert.equal(connection.readBufferReleaseTimer.hasRef(), false);
    await new Promise(resolve => setTimeout(resolve, 5200));
    assert.equal(connection.readBuffer.length, 0);
    socket.emit('data', clientFrame(1, 'still connected')); await settle();
    assert.equal(received, 2); assert.equal(connection.isOpen, true);
  } finally { connection.terminate(); await settle(); }
});
