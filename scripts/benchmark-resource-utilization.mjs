#!/usr/bin/env node
/** Original-upload/current component benchmark. No server/DB, no RSS claims.
 * Run: node --experimental-strip-types scripts/benchmark-resource-utilization.mjs [--output /path/result.json]
 * Timings exclude fixture construction, module compilation and instrumentation.
 * Operation counts use separate, instrumented executions. Compare like-for-like
 * on the same machine; CPU/wall ratios are not whole-application speedups.
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { baseline, makeAppHarness, fixture, makeWebSocketHarness, FakeSocket } from '../tests/helpers/resource-utilization-harness.mjs';
const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--output')) throw Error('Usage: node scripts/benchmark-resource-utilization.mjs [--output path]');
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const result={scope:'Exact production functions with explicit DOM/storage/socket doubles, NOT full-app HTTP/database E2E. Timings are uninstrumented. Counts and copies are measured separately; no RSS/heap reduction is inferred.',
  inputArchiveSha256:baseline.inputArchiveSha256,environment:{node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model},parameters:{blocks:5000,warmups:3,samples:9},operations:{},timings:{}};
const modes=['baseline','current'];
function runApp(kind,mode,instrument=false) {
  const h=makeAppHarness(mode,{instrument,realPayload:kind==='sync'}),f=fixture(5000,{withDrafts:kind==='recover'});
  h.state.selectedPage=f.page;h.setRows(f.rows);h.setRecords([f.record]);
  return {h,f,run:()=>kind==='sync'?h.sync():kind==='recover'?h.recover(f.page):h.adopt(f.page.id,{...f.flat[0]},{orderedIds:f.record.blockOrder.orderedIds})};
}
for(const kind of ['sync','recover','adopt']) {
  result.operations[kind]={};const outputs=[];
  for(const mode of modes) {const c=runApp(kind,mode,true),value=c.run();outputs.push({page:c.f.page,value,events:c.h.events});result.operations[kind][mode]={...c.h.metrics};}
  assert.deepEqual(outputs[0],outputs[1],`${kind}: original/current behavior differs`);
  const times=Object.fromEntries(modes.map(mode=>[mode,[]]));
  for(let i=0;i<12;i++) for(const mode of i%2?[...modes].reverse():modes) {
    const c=runApp(kind,mode);const cpu=process.cpuUsage(),start=performance.now();c.run();const wallMs=performance.now()-start,used=process.cpuUsage(cpu);
    if(i>=3)times[mode].push({wallMs,cpuMs:(used.user+used.system)/1000});
  }
  result.timings[kind]=Object.fromEntries(modes.map(mode=>[mode,{medianWallMs:median(times[mode].map(x=>x.wallMs)),medianCpuMs:median(times[mode].map(x=>x.cpuMs)),samples:times[mode]}]));
}
result.operations.websocket={};
for(const mode of modes){
  const w=makeWebSocketHarness(mode,{instrument:true});
  for(let i=0;i<1000;i++){const s=new FakeSocket(),c=new w.WebSocketConnection(s,4096);c.start();c.close();c.terminate();}
  const pendingCloseTimers=w.clock.timers.size;w.clock.tick(2000);
  w.metrics.copiedInputBytes=0;const s=new FakeSocket();s.write=()=>true;
  const c=new w.WebSocketConnection(s,2*1024*1024);c.sendBinary(new Uint8Array(1024*1024));c.terminate();
  w.metrics.byteLengthCodeUnits=0;w.metrics.byteLengthCalls=0;const prefix=w.truncateCloseReason('한'.repeat(10000));
  result.operations.websocket[mode]={connections:1000,pendingCloseTimers,inputPayloadBytes:1024*1024,intermediateCopiedInputBytes:w.metrics.copiedInputBytes,
    closeReasonInputCodeUnits:10000,closeReasonScannedCodeUnits:w.metrics.byteLengthCodeUnits,closeReasonByteLengthCalls:w.metrics.byteLengthCalls,closeReasonOutputBytes:Buffer.byteLength(prefix)};
}
for(const kind of ['closeReason','binarySend']) {
  const times=Object.fromEntries(modes.map(m=>[m,[]]));
  const modules=Object.fromEntries(modes.map(m=>[m,makeWebSocketHarness(m)]));
  const reason='한'.repeat(10000),payload=new Uint8Array(1024*1024);
  for(let i=0;i<12;i++)for(const mode of i%2?[...modes].reverse():modes){
    const w=modules[mode],s=new FakeSocket();s.write=()=>true;const c=new w.WebSocketConnection(s,2*1024*1024);
    const cpu=process.cpuUsage(),start=performance.now();
    if(kind==='closeReason')w.truncateCloseReason(reason);else for(let j=0;j<20;j++)c.sendBinary(payload);
    const wallMs=performance.now()-start,used=process.cpuUsage(cpu);c.terminate();
    if(i>=3)times[mode].push({wallMs,cpuMs:(used.user+used.system)/1000});
  }
  result.timings[kind]={payload:kind==='closeReason'?'10000 Korean UTF-16 units':'20 synchronous 1 MiB sends into a non-retaining sink',
    ...Object.fromEntries(modes.map(m=>[m,{medianWallMs:median(times[m].map(x=>x.wallMs)),medianCpuMs:median(times[m].map(x=>x.cpuMs)),samples:times[m]}]))};
}
const text=JSON.stringify(result,null,2)+'\n';
if(args.length){const output=resolve(args[1]);mkdirSync(dirname(output),{recursive:true});writeFileSync(output,text);}
console.log(text);
