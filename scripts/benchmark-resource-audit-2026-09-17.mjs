#!/usr/bin/env node
// Deterministic work counters are the regression gates; timings are observations,
// not pass/fail thresholds and not whole-application or retained-heap estimates.
// Run: node scripts/benchmark-resource-audit-2026-09-17.mjs > result.json
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import {
  resourceAuditBaseline, insertionFixture, loadInsertion, measureInsertionReads,
  collaborationTreeFixture, loadCollaborationTree, freezeAuditInput
} from '../tests/helpers/resource-audit-2026-09-17-harness.mjs';

const samples = 9, iterations = 12, warmup = 8;
function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}
function timePair(before, after, input) {
  for (let index = 0; index < warmup; index++) { before(input); after(input); }
  const results = { baseline: [], current: [] };
  for (let sample = 0; sample < samples; sample++) {
    // Alternate order to limit systematic warmup/temperature bias.
    for (const mode of sample % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
      const run = mode === 'baseline' ? before : after;
      const cpu = process.cpuUsage(), wall = performance.now();
      for (let index = 0; index < iterations; index++) run(input);
      const wallMs = (performance.now() - wall) / iterations;
      const used = process.cpuUsage(cpu);
      results[mode].push({wallMs, cpuMs: (used.user + used.system) / 1000 / iterations});
    }
  }
  return Object.fromEntries(Object.entries(results).map(([mode, runs]) => [mode, {
    medianWallMs: median(runs.map(run => run.wallMs)),
    medianCpuMs: median(runs.map(run => run.cpuMs)), runs
  }]));
}

const report = {
  node: process.version, platform: platform(), architecture: arch(), cpu: cpus()[0]?.model,
  baselineArchiveSha256: resourceAuditBaseline.archiveSha256 ?? resourceAuditBaseline.sourceArchiveSha256,
  scope: 'Exact uploaded/current functions, deterministic synthetic fixtures. Counters instrument JS array reads/Map.get/Set constructors, not CPU utilization or bytes of retained heap. Timing excludes instrumentation and input construction.',
  samples, iterations, warmup, cases: []
};
for (const reorder of [false, true]) {
  const input = freezeAuditInput(insertionFixture(2000, reorder));
  const baseline = loadInsertion('baseline'), current = loadInsertion();
  const a = measureInsertionReads(baseline, input), b = measureInsertionReads(current, input);
  assert.deepEqual(b.result, a.result);
  assert.equal(b.indexedReads, 4002);
  report.cases.push({name: 'insertion-' + (reorder ? 'reorder' : 'tail'), siblings: 2000,
    resultEqual: true, indexedReads: {baseline: a.indexedReads, current: b.indexedReads},
    timings: timePair(baseline, current, input)});
}
for (const leafFirst of [false, true]) {
  const input = freezeAuditInput(collaborationTreeFixture(2000, 128, leafFirst));
  const a = loadCollaborationTree('baseline', {instrument: true}), b = loadCollaborationTree('current', {instrument: true});
  assert.deepEqual(b.run(input), a.run(input));
  assert.equal(b.metrics.setAllocations, 1);
  assert.ok(b.metrics.mapGets < 9000);
  const baseline = loadCollaborationTree('baseline'), current = loadCollaborationTree();
  report.cases.push({name: 'tree-' + (leafFirst ? 'leaf-first' : 'root-first'), nodes: 2000,
    spineNodes: 128, resultEqual: true, counters: {baseline: a.metrics, current: b.metrics},
    timings: timePair(baseline.run, current.run, input)});
}
const flat = freezeAuditInput(collaborationTreeFixture(2000, 0));
const a = loadCollaborationTree('baseline', {instrument: true}), b = loadCollaborationTree('current', {instrument: true});
assert.deepEqual(b.run(flat), a.run(flat));
assert.deepEqual(b.metrics, a.metrics);
report.cases.push({name: 'flat-tree-control', resultEqual: true, nodes: 2000,
  counters: {baseline: a.metrics, current: b.metrics},
  timings: timePair(loadCollaborationTree('baseline').run, loadCollaborationTree().run, flat)});
console.log(JSON.stringify(report, null, 2));
