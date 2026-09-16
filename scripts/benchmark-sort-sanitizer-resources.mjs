#!/usr/bin/env node
// Reproducible module microbenchmark, not HTTP/MariaDB E2E.
// Run on a project-supported Node: node --expose-gc scripts/benchmark-sort-sanitizer-resources.mjs
// Uses the byte-verified uploaded source, without reading or modifying .git.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { loadDatabase, databaseFixture, freeze } from '../tests/helpers/sort-sanitizer-resource-harness.mjs';

const median = xs => [...xs].sort((a,b) => a-b)[Math.floor(xs.length / 2)];
const hash = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const results = [];
for (const side of ['client', 'server']) for (const type of ['multi_select', 'select', 'text', 'number', 'checkbox']) {
  const data = freeze(databaseFixture({ type }));
  const before = await loadDatabase('baseline', side), after = await loadDatabase('current', side);
  const countedBefore = await loadDatabase('baseline', side, { instrument:true });
  const countedAfter = await loadDatabase('current', side, { instrument:true });
  const expected = countedBefore.applyDatabaseView(data), actual = countedAfter.applyDatabaseView(data);
  assert.deepEqual(actual, expected);
  for (let i=0; i<50; i++) { before.applyDatabaseView(data); after.applyDatabaseView(data); }
  const timings = {baseline:[], current:[]}, cpu = {baseline:[], current:[]};
  const iterations = 60;
  let consumed = 0;
  for (let round=0; round<13; round++) for (const mode of round % 2 ? ['current','baseline'] : ['baseline','current']) {
    globalThis.gc?.();
    const module = mode === 'baseline' ? before : after;
    const cpuStart = process.cpuUsage(), start = performance.now();
    for (let i=0; i<iterations; i++) consumed += module.applyDatabaseView(data).length;
    const elapsed = performance.now()-start, used = process.cpuUsage(cpuStart);
    timings[mode].push(elapsed/iterations);
    cpu[mode].push((used.user+used.system)/1000/iterations);
  }
  assert.ok(consumed > 0);
  results.push({side,type,rows:200,options:30,selections:type==='multi_select'?10:1,
    identicalOutputSha256:hash(actual),
    workCounts:{baseline:countedBefore.auditMetrics,current:countedAfter.auditMetrics},
    timing:{iterationsPerSample:iterations,samples:13,rawMillisecondsPerCall:timings,
      medianMillisecondsPerCall:{baseline:median(timings.baseline),current:median(timings.current)},
      speedup:median(timings.baseline)/median(timings.current),
      medianCpuMillisecondsPerCall:{baseline:median(cpu.baseline),current:median(cpu.current)}}});
}
console.log(JSON.stringify({node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,
  cpu:cpus()[0]?.model,gcBetweenSamples:typeof globalThis.gc==='function',
  scope:'Isolated, uninstrumented full production modules; instrumented work counts measured separately. Not whole-app latency/CPU/RSS. Timing is environment-dependent.',results},null,2));
