#!/usr/bin/env node
// Offline, exact-upload/current comparison. No application dependencies or DB.
// node --expose-gc scripts/benchmark-database-option-render-resources.mjs --output result.json
// Timing/heap sampling are observations, not CI thresholds or whole-app capacity claims.
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { loadModule, resetMetrics, fixture, baseline } from '../tests/helpers/database-option-render-harness.mjs';

const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw Error('--output needs a file path');
const modules = {};
for (const side of ['client', 'server']) modules[side] = {
  before: await loadModule(side, 'baseline'), after: await loadModule(side)
};
const counters = {};
for (const side of ['client', 'server']) counters[side] = {
  before: await loadModule(side, 'baseline', { instrument: true }),
  after: await loadModule(side, 'current', { instrument: true })
};
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let consumed = 0;
function consume(value) { consumed ^= value.length; }
function measure(fn, iterations) {
  const cpuStart = process.cpuUsage(), time = performance.now();
  for (let i = 0; i < iterations; i++) consume(fn());
  const elapsed = performance.now() - time, cpu = process.cpuUsage(cpuStart);
  return { wallMs: elapsed / iterations, cpuMs: (cpu.user + cpu.system) / 1000 / iterations };
}
function pairedTiming(functions, iterations) {
  // Warm actual functions for a minimum interval, then give short operations
  // enough repetitions to amortize clock/GC/JIT noise. GC during timing is real
  // workload cost; do not force a fresh collection before every tiny batch.
  for (const fn of Object.values(functions)) {
    const end = performance.now() + 150;
    do { consume(fn()); } while (performance.now() < end);
  }
  const pilot = Object.values(functions).map(fn => measure(fn, Math.max(2, iterations)));
  iterations = Math.max(iterations, Math.ceil(40 / Math.max(...pilot.map(x => x.wallMs))));
  global.gc?.();
  const samples = { before: [], after: [] };
  for (let round = 0; round < 11; round++) {
    for (const mode of round % 2 ? ['after', 'before'] : ['before', 'after']) {
      samples[mode].push(measure(functions[mode], iterations));
    }
  }
  const result = { iterationsPerSample: iterations, samples };
  for (const mode of ['before', 'after']) result[mode] = {
    medianWallMs: median(samples[mode].map(x => x.wallMs)),
    medianCpuMs: median(samples[mode].map(x => x.cpuMs))
  };
  result.wallReductionPercent = (1 - result.after.medianWallMs / result.before.medianWallMs) * 100;
  return result;
}
async function sampledAllocation(fn, iterations) {
  global.gc?.();
  const session = new Session(); session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (err, value) => err ? reject(err) : resolve(value)));
  try {
    await post('HeapProfiler.enable');
    await post('HeapProfiler.startSampling', { samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let i = 0; i < iterations; i++) consume(fn());
    const { profile } = await post('HeapProfiler.stopSampling');
    const size = node => node.selfSize + node.children.reduce((total, child) => total + size(child), 0);
    return size(profile.head) / iterations;
  } finally { session.disconnect(); }
}
const report = {
  purpose: 'Exact uploaded source vs current synchronous database operations; no timing thresholds.',
  originalArchiveSha256: baseline.sourceArchiveSha256,
  environment: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model, exposedGc: typeof global.gc === 'function' },
  limitations: ['Not full HTTP, MariaDB, authentication, network or concurrent-load testing.',
    'Runtime is recorded, not assumed to satisfy the application engine policy.',
    'Heap sampling estimates cumulative allocations, including collected objects. It is NOT peak RSS, retained memory, a memory leak test or a guarantee.',
    'Synthetic maximum-size option-heavy data; results do not imply all notes or entire app accelerate by this factor.'],
  workloads: []
};
for (const config of [
  { name: 'maximum', rows: 200, properties: 20, options: 30, iterations: 2 },
  { name: 'medium', rows: 20, properties: 5, options: 5, iterations: 30 },
  { name: 'small', rows: 1, properties: 2, options: 3, iterations: 300 }
]) {
  const data = fixture(config), normalized = modules.client.after.normalizeDatabaseData(data);
  const operations = {
    search: { side: 'client', call: m => m.applyDatabaseSearch(normalized, normalized.rows, 'not-a-match') },
    summary: { side: 'client', call: m => m.summarizeDatabaseData(data) },
    renderTable: { side: 'server', call: m => m.renderDatabaseHtml({ database: data }) }
  };
  for (const [name, operation] of Object.entries(operations)) {
    const functions = Object.fromEntries(['before', 'after'].map(mode => [mode, () => operation.call(modules[operation.side][mode])]));
    assert.deepEqual(functions.after(), functions.before(), `${config.name}/${name} output mismatch`);
    const counts = {};
    for (const mode of ['before', 'after']) {
      const module = counters[operation.side][mode]; resetMetrics(module); operation.call(module);
      counts[mode] = { ...module.auditMetrics };
    }
    const record = { fixture: config.name, rows: config.rows, properties: config.properties, options: config.options,
      operation: name, exactOutputMatch: true, outputLength: functions.after().length, counts,
      timing: pairedTiming(functions, config.iterations) };
    if (config.name === 'maximum') {
      const samples = { before: [], after: [] };
      for (let round = 0; round < 3; round++) for (const mode of round % 2 ? ['after', 'before'] : ['before', 'after']) {
        samples[mode].push(await sampledAllocation(functions[mode], 3));
      }
      record.sampledAllocation = { bytesPerCall: { before: median(samples.before), after: median(samples.after) },
        samples, samplingInterval: 4096, iterationsPerSample: 3 };
    }
    report.workloads.push(record);
  }
}
report.consumedChecksum = consumed;
const text = JSON.stringify(report, null, 2) + '\n';
if (outputIndex >= 0) writeFileSync(process.argv[outputIndex + 1], text);
console.log(text);
