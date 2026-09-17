#!/usr/bin/env node
// node --experimental-strip-types scripts/benchmark-citation-span-resources.mjs --output /tmp/results.json
// Actual original/current component code. DOM doubles are explicit; these are
// not whole-application CPU/RSS measurements or authenticated database load tests.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { baseline, makeAiModule, makeSignature, proseFixture, wrapperFixture, blockFixture, snapshot, hash } from '../tests/helpers/citation-span-resource-harness.mjs';
const args=process.argv.slice(2),median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
if(args[0]==='--memory-child') {
  const mode=args[1];assert.equal(typeof globalThis.gc,'function');
  const mod=await makeAiModule(mode),root=proseFixture();
  for(let i=0;i<8;i++){const units=[];mod.collect(proseFixture(),units);}
  for(let i=0;i<3;i++)globalThis.gc();
  const before=process.memoryUsage(),units=[];
  mod.collect(root,units);
  for(let i=0;i<3;i++)globalThis.gc();
  const during=process.memoryUsage(),unitCount=units.length;
  units.length=0;
  for(let i=0;i<3;i++)globalThis.gc();
  const released=process.memoryUsage();
  console.log(JSON.stringify({mode,unitCount,before,during,released,liveTokenHeapBytes:during.heapUsed-before.heapUsed}));
  process.exit(0);
}
const modules={baseline:await makeAiModule('baseline'),current:await makeAiModule('current')};
const signatures={baseline:makeSignature('baseline').signature,current:makeSignature('current').signature};
const result={inputArchiveSha256:baseline.inputArchiveSha256,environment:{node:process.version,v8:process.versions.v8,os:platform(),arch:arch(),cpu:cpus()[0]?.model},
 method:{samples:7,alternatingOrder:true,iterationsPerSample:20,warmups:10,timingInstrumentation:false,fixturesCreatedOutsideTiming:true,
 scope:'Component timings with explicit DOM doubles. Not total application CPU, RAM, RSS or a leak measurement.',
 memoryScope:'Temporary collector tokens kept live across forced GC in five fresh --expose-gc child processes per mode; tokens are then released.'},counts:[],timing:[],memory:[]};
for(const [operation,fixture] of [['group',proseFixture],['wrapper',wrapperFixture]]) {
  const instrumented={baseline:await makeAiModule('baseline',{instrument:true}),current:await makeAiModule('current',{instrument:true})};
  const outputs={};
  for(const mode of ['baseline','current']) {
    const m=instrumented[mode];m.auditMetrics.groupUnits=m.auditMetrics.splitCodeUnits=0;
    const input=fixture();m[operation](input);outputs[mode]=JSON.stringify(snapshot(input));
    result.counts.push({operation,mode,...m.auditMetrics,outputSha256:hash(outputs[mode])});
  }
  assert.equal(outputs.current,outputs.baseline);
}
for(const mode of ['baseline','current']) {
 const m=makeSignature(mode,{instrument:true}),text=m.signature(blockFixture());
 result.counts.push({operation:'signature-5000',mode,...m.metrics,outputSha256:hash(text)});
}
let sink=0;
for(const operation of ['group','wrapper','signature-flat','signature-nested']) {
 const fixture=operation==='group'?proseFixture:operation==='wrapper'?wrapperFixture:()=>blockFixture(5000,{nested:operation==='signature-nested'});
 const run=mode=>operation.startsWith('signature')?signatures[mode]:modules[mode][operation];
 for(const mode of ['baseline','current'])for(let i=0;i<10;i++)run(mode)(fixture());
 const samples={baseline:[],current:[]};
 for(let sample=0;sample<7;sample++)for(const mode of sample%2?['current','baseline']:['baseline','current']) {
  const inputs=Array.from({length:20},()=>fixture()),fn=run(mode),outputs=[];
  const cpu=process.cpuUsage(),start=performance.now();
  for(const input of inputs)outputs.push(fn(input));
  const wallMs=performance.now()-start,use=process.cpuUsage(cpu);
  for(const value of outputs)sink+=typeof value==='string'?value.length:1;
  samples[mode].push({wallMsPerCall:wallMs/20,cpuMsPerCall:(use.user+use.system)/1000/20});
 }
 const baselineMedianMs=median(samples.baseline.map(s=>s.wallMsPerCall)),currentMedianMs=median(samples.current.map(s=>s.wallMsPerCall));
 result.timing.push({operation,samples,baselineMedianMs,currentMedianMs,wallReductionPercent:100*(1-currentMedianMs/baselineMedianMs),
  baselineMedianCpuMs:median(samples.baseline.map(s=>s.cpuMsPerCall)),currentMedianCpuMs:median(samples.current.map(s=>s.cpuMsPerCall))});
}
for(let i=0;i<5;i++)for(const mode of i%2?['current','baseline']:['baseline','current']) {
 const proc=spawnSync(process.execPath,['--expose-gc','--experimental-strip-types',fileURLToPath(import.meta.url),'--memory-child',mode],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
 assert.equal(proc.status,0,proc.stderr);result.memory.push(JSON.parse(proc.stdout));
}
result.memoryMedians=Object.fromEntries(['baseline','current'].map(mode=>[mode,median(result.memory.filter(m=>m.mode===mode).map(m=>m.liveTokenHeapBytes))]));
result.sink=sink;
const output=JSON.stringify(result,null,2)+'\n',index=args.indexOf('--output');
if(index>=0){assert.ok(args[index+1],'--output requires a path');writeFileSync(args[index+1],output);}
console.log(output);
