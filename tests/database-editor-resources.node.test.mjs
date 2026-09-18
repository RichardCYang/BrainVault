import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {baseline,source,load,documentDouble,render,controls,snapshot,fixture,freeze,reset,random} from './helpers/database-editor-resource-harness.mjs';
const before=await load(true),after=await load(),countedBefore=await load(true,true),countedAfter=await load(false,true);
const withDom = fn => {const previous=globalThis.document;globalThis.document=documentDouble;try{return fn();}finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}};

test('database editor: fixture is the fingerprinted input module',()=>{
  const file=baseline.files['public/database-block.js'];
  assert.equal(createHash('sha256').update(file.source).digest('hex'),file.sha256);
});
for (const view of ['table','list','board']) {
  test(`database editor: ${view} max-capacity rendering removes repeated option scans and cell scratch arrays`,()=>withDom(()=>{
    const input=freeze(fixture());reset(countedBefore);reset(countedAfter);
    const expected=render(countedBefore,input,view),actual=render(countedAfter,input,view);
    assert.deepEqual(snapshot(actual),snapshot(expected));
    assert.equal(countedBefore.auditMetrics.optionComparisons,1767000);
    assert.equal(countedBefore.auditMetrics.labelArrays,7600);
    assert.equal(countedAfter.auditMetrics.optionComparisons,0);
    assert.equal(countedAfter.auditMetrics.indexVisits,570);
    assert.equal(countedAfter.auditMetrics.optionLookups,114000);
    assert.equal(countedAfter.auditMetrics.labelArrays,1);
    assert.equal(countedAfter.auditMetrics.releasedIndexProperties,19);
  }));
}
test('database editor: many typed unknown names use one membership lookup per option',()=>withDom(()=>{
  const names='x,'.repeat(999)+'x';
  const inputs=[countedBefore,countedAfter].map(m=>{const d=fixture({rows:1,properties:2});reset(m);const c=m.createValueEditor(d.rows[0],d.properties[1],{onDirty(){}});reset(m);c.value=names;c.send('input');return d.rows[0].values.p1;});
  assert.deepEqual(inputs[1],inputs[0]);assert.deepEqual(inputs[0],[]);
  assert.equal(countedBefore.auditMetrics.nameComparisons,30000);
  assert.equal(countedAfter.auditMetrics.nameComparisons,0);
  assert.equal(countedAfter.auditMetrics.nameLookups,30);
}));
for (const view of ['table','list','board']) for(const type of ['multi_select','select','text','number','checkbox','date','url']) {
  test(`database editor: ${view}/${type} output and input metadata remain identical`,()=>withDom(()=>{
    const input=fixture({rows:4,properties:5,type,options:9});
    input.properties[1].name='<img src=x onerror=alert(1)> & 😀';
    if(type==='url') input.rows[0].values.p1='javascript:alert(1)';
    if(type==='select') input.views[0].groupPropertyId='p1';
    freeze(input);assert.deepEqual(snapshot(render(after,input,view)),snapshot(render(before,input,view)));
    assert.deepEqual(after.normalizeDatabaseData(input),before.normalizeDatabaseData(input));
  }));
}
test('database editor: 800 seeded rendering cases preserve unknown/duplicate IDs, blank labels, sparse values and separators',()=>withDom(()=>{
  const rng=random(),ids=['same','missing','__proto__','constructor','empty','o0','o1'],names=['','x',' X ','한글','😀','<script>alert(1)</script>',null,0,false];
  for(let run=0;run<800;run++){
    const d=fixture({rows:2+rng(5),properties:2+rng(5),options:rng(31)});
    for(const p of d.properties.slice(1)) for(const option of p.options){option.id=ids[rng(ids.length)];option.name=names[rng(names.length)];}
    for(const row of d.rows) for(const p of d.properties.slice(1)){
      row.values[p.id]=Array.from({length:rng(12)},()=>ids[rng(ids.length)]);
      if(run%5===0) delete row.values[p.id][0];
      if(run%7===0) row.values[p.id]=null;
    }
    d.views[0].hiddenPropertyIds=run%3===0?['p1']:[];freeze(d);
    assert.deepEqual(snapshot(render(after,d)),snapshot(render(before,d)),`run=${run}`);
  }
}));
test('database editor: 1000 seeded input events preserve selected IDs, option order, duplicates and dirty/change notifications',()=>withDom(()=>{
  const rng=random(91),names=['a','A',' a ','İ','I','ı','i','한글','😀','','x','<svg/onload=alert(1)>'];
  for(let run=0;run<1000;run++){
    const original=fixture({rows:1,properties:2,options:rng(31)});
    for(const o of original.properties[1].options)o.name=names[rng(names.length)];
    const text=Array.from({length:rng(80)},()=>names[rng(names.length)]).join(',');
    const outcomes=[before,after].map(m=>{
      const d=structuredClone(original),events=[];
      const c=m.createValueEditor(d.rows[0],d.properties[1],{onDirty:()=>events.push('dirty'),onStructuralChange:()=>events.push('change')});
      c.value=text;c.send('input');c.send('change');
      // Edits must resolve the *current* option labels, not an old render index.
      if(d.properties[1].options.length)d.properties[1].options[0].name='renamed';
      c.value='renamed';c.send('input');return {values:d.rows[0].values.p1,events};
    });
    assert.deepEqual(outcomes[1],outcomes[0],`run=${run}`);assert.deepEqual(outcomes[1].events,['dirty','change','dirty']);
  }
}));
test('database editor: render indexes never survive option changes or workspace replacements',()=>withDom(()=>{
  const d=fixture({rows:3,properties:3,options:30});
  for(let i=0;i<100;i++){
    const expected=snapshot(render(before,d));assert.deepEqual(snapshot(render(after,d)),expected);
    d.properties[1].options[0].name='new label '+i;
    if(i%2===0)d.properties[1].options.reverse();
    d.rows[0].values.p1=i%2?['o0','o2']:['o1','o29'];
  }
  const other=fixture({rows:3,properties:3});other.properties[1].options[0].name='other account';
  assert.deepEqual(snapshot(render(after,other)),snapshot(render(before,other)));
}));
test('database editor: hidden properties and blank cells do not build option indexes',()=>withDom(()=>{
  for(const mode of ['hidden','empty','text']){
    const d=fixture({type:mode==='text'?'text':'multi_select'});
    if(mode==='hidden')d.views[0].hiddenPropertyIds=d.properties.slice(1).map(p=>p.id);
    if(mode==='empty')for(const row of d.rows)for(const p of d.properties.slice(1))row.values[p.id]=[];
    reset(countedAfter);render(countedAfter,freeze(d));assert.equal(countedAfter.auditMetrics.indexVisits,0);
  }
}));
test('database editor: single-row/tiny-option inputs keep the allocation-light path',()=>withDom(()=>{
  for(const shape of [{rows:1,options:30},{rows:2,options:7}]){
    const d=freeze(fixture({...shape,properties:3}));reset(countedAfter);
    assert.deepEqual(snapshot(render(countedAfter,d)),snapshot(render(before,d)));assert.equal(countedAfter.auditMetrics.indexVisits,0);
  }
}));

