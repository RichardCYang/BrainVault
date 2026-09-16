// Real loopback TCP + HTTP Upgrade + the native Node WebSocket client.
// No Express/database/auth/session coverage is implied by this transport test.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeWebSocketModule } from './helpers/resource-followup-harness.mjs';

function event(target, name, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { target.removeEventListener(name, done); reject(new Error(`Timed out waiting for ${name}`)); }, timeout);
    function done(value) { clearTimeout(timer); resolve(value); }
    target.addEventListener(name, done, { once: true });
  });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const mode of ['baseline', 'current']) test(`actual TCP/HTTP Upgrade, binary/text echo, idle, ping/pong and close: ${mode}`, { timeout: 15000 }, async () => {
  const { acceptWebSocketUpgrade } = makeWebSocketModule(mode, { clock: { setTimeout, clearTimeout, Date } });
  let connection, client, closeCode;
  const transportErrors = [], sockets = new Set();
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    connection = acceptWebSocketUpgrade(request, socket, { selectedProtocol: 'resource-regression', maxMessageBytes: 2 * 1024 * 1024 });
    assert.ok(connection);
    connection.onMessage(message => message.type === 'binary' ? connection.sendBinary(message.data) : connection.sendText(message.text));
    connection.onClose(code => { closeCode = code; });
    connection.start(head);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    client = new WebSocket(`ws://127.0.0.1:${server.address().port}/`, ['resource-regression']);
    client.binaryType = 'arraybuffer'; client.addEventListener('error', e => transportErrors.push(String(e.message || 'client error')));
    await event(client, 'open');
    assert.equal(client.protocol, 'resource-regression');
    async function echo(payload) { const result = event(client, 'message'); client.send(payload); return (await result).data; }
    const payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    assert.deepEqual(Buffer.from(await echo(payload)), payload);
    const capacity = connection.readBuffer.length;
    assert.ok(capacity >= payload.length);
    if (mode === 'current') assert.equal(connection.readBufferReleaseTimer.hasRef(), false);
    await sleep(5200);
    assert.equal(connection.readBuffer.length, mode === 'current' ? 0 : capacity);
    const lastPong = connection.lastPongAt;
    connection.ping(Buffer.from('probe'));
    for (let i = 0; i < 100 && connection.lastPongAt === lastPong; i += 1) await sleep(10);
    assert.ok(connection.lastPongAt > lastPong);
    assert.equal(await echo('회귀검증 😀 <script> & same connection'), '회귀검증 😀 <script> & same connection');
    assert.equal(await echo(''), '');
    assert.deepEqual(Buffer.from(await echo(payload)), payload);
    const closed = event(client, 'close'); client.close(1000, 'done');
    assert.equal((await closed).code, 1000);
    for (let i = 0; i < 100 && closeCode === undefined; i += 1) await sleep(10);
    assert.equal(closeCode, 1000);
    assert.equal(connection.readBuffer.length, 0);
    if (mode === 'current') assert.equal(connection.readBufferReleaseTimer, null);
    assert.deepEqual(transportErrors, []);
  } finally {
    connection?.terminate();
    if (client && client.readyState === WebSocket.OPEN) client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
