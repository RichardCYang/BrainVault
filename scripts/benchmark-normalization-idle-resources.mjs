#!/usr/bin/env node
// Exact uploaded/current code, same inputs, alternating order. Work counters are
// regression gates; microbenchmark timings are not total-app CPU/RSS estimates.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { baseline, loadDatabase, databaseFixture, freeze } from '../tests/helpers/normalization-idle-resource-harness.mjs';

const samples = 11;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = { node: process.version, platform: platform(), architecture: arch(), cpu: cpus()[0]?.model,
  sourceArchiveSha256: baseline.sourceArchiveSha256, samples,
  scope: 'Complete normalizer microbenchmark. Allocation counts count Sets, not retained heap bytes. Timings are observations, not pass/fail limits.', cases: [] };
for (const side of ['client', 'server']) {
  const before = await loadDatabase(side, 'baseline'), after = await loadDatabase(side);
  const countedBefore = await loadDatabase(side, 'baseline', { instrument: true });
  const countedAfter = await loadDatabase(side, 'current', { instrument: true });
  for (const dimensions of [{ rows: 200, properties: 20, options: 30 }, { rows: 20, properties: 5, options: 5 }, { rows: 1, properties: 2, options: 3 }]) {
    // Use longer batches for small inputs so timer/JIT noise does not dominate.
    const iterations = dimensions.rows >= 200 ? 20 : dimensions.rows >= 20 ? 1500 : 12000;
    const warmup = dimensions.rows >= 200 ? 30 : dimensions.rows >= 20 ? 600 : 3000;
    const input = freeze(databaseFixture(dimensions));
    assert.deepEqual(after.normalize(input), before.normalize(input));
    for (const instance of [countedBefore, countedAfter]) {
      for (const key of Object.keys(instance.metrics)) instance.metrics[key] = 0;
      instance.normalize(input);
    }
    const work = { baseline: { ...countedBefore.metrics }, current: { ...countedAfter.metrics } };
    for (let index = 0; index < warmup; index++) { before.normalize(input); after.normalize(input); }
    const times = { baseline: [], current: [] };
    for (let sample = 0; sample < samples; sample++) {
      for (const mode of sample % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        const fn = mode === 'baseline' ? before.normalize : after.normalize;
        const cpu = process.cpuUsage(), start = performance.now();
        for (let iteration = 0; iteration < iterations; iteration++) fn(input);
        const wallMs = (performance.now() - start) / iterations, used = process.cpuUsage(cpu);
        times[mode].push({ wallMs, cpuMs: (used.user + used.system) / 1000 / iterations });
      }
    }
    const timing = Object.fromEntries(Object.entries(times).map(([mode, runs]) => [mode, {
      medianWallMs: median(runs.map(run => run.wallMs)), medianCpuMs: median(runs.map(run => run.cpuMs)), samples: runs
    }]));
    report.cases.push({ side, ...dimensions, iterationsPerSample: iterations, warmupIterations: warmup, work, timing });
  }
}
console.log(JSON.stringify(report, null, 2));