// Narrow production change guard: normalization, limits, validation, URL safety,
// persistence, event callbacks and all other module code must remain byte-identical.
test('database editor: changes are restricted to the reviewed multi-select paths',()=>{
  let current=source().replace(/\r\n/g,'\n');
  const original=source(true).replace(/\r\n/g,'\n');
  const start=current.indexOf('function formatDatabaseMultiSelectValue(');
  const end=current.indexOf('function createValueEditor(',start);
  if(start>=0)current=current.slice(0,start)+current.slice(end);
  current=current.replace(', readMultiSelectValue = formatDatabaseMultiSelectValue','')
    .replace('? readMultiSelectValue(property, value)','? (Array.isArray(value) ? value.map((id) => getOption(property, id)?.name).filter(Boolean).join(", ") : "")')
    .replace('      // Large pasted lists otherwise rescan every name for every option.\n      // Keep tiny edits allocation-light, and preserve option order/duplicates.\n      const selectedNames = names.length >= 8 && property.options.length >= 8 ? new Set(names) : null;\n','')
    .replace('.filter((option) => selectedNames\n          ? selectedNames.has(option.name.toLocaleLowerCase())\n          : names.includes(option.name.toLocaleLowerCase()))','.filter((option) => names.includes(option.name.toLocaleLowerCase()))')
    .replaceAll('  const readMultiSelectValue = createDatabaseMultiSelectValueReader(rows.length);\n','')
    .replaceAll('  readMultiSelectValue.release?.();\n','')
    .replace(/^ +readMultiSelectValue,\n/gm,'');
  assert.equal(current,original);
});

for (const viewType of ['table','list','board']) {
  test(`database editor: ${viewType} filtered/sorted cell edits retain structural redraw and row removal`,()=>withDom(()=>{
    const outcomes=[before,after].map(module=>{
      const data=fixture({rows:4,properties:3}),events=[];
      const view={...data.views[0],type:viewType,filters:[{id:'filter',propertyId:'p1',operator:'contains',value:'o1'}],sorts:[{id:'sort',propertyId:'p1',direction:'descending'}]};
      data.views[0]=view;
      const method={table:'createTableView',list:'createListView',board:'createBoardView'}[viewType];
      const initial=module[method](null,data,view,module.applyDatabaseView(data,view),()=>events.push('dirty'),()=>events.push('replace'));
      const control=controls(initial).find(c=>c.dataset.rowId==='r0'&&c.dataset.propertyId==='p1');
      control.value='unknown';control.send('input');control.send('change');
      const remaining=module.applyDatabaseView(data,view);
      assert.equal(remaining.length,3);assert.ok(remaining.every(row=>row.id!=='r0'));
      const fresh=module[method](null,data,view,remaining,()=>{},()=>{});
      return {events,data,rendered:snapshot(fresh)};
    });
    assert.deepEqual(outcomes[1],outcomes[0]);assert.deepEqual(outcomes[1].events,['dirty','replace']);
  }));
}
