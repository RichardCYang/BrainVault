#!/usr/bin/env node
/** Deterministic operation counts plus advisory timing, not production load claims.
 * Run: node --expose-gc --experimental-strip-types scripts/benchmark-render-history-resources.mjs
 * Compile/setup/warmup/fixture creation are excluded from timing. Cases alternate
 * original/current order. Heap growth is sampled after iterations, not an exact
 * peak or a measurement of a leak. No environment or repository files are changed.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { makeHistory, makeDiff, manifest, regenerated } from '../tests/helpers/render-history-resource-harness.mjs';

const modes = ['baseline', 'current'];
const makeHistoryCase = (mode, length = 100000) => {
  const h = makeHistory(mode).create({ maxBytes: 4 * 1024 * 1024 });
  h.seed('p', 'b', { text: 'a'.repeat(length) });
  h.record({ pageId: 'p', key: 'b', value: { text: 'b'.repeat(length) }, now: 1 });
  return () => { h.commit('p', 'undo'); h.commit('p', 'redo'); };
};
const original = manifest({ blocksPerPage: 1000, htmlLength: 20000 });
const restored = regenerated(original);
const changed = regenerated(original);
for (const b of changed.data.blocks) b.markdown += ' changed';
const cases = [
  { name: '1000 history commits; 100000-character payload', iterations: 500, warmup: 100, create: mode => makeHistoryCase(mode) },
  { name: '1000 restore-only blocks; 20000-character HTML each', iterations: 3, warmup: 3, create: mode => { const m = makeDiff(mode); return () => m.diff(original, restored); } },
  { name: '1000 identical blocks (unchanged HTML)', iterations: 5, warmup: 3, create: mode => { const m = makeDiff(mode); return () => m.diff(original, original); } },
  { name: '1000 genuinely modified blocks; contextual hashes retained', iterations: 2, warmup: 2, create: mode => { const m = makeDiff(mode); return () => m.diff(original, changed); } }
];
const report = { node: process.version, platform: process.platform, gcAvailable: typeof global.gc === 'function', samplesPerCase: 9, cases: [], counts: {} };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const c of cases) {
  const run = Object.fromEntries(modes.map(mode => [mode, c.create(mode)]));
  for (let i = 0; i < c.warmup; i++) for (const mode of modes) run[mode]();
  const samples = { baseline: [], current: [] };
  for (let sample = 0; sample < 9; sample++) for (const mode of sample % 2 ? [...modes].reverse() : modes) {
    global.gc?.();
    const heapStart = process.memoryUsage().heapUsed;
    let sampledHeapMax = heapStart;
    const cpuStart = process.cpuUsage(), start = performance.now();
    for (let i = 0; i < c.iterations; i++) {
      run[mode]();
      if (i % Math.max(1, Math.floor(c.iterations / 10)) === 0) sampledHeapMax = Math.max(sampledHeapMax, process.memoryUsage().heapUsed);
    }
    const elapsedMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
    samples[mode].push({ elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, sampledHeapGrowthBytes: sampledHeapMax - heapStart });
  }
  const summary = Object.fromEntries(modes.map(mode => [mode, {
    medianElapsedMs: median(samples[mode].map(s => s.elapsedMs)),
    medianCpuMs: median(samples[mode].map(s => s.cpuMs)),
    medianSampledHeapGrowthBytes: median(samples[mode].map(s => s.sampledHeapGrowthBytes))
  }]));
  report.cases.push({ name: c.name, iterations: c.iterations, summary, samples });
}
for (const mode of modes) {
  const m = makeHistory(mode, { instrument: true }), h = m.create({ maxBytes: 4 * 1024 * 1024 });
  h.seed('p', 'b', { text: 'a'.repeat(100000) }); h.record({ pageId: 'p', key: 'b', value: { text: 'b'.repeat(100000) }, now: 1 });
  m.metrics.clones = 0; m.metrics.clonedJsonBytes = 0;
  for (let i = 0; i < 500; i++) { h.commit('p', 'undo'); h.commit('p', 'redo'); }
  const d = makeDiff(mode, { instrument: true });
  assert.equal(d.diff(original, restored).identical, true);
  report.counts[mode] = { history: m.metrics, snapshotDiff: d.metrics };
}
assert.equal(report.counts.baseline.history.clones, 1000);
assert.equal(report.counts.current.history.clones, 0);
assert.equal(report.counts.baseline.snapshotDiff.hashCalls, 2000);
assert.equal(report.counts.current.snapshotDiff.hashCalls, 0);
console.log(JSON.stringify(report, null, 2));
