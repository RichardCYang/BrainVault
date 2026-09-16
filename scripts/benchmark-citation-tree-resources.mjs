#!/usr/bin/env node
// Component CPU and transient-live-heap comparison against the attached source.
// node --experimental-strip-types scripts/benchmark-citation-tree-resources.mjs --output result.json
// No npm packages, database, external network, or .git access. No production flags change.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { baseline, makeAiModule, makeTreeValidator, text, element, treeFixture } from '../tests/helpers/citation-tree-resource-harness.mjs';
const args = process.argv.slice(2);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
if (args[0] === '--memory-child') {
  const [, mode, operation, rawLength] = args, length = Number(rawLength);
  assert.equal(typeof globalThis.gc, 'function');
  const module = await makeAiModule(mode, { memoryProbe: true });
  const block = element('p', [text('x'.repeat(length))]);
  // Flatten input before the baseline so source-text allocation is excluded.
  assert.equal(block.childNodes[0].nodeValue.charCodeAt(length - 1), 120);
  for (let n = 0; n < 4; n++) globalThis.gc();
  const before = process.memoryUsage();
  module[operation](block);
  for (let n = 0; n < 4; n++) globalThis.gc();
  const after = process.memoryUsage();
  console.log(JSON.stringify({ mode, operation, length, before, after, samples: module.auditHeapSamples,
    transientLiveHeapDelta: Math.max(before.heapUsed, after.heapUsed, ...module.auditHeapSamples) - before.heapUsed,
    postGcHeapDelta: after.heapUsed - before.heapUsed }));
  process.exit(0);
}
const result = {
  inputSha256: baseline.inputSha256,
  environment: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  method: {
    scope: 'Isolated production functions with minimal DOM double; not whole-app CPU/RSS or a database load test.',
    samples: 7, order: 'alternating baseline/current', warmup: 12,
    memory: '3 fresh --expose-gc child processes per mode/operation; a test-only probe collects after GC while the completed units array is still live. Preflight skips use post-call heap. This is transient live heap, not an ongoing leak, RSS, or guaranteed process peak.',
    runtime: 'Execution environment may be below the project production security floor; no runtime guard or package engine policy is disabled.'
  }, counts: [], timing: [], memory: []
};
function benchmark(label, run, iterations) {
  const values = { baseline: [], current: [] };
  for (const mode of ['baseline', 'current']) for (let i = 0; i < 12; i++) run[mode]();
  for (let sample = 0; sample < 7; sample++) for (const mode of sample % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
    const start = performance.now(), cpu = process.cpuUsage();
    for (let i = 0; i < iterations; i++) run[mode]();
    const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
    values[mode].push({ wallMsPerCall: wallMs / iterations, cpuMsPerCall: (used.user + used.system) / 1000 / iterations });
  }
  result.timing.push({ label, iterations, samples: values, ...Object.fromEntries(Object.entries(values).map(([key, rows]) => [key,
    { medianWallMs: median(rows.map(row => row.wallMsPerCall)), medianCpuMs: median(rows.map(row => row.cpuMsPerCall)) }])) });
}
for (const length of [50_000, 500_000]) {
  const runs = {};
  for (const mode of ['baseline', 'current']) {
    const counted = await makeAiModule(mode, { instrument: true });
    counted.auditMetrics.groupUnits = counted.auditMetrics.wrapperUnits = 0;
    const input = element('p', [text('x'.repeat(length))]);
    counted.group(input); counted.wrapper(input);
    result.counts.push({ label: 'plain-paragraph', length, mode, ...counted.auditMetrics });
    const module = await makeAiModule(mode);
    runs[mode] = { group: () => module.group(input), wrapper: () => module.wrapper(input) };
  }
  for (const operation of ['group', 'wrapper']) benchmark(`AI-${operation}-${length}`, {
    baseline: runs.baseline[operation], current: runs.current[operation]
  }, length === 50_000 ? 25 : 8);
}
for (const shape of ['chain', 'reverse', 'flat']) {
  const input = treeFixture(300, shape), runs = {};
  for (const mode of ['baseline', 'current']) {
    const counted = makeTreeValidator(mode, { instrument: true }); counted.validate(input);
    result.counts.push({ label: 'TREEVIEW', shape, nodes: 300, mode, ...counted.metrics });
    const module = makeTreeValidator(mode); runs[mode] = () => module.validate(input);
  }
  benchmark(`TREEVIEW-${shape}`, runs, 100);
}
for (const operation of ['group', 'wrapper']) {
  const observations = { baseline: [], current: [] };
  for (let sample = 0; sample < 3; sample++) for (const mode of sample % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
    const child = spawnSync(process.execPath, ['--expose-gc', '--experimental-strip-types', fileURLToPath(import.meta.url), '--memory-child', mode, operation, '500000'],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr);
    observations[mode].push(JSON.parse(child.stdout));
  }
  result.memory.push({ operation, length: 500000, observations,
    baselineMedianTransientLiveHeapBytes: median(observations.baseline.map(row => row.transientLiveHeapDelta)),
    currentMedianTransientLiveHeapBytes: median(observations.current.map(row => row.transientLiveHeapDelta)) });
}
const output = JSON.stringify(result, null, 2) + '\n';
const index = args.indexOf('--output');
if (index >= 0) { assert.ok(args[index + 1], '--output requires a path'); writeFileSync(args[index + 1], output); }
process.stdout.write(output);
