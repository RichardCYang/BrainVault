// Run: node --expose-gc scripts/benchmark-search-tree-resources.mjs
// Timings are observations, never pass/fail thresholds. Selected-row byte counts
// use explicit fixtures, not a MariaDB wire/RSS measurement.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { makeKeyboard, makeTree, treeFixture, makeSearch, searchFixture } from '../tests/helpers/search-tree-resource-harness.mjs';
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const output={node:process.version,method:'Exact before/current source; operation counts and alternating warmed CPU timings; synthetic selected-row byte sizes.'};
output.keyboard={};output.treeOperations={};output.search={};
for(const mode of ['baseline','current']) {
  const h=makeKeyboard(mode);for(let i=0;i<1000;i++)h.key('a');output.keyboard[mode]={...h.metrics};
  const tree=makeTree(mode,true),html=tree.render({treeView:treeFixture()});
  output.treeOperations[mode]={...tree.metrics,htmlBytes:Buffer.byteLength(html),htmlSha256:createHash('sha256').update(html).digest('hex')};
  const search=makeSearch(mode,searchFixture()),result=await search.run({limit:30});
  output.search[mode]={selectedRowJsonBytes:result.selectedBytes,responseJsonBytes:Buffer.byteLength(JSON.stringify(result.response)),responseSha256:createHash('sha256').update(JSON.stringify(result.response)).digest('hex')};
}
assert.equal(output.treeOperations.baseline.htmlSha256,output.treeOperations.current.htmlSha256);
assert.equal(output.search.baseline.responseSha256,output.search.current.responseSha256);
output.treeTimings={};
const modules={baseline:makeTree('baseline'),current:makeTree('current')};
for(const [label,config,count,repeats] of [
 ['deep300',{},300,30],['deep300-reversed',{reverse:true},300,30],['flat300',{flat:true},300,100],
 ['single-memo300',{oneNote:true},300,100],['no-memos300',{notes:false},300,100],['small10',{},10,400]
]) {
  const metadata={treeView:treeFixture(count,config)},times={baseline:[],current:[]},cpu={baseline:[],current:[]};
  assert.equal(modules.baseline.render(metadata),modules.current.render(metadata));
  for(let i=0;i<15;i++)for(const mode of ['baseline','current'])modules[mode].render(metadata);
  for(let sample=0;sample<9;sample++)for(const mode of sample%2?['current','baseline']:['baseline','current']) {
    globalThis.gc?.();const start=performance.now(),startCpu=process.cpuUsage();
    for(let i=0;i<repeats;i++)modules[mode].render(metadata);
    const duration=performance.now()-start,used=process.cpuUsage(startCpu);
    times[mode].push(duration/repeats);cpu[mode].push((used.user+used.system)/1000/repeats);
  }
  output.treeTimings[label]={rendersPerSample:repeats,baselineMs:times.baseline,currentMs:times.current,
    baselineMedianMs:median(times.baseline),currentMedianMs:median(times.current),
    baselineMedianCpuMs:median(cpu.baseline),currentMedianCpuMs:median(cpu.current)};
}
console.log(JSON.stringify(output,null,2));
