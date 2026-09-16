import assert from 'node:assert/strict';
import test from 'node:test';
import { makeModule, fixture, freeze, sourceFor } from './helpers/resource-deep-audit-harness.mjs';
const cases=[['accordion','items',50,1,'accordion-item'],['treeview','nodes',300,1,'tree-node'],['timetable','entries',200,1,'entry'],['gantt','tasks',200,2,'task']];
for(const [kind,field,maxCount,defaults,prefix] of cases){
 for(const count of [0,1,10,maxCount])test(`${kind}: ${count} existing IDs are unchanged without discarded UUIDs`,()=>{
  const a=makeModule(kind,'baseline',{countUuid:true}),b=makeModule(kind,'current',{countUuid:true});
  const x=freeze(fixture(kind,{count}));
  assert.deepEqual(b.normalize(x),a.normalize(x));
  assert.equal(a.metrics.uuidCalls,count+defaults);assert.equal(b.metrics.uuidCalls,defaults);
 });
 test(`${kind}: missing, blank, overlength, duplicate and prototype-name IDs remain safe and unique`,()=>{
  for(const id of [undefined,null,42,'','   ','x'.repeat(100),'__proto__','constructor']){
   const x=fixture(kind,{count:4});for(const row of x[field])row.id=id;
   const b=makeModule(kind,'current',{countUuid:true});const data=b.normalize(x);
   assert.equal(new Set(data[field].map(row=>row.id)).size,4);
   assert.ok(data[field].every(row=>typeof row.id==='string'&&row.id.length>0&&row.id.length<=64));
   if(typeof id!=='string'||!id.trim()){
    assert.equal(b.metrics.uuidCalls,defaults+4);assert.ok(data[field].every(row=>row.id.startsWith(prefix+'-')));
   }else{
    assert.equal(b.metrics.uuidCalls,defaults);assert.equal(data[field][0].id,id.slice(0,64));
   }
  }
 });
 test(`${kind}: default data and generated ID algorithm are not replaced with weaker randomness`,()=>{
  const a=makeModule(kind,'baseline',{countUuid:true}),b=makeModule(kind,'current',{countUuid:true});
  assert.deepEqual(b.createDefault(),a.createDefault());
  const select=source=>source.replace(/\r\n/g,'\n').match(/function createId\(prefix\) \{\n[\s\S]*?\n\}/)[0];
  assert.equal(select(sourceFor(kind)),select(sourceFor(kind,'baseline')));
  assert.match(select(sourceFor(kind)),/crypto\?\.randomUUID/);
 });
 test(`${kind}: 100 normalizations do not rotate saved IDs or mutate metadata`,()=>{
  const x=freeze(fixture(kind,{count:10})),b=makeModule(kind,'current',{countUuid:true});
  const normalized=b.normalize(x);
  for(let i=0;i<100;i++)assert.deepEqual(b.normalize(normalized),normalized);
  assert.deepEqual(b.normalize(x),normalized);assert.equal(b.metrics.uuidCalls,102*defaults);
 });
}
