#!/usr/bin/env node
/** Reproducible CPU/string-allocation/retained-heap comparison against the attached original.
 * Run: node --experimental-strip-types scripts/benchmark-resource-deep-audit.mjs --output result.json
 * Summary timing includes the full, unmodified normalizer. This is not app/server load testing.
 * No production data, database, dependency installation, or .git access is required.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { baseline, fixture, kinds, makeModule } from '../tests/helpers/resource-deep-audit-harness.mjs';
const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
const sha=s=>createHash('sha256').update(s).digest('hex');
const args=process.argv.slice(2);
// Each memory observation uses a fresh process and only keeps the returned summaries alive.
if(args[0]==='--memory-child') {
  const [,kind,mode]=args, count=24;
  assert.equal(typeof global.gc,'function');
  const module=makeModule(kind,mode), output=[];
  for(let i=0;i<12;i++)module.summarize(fixture(kind,{large:true}));
  for(let i=0;i<4;i++)global.gc();
  const before=process.memoryUsage();
  function summary(i){return module.summarize(fixture(kind,{large:true,mark:String.fromCharCode(65+i)}));}
  for(let i=0;i<count;i++)output.push(summary(i));
  const beforeGc=process.memoryUsage();
  for(let i=0;i<4;i++)global.gc();
  const retained=process.memoryUsage();
  const hash=sha(output.join('|'));
  output.length=0;
  for(let i=0;i<4;i++)global.gc();
  const released=process.memoryUsage();
  console.log(JSON.stringify({kind,mode,count,before,beforeGc,retained,released,retainedHeapDelta:retained.heapUsed-before.heapUsed,hash}));
  process.exit(0);
}
const result={inputSha256:baseline.inputSha256,environment:{node:process.version,v8:process.versions.v8,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:cpus().length},
  method:{samples:7,iterationsPerSample:30,warmupIterations:20,memorySamples:5,retainedSummaries:24,summaryLimitUtf16:20000,fullNormalizerIncluded:true,instrumentedTimings:false,metadataUtf8LimitUsed:4194304,scope:'Component functions in Node/V8. Not full-app CPU/RAM or authenticated load testing. Memory measured in fresh --expose-gc processes; retained heap is not RSS.'},counts:[],timing:[],memory:[]};
let sink=0;
for(const kind of kinds){
 const input=fixture(kind,{large:true}), metadataBytes=Buffer.byteLength(JSON.stringify(input));
 assert(metadataBytes<=4194304,'benchmark fixture exceeds global metadata limit');
 const old=makeModule(kind,'baseline',{countUuid:true,countSummary:true});
 const fixed=makeModule(kind,'current',{countUuid:true,countSummary:true});
 const a=old.summarize(input), b=fixed.summarize(input);assert.equal(a,b);
 result.counts.push({kind,metadataBytes,summaryCodeUnits:b.length,summarySha256:sha(b),baseline:old.metrics,current:fixed.metrics});
 for(const operation of ['summarize','normalize']){
  const mods={baseline:makeModule(kind,'baseline'),current:makeModule(kind,'current')};
  for(const mode of ['baseline','current'])for(let i=0;i<20;i++){const v=mods[mode][operation](input);sink+=typeof v==='string'?v.length:1;}
  const samples={baseline:[],current:[]};
  for(let s=0;s<7;s++)for(const mode of s%2?['current','baseline']:['baseline','current']){
    const start=performance.now(),cpu=process.cpuUsage();
    for(let i=0;i<30;i++){const v=mods[mode][operation](input);sink+=typeof v==='string'?v.length:1;}
    const use=process.cpuUsage(cpu);samples[mode].push({wallMsPerCall:(performance.now()-start)/30,cpuMsPerCall:(use.user+use.system)/1000/30});
  }
  result.timing.push({kind,operation,samples,baselineMedianWallMs:median(samples.baseline.map(s=>s.wallMsPerCall)),currentMedianWallMs:median(samples.current.map(s=>s.wallMsPerCall)),baselineMedianCpuMs:median(samples.baseline.map(s=>s.cpuMsPerCall)),currentMedianCpuMs:median(samples.current.map(s=>s.cpuMsPerCall))});
 }
}
for(const kind of ['ai-chat','database']){
 const samples={baseline:[],current:[]};
 for(let i=0;i<5;i++)for(const mode of i%2?['current','baseline']:['baseline','current']){
   const child=spawnSync(process.execPath,['--expose-gc','--experimental-strip-types',fileURLToPath(import.meta.url),'--memory-child',kind,mode],{encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
   if(child.error||child.status!==0)throw Error(`Memory child failed: ${child.error??child.stderr}`);
   samples[mode].push(JSON.parse(child.stdout));
 }
 assert.equal(new Set([...samples.baseline,...samples.current].map(s=>s.hash)).size,1);
 result.memory.push({kind,samples,baselineMedianRetainedHeapBytes:median(samples.baseline.map(s=>s.retainedHeapDelta)),currentMedianRetainedHeapBytes:median(samples.current.map(s=>s.retainedHeapDelta))});
}
result.sink=sink;const text=JSON.stringify(result,null,2)+'\n';
const oi=args.indexOf('--output');if(oi>=0){if(!args[oi+1])throw Error('--output needs path');writeFileSync(args[oi+1],text);}
console.log(text);
