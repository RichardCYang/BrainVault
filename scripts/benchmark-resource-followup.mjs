// Run: node --expose-gc --experimental-strip-types scripts/benchmark-resource-followup.mjs
// Descriptive, paired microbenchmarks of actual source. Timing is not a CI gate.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { baseline, currentSources, makeTreeModule, treeFixture, makeWebSocketModule, FakeSocket, clientFrame, sendChunked, settle } from '../tests/helpers/resource-followup-harness.mjs';
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = x => Number(x.toFixed(3));
const MiB = 1024 * 1024;

if (process.argv[2] === '--memory-child') {
  if (!globalThis.gc) throw new Error('--expose-gc is required');
  const workload = process.argv[3], mode = process.argv[4];
  const gc = () => { globalThis.gc(); globalThis.gc(); };
  let keepAlive;
  let state = {};
  let before;
  if (workload === 'summary') {
    const tree = makeTreeModule(mode);
    tree.summarize(treeFixture(3)); gc(); before = process.memoryUsage();
    function produce() {
      const values = [];
      for (let i = 0; i < 24; i += 1) {
        const input = treeFixture(300, { noteLength: 8000 });
        input.title += ` / independent result ${i}`;
        values.push(tree.summarize(input));
      }
      return values;
    }
    keepAlive = produce();
    state = { retainedSummaries: keepAlive.length, outputCodeUnits: keepAlive.reduce((sum, s) => sum + s.length, 0) };
    assert.equal(state.outputCodeUnits, 24 * 20000);
  } else if (workload === 'websocket') {
    const { WebSocketConnection, clock } = makeWebSocketModule(mode);
    gc(); before = process.memoryUsage();
    keepAlive = [];
    async function produce() {
      const frame = clientFrame(2, Buffer.alloc(MiB, 71));
      for (let i = 0; i < 8; i += 1) {
        const socket = new FakeSocket(), connection = new WebSocketConnection(socket, 2 * MiB);
        connection.onMessage(() => {}); connection.start(); sendChunked(socket, frame);
        keepAlive.push(connection); await settle();
      }
    }
    await produce(); await settle(); clock.tick(6000); await settle();
    state = { connections: keepAlive.length, idleScratchCapacityBytes: keepAlive.reduce((sum, c) => sum + c.readBuffer.length, 0) };
  } else throw new Error('unknown workload');
  gc(); const retained = process.memoryUsage();
  const delta = Object.fromEntries(Object.keys(retained).map(key => [key, retained[key] - before[key]]));
  if (workload === 'websocket') for (const c of keepAlive) c.terminate();
  keepAlive = null; await settle(); gc(); const cleared = process.memoryUsage();
  console.log(JSON.stringify({ workload, mode, state, before, retained, delta, clearedDelta: Object.fromEntries(Object.keys(cleared).map(key => [key, cleared[key] - before[key]])) }));
  process.exit(0);
}

function measure(run, iterations = 10) {
  for (let i = 0; i < 2; i += 1) for (let j = 0; j < iterations; j += 1) run();
  const wall = [], cpu = [];
  for (let i = 0; i < 7; i += 1) {
    globalThis.gc?.(); const start = performance.now(), beginCpu = process.cpuUsage();
    for (let j = 0; j < iterations; j += 1) run();
    const elapsed = process.cpuUsage(beginCpu);
    wall.push((performance.now() - start) / iterations); cpu.push((elapsed.user + elapsed.system) / 1000 / iterations);
  }
  return { samples: 7, iterationsPerSample: iterations, medianWallMs: round(median(wall)), medianCpuMs: round(median(cpu)), allWallMs: wall.map(round), allCpuMs: cpu.map(round) };
}
const results = {
  schemaVersion: 1, auditDate: '2026-09-16', generatedAt: new Date().toISOString(),
  originalArchiveSha256: baseline.originalArchiveSha256,
  environment: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, exposedGc: Boolean(globalThis.gc) },
  scope: 'Actual treeview functions and WebSocket parser; synthetic input. Not whole-app/DB throughput. Memory children use separate processes and explicit GC. WebSocket cooldown uses a deterministic clock; native-timer regression is separate.',
  currentSourceSha256: Object.fromEntries(Object.entries(currentSources).map(([name, source]) => [name, createHash('sha256').update(source).digest('hex')])),
  render: [], summaries: [], workCounts: [], memory: []
};
for (const shape of ['flat', 'balanced', 'chain']) {
  const input = treeFixture(300, { shape, noteLength: 32 });
  const a = makeTreeModule('baseline'), b = makeTreeModule('current');
  assert.equal(a.render({ treeView: input }), b.render({ treeView: input }));
  for (const mode of ['baseline', 'current']) {
    const tree = mode === 'baseline' ? a : b;
    results.render.push({ mode, shape, nodes: 300, ...measure(() => { assert.ok(tree.render({ treeView: input }).length); }) });
    const counted = makeTreeModule(mode, { instrument: true }); counted.render({ treeView: input });
    results.workCounts.push({ mode, workload: 'static-render', shape, nodes: 300, ...counted.metrics });
  }
}
for (const side of ['server', 'client']) {
  const input = treeFixture(300, { noteLength: 8000 });
  const a = makeTreeModule('baseline', { side }), b = makeTreeModule('current', { side });
  assert.equal(a.summarize(input), b.summarize(input));
  for (const mode of ['baseline', 'current']) {
    const tree = mode === 'baseline' ? a : b;
    results.summaries.push({ mode, side, nodes: 300, totalMemoCodeUnits: 2_400_000, ...measure(() => assert.equal(tree.summarize(input).length, 20000)) });
    const counted = makeTreeModule(mode, { side, instrument: true }); counted.summarize(input);
    results.workCounts.push({ mode, workload: 'summary', side, nodes: 300, ...counted.metrics });
  }
}
for (const workload of ['summary', 'websocket']) for (const mode of ['baseline', 'current']) {
  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    const child = spawnSync(process.execPath, ['--expose-gc', '--experimental-strip-types', fileURLToPath(import.meta.url), '--memory-child', workload, mode], { encoding: 'utf8', timeout: 45000, maxBuffer: MiB });
    if (child.status !== 0) throw new Error(`memory child failed: ${child.stderr}`);
    samples.push(JSON.parse(child.stdout));
  }
  results.memory.push({ workload, mode, samples, medianHeapDeltaBytes: median(samples.map(s => s.delta.heapUsed)), medianArrayBufferDeltaBytes: median(samples.map(s => s.delta.arrayBuffers)), medianExternalDeltaBytes: median(samples.map(s => s.delta.external)) });
}
console.log(JSON.stringify(results, null, 2));
