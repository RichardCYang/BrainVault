// Reproducible operation counts and process-local CPU microbenchmarks. No npm,
// network, database, production data, or .git access. Run with Node >=22.13:
// node scripts/benchmark-cpu-memory-regression.mjs --output result.json
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  makeTreeModule, treeFixture, countPathReads, makeMermaidLoader
} from '../tests/helpers/cpu-memory-regression-harness.mjs';

const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error('--output requires a path');
const iterations = 100, samples = 9;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const side of ['client', 'server']) {
  for (const shape of ['root-first-chain', 'leaf-first-chain', 'flat-control']) {
    const input = treeFixture(300, { reverse: shape === 'leaf-first-chain' });
    if (shape === 'flat-control') for (const node of input.nodes) node.parentId = null;
    const before = makeTreeModule('baseline', { side, instrument: true });
    const after = makeTreeModule('current', { side, instrument: true });
    assert.deepEqual(after.normalize(input), before.normalize(input));
    const timed = Object.fromEntries(['baseline', 'current'].map(mode => [mode, {
      module: makeTreeModule(mode, { side }), wall: [], cpu: []
    }]));
    for (const run of Object.values(timed)) for (let i = 0; i < 30; i++) run.module.normalize(input);
    // Alternate ordering so a single mode is not always first or always warmed.
    for (let sample = 0; sample < samples; sample++) {
      for (const mode of sample % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        const run = timed[mode], cpuStart = process.cpuUsage(), start = performance.now();
        for (let i = 0; i < iterations; i++) run.module.normalize(input);
        run.wall.push(performance.now() - start);
        const cpu = process.cpuUsage(cpuStart); run.cpu.push((cpu.user + cpu.system) / 1000);
      }
    }
    results.push({ side, shape, nodes: 300, iterations, samples,
      baselineOperations: before.metrics, currentOperations: after.metrics,
      timing: Object.fromEntries(Object.entries(timed).map(([mode, run]) => [mode, {
        medianWallMs: median(run.wall), medianCpuMs: median(run.cpu), allWallMs: run.wall, allCpuMs: run.cpu
      }])) });
  }
}
const pathCounts = {};
for (const mode of ['baseline', 'current']) {
  const module = makeTreeModule(mode, { instrument: true });
  module.path(countPathReads(treeFixture(), module.metrics), 'node-299');
  pathCounts[mode] = module.metrics;
}
const loaderCounts = [];
for (const event of ['error', 'load']) {
  for (const mode of ['baseline', 'current']) {
    const loader = makeMermaidLoader(mode);
    for (let i = 0; i < 100; i++) {
      const task = loader.load(); loader.scripts.at(-1).dispatch(event); await assert.rejects(task);
    }
    loaderCounts.push({ mode, event, attempts: 100, retainedScripts: loader.scripts.length,
      retainedListeners: loader.scripts.reduce((n, script) => n + script.listenerCount, 0) });
  }
}
const result = {
  node: process.version, platform: process.platform, arch: process.arch,
  note: 'Timings are process-local microbenchmarks, not total app CPU usage. Set counts measure transient allocations/insertion operations, not heap bytes. Mermaid counts use the explicit event/DOM double; the companion Chromium test validates real DOM retention.',
  results, pathCounts, loaderCounts
};
const text = JSON.stringify(result, null, 2) + '\n';
if (outputIndex >= 0) writeFileSync(process.argv[outputIndex + 1], text);
process.stdout.write(text);
