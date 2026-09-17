// Reproduce with the project's supported Node runtime:
// node --expose-gc scripts/benchmark-bounded-save-summary.mjs
// Reports isolated real-function benchmarks, NOT production throughput or RSS.
// Exact uploaded original functions are retained in the test fixture. No logs
// are written to the repository; JSON is printed to stdout. No dependencies.
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeHarness, makeFixture, operations } from '../tests/helpers/bounded-save-summary-harness.mjs';
const [flag, mode, kind] = process.argv.slice(2);
const fixtureKind = kind => kind === 'serverBookmark' ? 'bookmark' : kind === 'kanbanNormalize' ? 'kanban' : kind;
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
if (flag === '--memory-worker') {
  if (typeof global.gc !== 'function') throw Error('This worker requires --expose-gc');
  const operation = operations(makeHarness(mode))[kind];
  for (let i=0;i<8;i++) operation(makeFixture(fixtureKind(kind),i));
  global.gc();global.gc();
  const before = process.memoryUsage().heapUsed;
  const held = [];
  for(let i=0;i<24;i++) held.push(operation(makeFixture(fixtureKind(kind),i+100)));
  global.gc();global.gc();
  const after = process.memoryUsage().heapUsed;
  const digest = createHash('sha256').update(JSON.stringify(held)).digest('hex');
  held.length=0;global.gc();global.gc();
  console.log(JSON.stringify({retainedHeapBytes:after-before,afterReleaseBytes:process.memoryUsage().heapUsed-before,digest,heldSummaries:24}));
} else {
  const report = {node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,
    method:'7 alternating timing samples; median milliseconds per call. Memory: median of 3 fresh --expose-gc processes, holding only 24 summaries after dropping input data. HeapUsed, not RSS; isolated functions/DOM doubles, not MariaDB E2E.',timing:{},memory:{},uuidCalls:{},fixtureJsonBytes:{}};
  const harnesses = {original:makeHarness('original'),current:makeHarness('current')};
  const all = Object.fromEntries(Object.entries(harnesses).map(([key,value])=>[key,operations(value)]));
  for(const kind of ['table','kanban','bookmark','serverBookmark','kanbanNormalize']) {
    report.timing[kind]={};
    for(const size of ['small','maximum']) {
      const data=makeFixture(fixtureKind(kind),0,size==='small');
      report.fixtureJsonBytes[`${kind}/${size}`]=Buffer.byteLength(JSON.stringify(data));
      const samples={original:[],current:[]};const cpu={original:[],current:[]};
      for(const variant of ['original','current'])for(let i=0;i<25;i++)all[variant][kind](data);
      const count=size==='small'?300:15;
      for(let sample=0;sample<7;sample++)for(const variant of sample%2?['current','original']:['original','current']) {
        const startCpu=process.cpuUsage();const start=performance.now();
        for(let i=0;i<count;i++)all[variant][kind](data);
        samples[variant].push((performance.now()-start)/count);
        const used=process.cpuUsage(startCpu);cpu[variant].push((used.user+used.system)/1000/count);
      }
      report.timing[kind][size]=Object.fromEntries(['original','current'].map(v=>[v,{medianWallMs:median(samples[v]),medianCpuMs:median(cpu[v]),samplesMs:samples[v]}]));
    }
  }
  for(const variant of ['original','current']) {
    let count=0;const h=makeHarness(variant,{crypto:{randomUUID(){count++;return `audit-${count}`;}}});
    h.normalizeKanbanData(makeFixture('kanban'));report.uuidCalls[variant]=count;
  }
  for(const kind of ['table','kanban','bookmark','serverBookmark']) {
    report.memory[kind]={};
    for(const variant of ['original','current']) {
      const samples=[];
      for(let i=0;i<3;i++) {
        const child=spawnSync(process.execPath,['--expose-gc',fileURLToPath(import.meta.url),'--memory-worker',variant,kind],{encoding:'utf8',timeout:45000});
        if(child.status!==0)throw Error(`Memory worker failed: ${child.stderr}`);
        samples.push(JSON.parse(child.stdout));
      }
      report.memory[kind][variant]={medianRetainedHeapBytes:median(samples.map(s=>s.retainedHeapBytes)),samples};
    }
    const hashes=new Set(Object.values(report.memory[kind]).flatMap(v=>v.samples.map(s=>s.digest)));
    if(hashes.size!==1)throw Error(`Output mismatch: ${kind}`);
  }
  console.log(JSON.stringify(report,null,2));
}
