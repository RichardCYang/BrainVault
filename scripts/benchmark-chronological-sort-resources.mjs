#!/usr/bin/env node
// Reproduce using a project-supported Node runtime:
// node --expose-gc --experimental-strip-types scripts/benchmark-chronological-sort-resources.mjs --output /tmp/sort-benchmark.json
// No timing assertions: shared-host/JIT variation must not cause flaky tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { baseline, sourceFor, loadApp, loadTimetable, countTimetableWork, pagesFixture, timetableFixture } from '../tests/helpers/chronological-sort-resource-harness.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: [--output /path/to/result.json]');
const sha = value => createHash('sha256').update(value).digest('hex');
for (const record of Object.values(baseline.files)) assert.equal(sha(record.source), record.sourceSha256);
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), originalArchiveSha256: baseline.inputArchiveSha256,
  environment: {node:process.version, v8:process.versions.v8, platform:process.platform, arch:process.arch,
    cpu:os.cpus()[0]?.model, logicalCpus:os.cpus().length, gcExposed:typeof global.gc==='function',
    projectNodeRange:JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).engines.node},
  scope:'Isolated real production functions, not application-wide CPU/RSS or authenticated service load. Baseline sources are SHA-256 pinned. No dependency/security-engine settings are altered.',
  method:'30 warm-up calls/mode; 9 paired samples with alternating execution order. Median per-call wall time and process user+system CPU. Instrumentation runs separately, never during timing. Output equality checked before timing. CPU times include GC/JIT and other process threads. Inputs are generated once and reused; the in-place client sort receives a fresh array.',
  sourceHashes:Object.fromEntries(Object.keys(baseline.files).map(path => [path,{baseline:sha(sourceFor(path,'baseline')),current:sha(sourceFor(path))}])),
  workloads:[], allocations:[], lifetime:[]
};
let sink = 0;
function measure(run, iterations) {
  const cpu = process.cpuUsage(), start = performance.now();
  for (let i=0;i<iterations;i++) { const value=run(); sink ^= Array.isArray(value) ? value.length : value.entries.length; }
  const wallMs=performance.now()-start, usage=process.cpuUsage(cpu);
  return {wallMsPerCall:wallMs/iterations,cpuMsPerCall:(usage.user+usage.system)/1000/iterations};
}
function workload(name, runs, iterations, resultProjection=x=>x) {
  assert.deepEqual(resultProjection(runs.baseline()),resultProjection(runs.current()),name+' parity');
  for(let i=0;i<30;i++) for(const mode of ['baseline','current']) runs[mode]();
  const samples={baseline:[],current:[]};
  for(let i=0;i<9;i++) for(const mode of (i%2 ? ['current','baseline']:['baseline','current'])) samples[mode].push(measure(runs[mode],iterations));
  const medians=Object.fromEntries(Object.entries(samples).map(([mode,values])=>[mode,{
    wallMsPerCall:median(values.map(v=>v.wallMsPerCall)),cpuMsPerCall:median(values.map(v=>v.cpuMsPerCall))}]));
  report.workloads.push({name,iterationsPerSample:iterations,samplesPerMode:9,medians,
    wallReductionPercent:100*(1-medians.current.wallMsPerCall/medians.baseline.wallMsPerCall),
    cpuReductionPercent:100*(1-medians.current.cpuMsPerCall/medians.baseline.cpuMsPerCall),
    resultSha256:sha(JSON.stringify(resultProjection(runs.current()))),samples});
}
const pages=pagesFixture(), timetable=timetableFixture();
for(const method of ['sortByRecent','sortByNavigationOrder']) {
  const modes=Object.fromEntries(['baseline','current'].map(mode=>[mode,loadApp(mode)]));
  workload(method+' / 5000 pages',Object.fromEntries(Object.entries(modes).map(([mode,api])=>[mode,()=>api[method](pages)])),12);
  const metrics={};
  for(const mode of ['baseline','current']) {const api=loadApp(mode,{instrument:true});api[method](pages);metrics[mode]={...api.metrics};}
  report.allocations.push({name:method+' / 5000 pages',metrics});
}
{
 const modes=Object.fromEntries(['baseline','current'].map(mode=>[mode,loadApp(mode)]));
 for(const api of Object.values(modes)) api.state.navigationPageOrder=new Map(pages.map((p,i)=>[p.id,i]));
 workload('navigation / 5000 uniquely ranked pages (no date work)',Object.fromEntries(Object.entries(modes).map(([mode,api])=>[mode,()=>api.sortByNavigationOrder(pages)])),150);
}
for(const side of ['client','server']) {
 const modes=Object.fromEntries(['baseline','current'].map(mode=>[mode,loadTimetable(mode,side)]));
 const input=side==='server'?{timetable}:timetable;
 const normalized=modes.current.normalize(input).entries;
 assert.equal(normalized.length,200,'benchmark must exercise all timetable rows');
 workload(side+' timetable normalization / 200 entries',Object.fromEntries(Object.entries(modes).map(([mode,api])=>[mode,()=>api.normalize(input)])),250);
 const unsorted=timetable.entries.map(entry=>normalized.find(e=>e.id===entry.id));
 workload(side+' timetable sort only / 200 entries',Object.fromEntries(Object.entries(modes).map(([mode,api])=>[mode,()=>api.sortEntries([...unsorted])])),750);
 const metrics={};
 for(const [mode,api] of Object.entries(modes)) {const {value,...counts}=countTimetableWork(()=>api.normalize(input));metrics[mode]=counts;}
 report.allocations.push({name:side+' timetable normalization / 200 entries',metrics});
}
// A lifetime check, not a claim about peak heap or RSS. Let all strong refs leave
// their stack before collecting. WeakRefs are never read between collection turns.
if(typeof global.gc==='function') {
 for(const mode of ['baseline','current']) for(const method of ['sortByRecent','sortByNavigationOrder']) {
  const api=loadApp(mode);
  const refs=(()=>{const input=pagesFixture(1000);api[method](input);return input.map(p=>new WeakRef(p));})();
  for(let i=0;i<4;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
  const retained=refs.filter(ref=>ref.deref()!==undefined).length;
  assert.equal(retained,0,`${mode}/${method} retained input pages`);
  report.lifetime.push({mode,method,pageObjects:refs.length,retainedAfterCollection:retained});
 }
} else report.lifetime.push({notRun:'Re-run with --expose-gc to check the temporary timestamp cache does not retain input page objects.'});
report.sink=sink;
const json=JSON.stringify(report,null,2)+'\n';
if(args.length) writeFileSync(args[1],json);
console.log(json);
