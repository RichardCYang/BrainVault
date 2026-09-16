#!/usr/bin/env node
// Run: node scripts/benchmark-render-draft-asset-resources.mjs [--output results.json]
// No network, npm dependencies, database, production writes, or timing assertions.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setMaxListeners } from 'node:events';
import { baseline, draftRecord, makeDraftHarness, makeAssetHarness, TestAsset } from '../tests/helpers/render-draft-asset-resource-harness.mjs';
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
const outputIndex = process.argv.indexOf('--output');
if (outputIndex !== -1 && !process.argv[outputIndex + 1]) throw new Error('--output requires a filename');
const result = {
  environment: { node:process.version, v8:process.versions.v8, platform:platform(), release:release(), cpu:cpus()[0]?.model },
  inputArchiveSha256:baseline.inputArchiveSha256,
  method: 'Exact uploaded/current render function and unchanged production draft-store, with synchronous storage/UI boundary doubles. Seven alternating-order samples after warm-up. Cumulative parsed UTF-8 bytes are NOT retained heap, RSS, or process-wide memory savings.',
  drafts:[], assets:[]
};
for (const blocks of [40,128,256]) {
  const record=draftRecord(blocks,{textLength:1024});
  const cases=Object.fromEntries(['baseline','current'].map(mode=>[mode,makeDraftHarness(mode,[record])]));
  const samples={baseline:[],current:[]};
  for (const h of Object.values(cases)) { h.render(); h.render(); h.resetMetrics(); }
  assert.deepEqual(cases.baseline.rendered,cases.current.rendered);
  for (let sample=0;sample<7;sample++) {
    for (const mode of sample%2 ? ['current','baseline']:['baseline','current']) {
      const h=cases[mode]; h.resetMetrics();
      const cpu=process.cpuUsage(); const started=performance.now(); h.render();
      const wallMs=performance.now()-started; const used=process.cpuUsage(cpu);
      samples[mode].push({wallMs,cpuMs:(used.user+used.system)/1000,storageReads:h.metrics.reads,bytesRead:h.metrics.readBytes});
      assert.equal(h.metrics.writes,0); assert.equal(h.metrics.removals,0);
      assert.equal(h.metrics.reads,mode==='baseline'?blocks:1);
    }
    assert.deepEqual(cases.baseline.rendered,cases.current.rendered);
  }
  result.drafts.push({blocks,recordBytes:Buffer.byteLength(JSON.stringify(record)),outputEqual:true,
    ...Object.fromEntries(Object.entries(samples).map(([mode,s])=>[mode,{medianWallMs:median(s.map(x=>x.wallMs)),medianCpuMs:median(s.map(x=>x.cpuMs)),storageReads:s[0].storageReads,bytesRead:s[0].bytesRead,samples:s}]))});
}
for (const mode of ['baseline','current']) {
  const images=Array.from({length:12},()=>new TestAsset());
  const frames=Array.from({length:8},()=>new TestAsset());
  setMaxListeners(0,...images,...frames);
  const h=makeAssetHarness(mode,{images,frames});
  for(let i=0;i<30;i++){const waiting=h.wait();await h.advance(2500);await waiting;}
  const timeout={repeats:30,assets:20,retainedListeners:h.listeners(),outstandingTimers:h.timers.size};
  assert.equal(timeout.retainedListeners,mode==='baseline'?1200:0);
  const early=makeAssetHarness(mode,{images:[new TestAsset()],frames:[new TestAsset()]});
  const waiting=early.wait();early.images[0].fire('load');early.frames[0].fire('load');await waiting;
  result.assets.push({mode,timeout,earlySuccess:{retainedListeners:early.listeners(),outstandingTimers:early.timers.size}});
}
const json=JSON.stringify(result,null,2)+'\n';
if(outputIndex!==-1)writeFileSync(process.argv[outputIndex+1],json);
console.log(json);
