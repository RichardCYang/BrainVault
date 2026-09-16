#!/usr/bin/env node
// Reproducible original/current microbenchmarks; no npm packages or application services.
// Run with a supported project Node version:
// node --expose-gc --experimental-strip-types scripts/benchmark-resource-hotpaths.mjs --output result.json
// Counts are deterministic assertions; elapsed/CPU/heap samples are observations, not test gates.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { baseline, loadDatabase, makeDiff, countLowercase, filterFixture,
  manifest, regenerated } from '../tests/helpers/resource-hotpaths-harness.mjs';

const args = process.argv.slice(2);
let output;
if (args.length) {
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: benchmark-resource-hotpaths.mjs [--output result.json]');
  output = args[1];
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let sink;
function sample(run, iterations) {
  if (globalThis.gc) globalThis.gc();
  const beforeHeap = process.memoryUsage().heapUsed;
  const cpu = process.cpuUsage(), start = performance.now();
  for (let i = 0; i < iterations; i++) sink = run();
  const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
  return { wallMsPerCall: wallMs / iterations, cpuMsPerCall: (used.user + used.system) / 1000 / iterations,
    heapUsedDeltaBytes: process.memoryUsage().heapUsed - beforeHeap };
}
function benchmark(before, after, iterations) {
  for (let i = 0; i < 3; i++) { before(); after(); }
  const samples = { baseline: [], current: [] };
  for (let i = 0; i < 9; i++) {
    const modes = i % 2 ? ['current', 'baseline'] : ['baseline', 'current'];
    for (const mode of modes) samples[mode].push(sample(mode === 'baseline' ? before : after, iterations));
  }
  const results = Object.fromEntries(Object.entries(samples).map(([mode, rows]) => [mode, {
    wallMsMedian: median(rows.map(r => r.wallMsPerCall)), cpuMsMedian: median(rows.map(r => r.cpuMsPerCall)), samples: rows
  }]));
  return { iterationsPerSample: iterations, samplesPerVariant: 9, warmupCallsPerVariant: 3,
    order: 'alternating baseline/current and current/baseline', ...results,
    wallTimeReductionPercent: (1 - results.current.wallMsMedian / results.baseline.wallMsMedian) * 100,
    cpuTimeReductionPercent: (1 - results.current.cpuMsMedian / results.baseline.cpuMsMedian) * 100 };
}

const snapshot = manifest({ blocksPerPage: 2000, htmlLength: 16000 });
for (const block of snapshot.data.blocks) block.type = 'MARKDOWN';
const current = regenerated(snapshot);
for (const block of current.data.blocks) block.markdown = 'changed ' + block.id;
const originalDiff = makeDiff('baseline', { instrument: true }), revisedDiff = makeDiff('current', { instrument: true });
const a = originalDiff.diff(snapshot, current), b = revisedDiff.diff(snapshot, current);
assert.equal(JSON.stringify(b), JSON.stringify(a));
assert.equal(originalDiff.metrics.hashCalls, 8000);
assert.equal(revisedDiff.metrics.hashCalls, 2000);
const untimedBefore = makeDiff('baseline'), untimedAfter = makeDiff('current');
const diff = { workload: { pages: 1, changedBlocks: 2000, htmlCacheCodeUnitsPerBlock: 16000, retainedBlockDetails: b.pages[0].blocks.length },
  outputByteIdentical: true, summary: b.summary, baselineCounts: originalDiff.metrics, currentCounts: revisedDiff.metrics,
  timing: benchmark(() => untimedBefore.diff(snapshot, current), () => untimedAfter.diff(snapshot, current), 1) };
const databases = {};
for (const side of ['client', 'server']) {
  const original = await loadDatabase(side, 'baseline'), revised = await loadDatabase(side, 'current'), fixture = filterFixture();
  const before = countLowercase(() => original.applyDatabaseView(fixture)), after = countLowercase(() => revised.applyDatabaseView(fixture));
  assert.deepEqual(after.value, before.value);
  assert.equal(before.lowercaseCalls, 3200); assert.equal(after.lowercaseCalls, 1608);
  databases[side] = { workload: { rows: fixture.rows.length, filters: fixture.views[0].filters.length,
    filterTextCodeUnits: fixture.views[0].filters[0].value.length, allFiltersReached: true }, outputIdentical: true,
    baselineCounts: { lowercaseCalls: before.lowercaseCalls, lowercaseInputCodeUnits: before.lowercaseInputCodeUnits },
    currentCounts: { lowercaseCalls: after.lowercaseCalls, lowercaseInputCodeUnits: after.lowercaseInputCodeUnits },
    timing: benchmark(() => original.applyDatabaseView(fixture), () => revised.applyDatabaseView(fixture), 10) };
}
const report = { generatedAt: new Date().toISOString(), scope: 'Isolated production functions, not application-wide throughput, latency, or a live database benchmark.',
  environment: { node: process.version, platform: platform(), architecture: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, explicitGc: Boolean(globalThis.gc) },
  notes: ['The baseline source is byte-for-byte the uploaded source, SHA-256 checked by the harness.',
    'Timing samples exclude instrumentation, module loading, input construction, and serialization assertions.',
    'The Node runtime must meet package.json engines in deployment. The script does not relax that requirement.',
    'Heap-used deltas are noisy, GC-dependent allocation observations, NOT peak memory, retained heap, or a leak proof.',
    'No global caches, authentication changes, backup integrity changes, or reduced data limits are involved.'],
  baselineSourceSha256: Object.fromEntries(Object.entries(baseline.files).map(([path, file]) => [path, file.sha256])), diff, databases };
const json = JSON.stringify(report, null, 2) + '\n';
if (output) writeFileSync(output, json);
process.stdout.write(json);
void sink;
