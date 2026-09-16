// Test-only harness. Uses complete original/current modules, with TypeScript
// erased by Node and imports supplied explicitly. No production dependency.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { formatNumber, t } from '../../public/i18n.js';

export const baseline = JSON.parse(readFileSync(new URL('../fixtures/resource-followup-baseline.json', import.meta.url), 'utf8'));
export const currentSources = Object.fromEntries(Object.entries(baseline.files).map(([name, record]) =>
  [name, readFileSync(new URL(`../../${record.path}`, import.meta.url), 'utf8')]));

export function sourceFor(name, mode = 'current') {
  return mode === 'baseline' ? baseline.files[name].source : currentSources[name];
}
function executable(source, typescript = false) {
  const js = typescript ? stripTypeScriptTypes(source) : source;
  return js.replace(/^import[^\n]*;\r?$/gm, '').replace(/^export /gm, '');
}

export function makeTreeModule(mode = 'current', { side = 'server', instrument = false, document = undefined } = {}) {
  const name = side === 'server' ? 'serverTree' : 'clientTree';
  let source = executable(sourceFor(name, mode), side === 'server');
  const metrics = { childComparisons: 0, childIndexVisits: 0, pathIndexVisits: 0, fullSummaryCodeUnits: 0, appendedLines: 0 };
  if (instrument) {
    source = source.replace('data.nodes.filter((node) => node.parentId === parentId)',
      'data.nodes.filter((node) => (metrics.childComparisons += 1, node.parentId === parentId))');
    source = source.replace('for (const node of data.nodes) {',
      'for (const node of data.nodes) { metrics.childIndexVisits += 1;');
    source = source.replace('data.nodes.map((candidate) => [candidate.id, candidate])',
      'data.nodes.map((candidate) => (metrics.pathIndexVisits += 1, [candidate.id, candidate]))');
    source = source.replace(/data\.nodes\.map\(\(node\) => \[node\.id, node\]\s*\)/,
      'data.nodes.map((node) => (metrics.pathIndexVisits += 1, [node.id, node]))');
    source = source.replace(/return lines\.filter\(Boolean\)\.join\("\\n"\)\.slice\(0, (?:20_000|20000)\);/,
      'const joined = lines.filter(Boolean).join("\\n"); metrics.fullSummaryCodeUnits += joined.length; return joined.slice(0, 20000);');
    source = source.replace(/const appendLine = \(line\s*\) => \{/,
      'const appendLine = (line) => { metrics.appendedLines += 1;');
  }
  let ids = 0;
  const globals = { crypto: { randomUUID: () => `audit-id-${++ids}` } };
  const factory = new Function('formatNumber', 't', 'globalThis', 'document', 'metrics', source + `\nreturn {
    normalize: normalizeTreeViewData, summarize: summarizeTreeViewData,
    ${side === 'server' ? 'render: renderTreeViewHtml, get: getTreeViewData,' : 'createEditor: createTreeViewEditor, visible: getVisibleNodeIds,'}
    metrics
  };`);
  return factory(formatNumber, t, globals, document, metrics);
}

export function treeFixture(count = 300, { shape = 'flat', noteLength = 0 } = {}) {
  return {
    title: '성능·회귀검증 <&> 🌲',
    nodes: Array.from({ length: count }, (_, i) => ({
      id: `node-${i}`,
      parentId: shape === 'chain' && i ? `node-${i - 1}` : shape === 'balanced' && i ? `node-${Math.floor((i - 1) / 4)}` : null,
      title: `항목 ${i} <script> & " ' 😀`,
      note: noteLength ? (`메모 ${i}\n<&> 😀 ` + '한글note'.repeat(Math.ceil(noteLength / 6))).slice(0, noteLength) : '',
      expanded: i % 3 !== 1
    }))
  };
}
export function randomGenerator(seed = 0x42563236) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 2 ** 32; };
}

// Deterministic timer implementing actual Timeout.refresh()/unref() semantics.
// Node 22.16 mock timers do not correctly postpone refresh(), hence this narrow
// clock is used for race tests; separate tests exercise native production timers.
export function makeClock() {
  let now = 0, nextId = 1;
  const timers = new Map();
  const metrics = { created: 0, refreshed: 0, cleared: 0, unref: 0, fired: 0 };
  const setTimeout = (callback, delay = 0) => {
    const timer = {
      id: nextId++, callback, delay, due: now + delay, referenced: true,
      refresh() { metrics.refreshed += 1; this.due = now + this.delay; timers.set(this.id, this); return this; },
      unref() { metrics.unref += 1; this.referenced = false; return this; },
      hasRef() { return this.referenced; }
    };
    metrics.created += 1; timers.set(timer.id, timer); return timer;
  };
  const clearTimeout = timer => { if (timer && timers.delete(timer.id)) metrics.cleared += 1; };
  const clockDate = class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  return {
    timers, metrics, setTimeout, clearTimeout, Date: clockDate,
    tick(ms) {
      const target = now + ms;
      let callbacks = 0;
      while (true) {
        const next = [...timers.values()].filter(x => x.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!next) break;
        if (++callbacks > 10000) throw new Error('timer loop');
        now = next.due; timers.delete(next.id); metrics.fired += 1; next.callback();
      }
      now = target;
    }
  };
}
export function makeWebSocketModule(mode = 'current', { clock = makeClock() } = {}) {
  const source = executable(sourceFor('websocket', mode), true);
  const factory = new Function('createHash', 'Buffer', 'TextDecoder', 'setTimeout', 'clearTimeout', 'Date', source +
    '\nreturn { WebSocketConnection, parseWebSocketProtocols, rejectWebSocketUpgrade, acceptWebSocketUpgrade };');
  return { ...factory(createHash, Buffer, TextDecoder, clock.setTimeout, clock.clearTimeout, clock.Date), clock };
}
export class FakeSocket extends EventEmitter {
  destroyed = false;
  paused = false;
  writableLength = 0;
  writes = [];
  write(value) { this.writes.push(Buffer.from(value)); return true; }
  pause() { this.paused = true; return this; }
  resume() { this.paused = false; return this; }
  end(value) { if (value !== undefined) this.write(value); queueMicrotask(() => this.emit('end')); return this; }
  destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')); } return this; }
}
export function clientFrame(opcode, value, { fin = true, masked = true } = {}) {
  const payload = Buffer.from(value), mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const ext = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + ext + (masked ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = (masked ? 0x80 : 0) | (ext === 0 ? payload.length : ext === 2 ? 126 : 127);
  if (ext === 2) header.writeUInt16BE(payload.length, 2);
  if (ext === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
  if (masked) {
    mask.copy(header, 2 + ext);
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return Buffer.concat([header, payload]);
}
export function sendChunked(socket, frame, chunkSize = 32768) {
  for (let offset = 0; offset < frame.length; offset += chunkSize) socket.emit('data', frame.subarray(offset, offset + chunkSize));
}
export const settle = () => new Promise(resolve => setImmediate(resolve));
