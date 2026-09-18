// Run: node --expose-gc scripts/benchmark-database-editor-resources.mjs
// Exact original/current module bodies, with a small DOM double. This measures
// JS/editor-construction CPU, not browser layout; see the separate browser test.
// Raw samples and deterministic work counters are written to stdout as JSON.
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { source, load, documentDouble, fixture, render, reset } from '../tests/helpers/database-editor-resource-harness.mjs';

const modules={before:await load(true),after:await load()};
const counted={before:await load(true,true),after:await load(false,true)};
const previous=globalThis.document;
globalThis.document=documentDouble;
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const output={node:process.version,cpu:cpus()[0]?.model,method:'One warmup batch per version, 11 alternating measured samples; 6 renders or 200 input events per sample. Explicit GC before measurement when enabled; CPU is user+system process time. DOM double excludes layout. Fixture creation is outside measured region.',gcAvailable:typeof globalThis.gc==='function',hashes:Object.fromEntries([true,false].map(before=>[before?'before':'after',createHash('sha256').update(source(before)).digest('hex')])),cases:{}};
let sink=0;
try {
  for(const view of ['table','list','board']) {
    const data=fixture(),results={};
    for(const version of ['before','after']){reset(counted[version]);render(counted[version],data,view);results[version]={work:{...counted[version].auditMetrics},samples:[]};}
    const batch=module=>{for(let i=0;i<6;i++)sink+=render(module,data,view).children.length;};
    for(const module of Object.values(modules))batch(module);
    for(let run=0;run<11;run++)for(const version of run%2?['after','before']:['before','after']){
      globalThis.gc?.();const cpu=process.cpuUsage(),start=performance.now();batch(modules[version]);
      const elapsedMs=(performance.now()-start)/6,used=process.cpuUsage(cpu);
      results[version].samples.push({elapsedMs,cpuMs:(used.user+used.system)/1000/6});
    }
    for(const result of Object.values(results))result.median={elapsedMs:median(result.samples.map(x=>x.elapsedMs)),cpuMs:median(result.samples.map(x=>x.cpuMs))};
    output.cases[view]=results;
  }
  const results={},text='x,'.repeat(999)+'x';
  const make=(module)=>{const data=fixture({rows:1,properties:2});const control=module.createValueEditor(data.rows[0],data.properties[1],{onDirty(){}});control.value=text;return control;};
  for(const version of ['before','after']){
    const control=make(counted[version]);reset(counted[version]);control.send('input');results[version]={work:{...counted[version].auditMetrics},samples:[]};
  }
  const controls=Object.fromEntries(Object.entries(modules).map(([version,module])=>[version,make(module)]));
  for(const control of Object.values(controls))for(let i=0;i<200;i++)control.send('input');
  for(let run=0;run<11;run++)for(const version of run%2?['after','before']:['before','after']){
    globalThis.gc?.();const cpu=process.cpuUsage(),start=performance.now();
    for(let i=0;i<200;i++)controls[version].send('input');
    const elapsedMs=(performance.now()-start)/200,used=process.cpuUsage(cpu);
    results[version].samples.push({elapsedMs,cpuMs:(used.user+used.system)/1000/200});
  }
  for(const result of Object.values(results))result.median={elapsedMs:median(result.samples.map(x=>x.elapsedMs)),cpuMs:median(result.samples.map(x=>x.cpuMs))};
  output.cases.pastedNames=results;
  output.sink=sink;
  console.log(JSON.stringify(output,null,2));
} finally {
  if(previous===undefined)delete globalThis.document;else globalThis.document=previous;
}
