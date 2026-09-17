import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceFor, loadModule, resetMetrics, fixture, seededRandom, freeze } from './helpers/database-option-render-harness.mjs';

const before = {client:await loadModule('client','baseline'),server:await loadModule('server','baseline')};
const after = {client:await loadModule('client'),server:await loadModule('server')};
const counted = {};
for (const side of ['client','server']) counted[side]={before:await loadModule(side,'baseline',{instrument:true}),after:await loadModule(side,'current',{instrument:true})};

for (const side of ['client','server']) test(`${side}: all normalization, option validation and view filtering/sorting stay byte-identical`,()=>{
  const a=sourceFor(side,'baseline').replace(/\r\n/g,'\n'),b=sourceFor(side).replace(/\r\n/g,'\n');
  const end=side==='client'?'function getOption(':'function escapeHtml(';
  assert.equal(b.slice(0,b.indexOf(end)),a.slice(0,a.indexOf(end)));
  if(side==='client') {
    const start='function rowMatchesFilter(',end='function applyDatabaseSearch(';
    assert.equal(b.slice(b.indexOf(start),b.indexOf(end)),a.slice(a.indexOf(start),a.indexOf(end)));
  }
});

test('200 x 20 x 30 search: reproduce 1,767,000 comparisons; fixed indexes exactly 570 options',()=>{
  const input=freeze(after.client.normalizeDatabaseData(fixture()));
  for(const m of Object.values(counted.client)) resetMetrics(m);
  const a=counted.client.before.applyDatabaseSearch(input,input.rows,'not-a-match');
  const b=counted.client.after.applyDatabaseSearch(input,input.rows,'not-a-match');
  assert.deepEqual(b,a);assert.equal(b.length,0);
  assert.equal(counted.client.before.auditMetrics.optionComparisons,1767000);
  assert.equal(counted.client.after.auditMetrics.optionComparisons,0);
  assert.equal(counted.client.after.auditMetrics.optionIndexVisits,570);
});

test('200 x 20 x 30 server render: exact HTML, 1,767,000 comparisons removed and 113,430 repeated encodings removed',()=>{
  const input=freeze({database:fixture()});
  for(const m of Object.values(counted.server)) resetMetrics(m);
  assert.equal(counted.server.after.renderDatabaseHtml(input),counted.server.before.renderDatabaseHtml(input));
  const a=counted.server.before.auditMetrics,b=counted.server.after.auditMetrics;
  assert.equal(a.optionComparisons,1767000);assert.equal(b.optionComparisons,0);
  assert.equal(b.optionIndexVisits,570);assert.equal(a.escapeCalls-b.escapeCalls,113430);
});

for(const view of ['table','board','list']) for(const type of ['multi_select','select','text','number','checkbox','date','url']) {
  test(`${view}/${type}: exact HTML, search, summary, row identity and unchanged input`,()=>{
    const data=fixture({rows:9,properties:5,options:6,type,view});
    if(type==='url') data.rows[0].values.p1='javascript:alert(1)';
    data.title='<img src=x onerror=alert(1)>';data.properties[1].name='</th><script>bad</script>';
    if(data.properties[1].options.length) data.properties[1].options[0].name='<img src=x onerror=alert(1)> & " \' 😀';
    freeze(data);
    const input=freeze({database:data});
    assert.equal(after.server.renderDatabaseHtml(input),before.server.renderDatabaseHtml(input));
    assert.equal(after.client.summarizeDatabaseData(data),before.client.summarizeDatabaseData(data));
    const normalized=freeze(after.client.normalizeDatabaseData(data));
    for(const query of ['', '  ', '항목', 'row 2', 'not present', '<img', '😀', null, 2, 'FALSE']) {
      const result=after.client.applyDatabaseSearch(normalized,normalized.rows,query);
      assert.deepEqual(result,before.client.applyDatabaseSearch(normalized,normalized.rows,query));
      for(const row of result) assert.ok(normalized.rows.includes(row));
      if(!String(query??'').trim()) assert.equal(result,normalized.rows);
    }
  });
}

test('blank queries, title short-circuit, text-only data and empty render allocate no option index',()=>{
  const c=counted.client.after,s=counted.server.after;
  for(const type of ['text','multi_select']) {
    const data=freeze(c.normalizeDatabaseData(fixture({rows:3,properties:4,type})));
    for(const query of ['', '  ', 'row']) {resetMetrics(c);c.applyDatabaseSearch(data,data.rows,query);assert.equal(c.auditMetrics.mapAllocations,0);}
    if(type==='text') {resetMetrics(c);c.applyDatabaseSearch(data,data.rows,'absent');assert.equal(c.auditMetrics.mapAllocations,0);}
  }
  resetMetrics(s); s.renderDatabaseHtml({database:fixture({rows:0})}); assert.equal(s.auditMetrics.optionIndexVisits,0);
  const hidden=fixture({rows:10}); hidden.views[0].hiddenPropertyIds=hidden.properties.slice(1).map(p=>p.id);
  resetMetrics(s); s.renderDatabaseHtml({database:hidden}); assert.equal(s.auditMetrics.optionIndexVisits,0);
});

test('direct search preserves duplicate first-match, empty labels, separators and prototype-like string IDs',()=>{
  const data=fixture({rows:2,properties:2,options:0});
  data.properties[1].options=[{id:'same',name:'first',color:'blue'},{id:'same',name:'second',color:'red'},
    {id:'empty',name:'',color:'gray'},{id:'__proto__',name:'prototype literal',color:'blue'},
    ...Array.from({length:4},(_,i)=>({id:'unused'+i,name:'Unused '+i,color:'gray'}))];
  data.rows[0].values.p1=['same','absent','empty','__proto__'];freeze(data);
  for(const q of ['first','second','first   prototype','prototype literal','absent','constructor']) {
    assert.deepEqual(after.client.applyDatabaseSearch(data,data.rows,q),before.client.applyDatabaseSearch(data,data.rows,q));
  }
  assert.equal({}.polluted,undefined);
});

test('1,200 seeded valid/malformed JSON cases preserve normalization, metadata, summaries and all three views',()=>{
  const random=seededRandom();
  const names=['','<&>','😀','İ I ı i','한글','</span><script>globalThis.pwned=1</script>'];
  for(let run=0;run<1200;run++) {
    const data=fixture({rows:Math.floor(random()*12),properties:2+Math.floor(random()*5),options:Math.floor(random()*9),
      type:run%2?'select':'multi_select',view:['table','list','board'][run%3]});
    for(const property of data.properties) for(const option of property.options) option.name=names[Math.floor(random()*names.length)];
    if(run%5===0) data.properties[1].options.push({id:'o0',name:'duplicate',color:'red'});
    if(run%7===0) data.properties[1].id='__proto__';
    if(run%11===0) data.rows.unshift(null,{});
    if(run%13===0) data.properties[1].options=[null,{},...data.properties[1].options];
    if(run%17===0) data.rows.push({id:'bad',values:JSON.parse('{"__proto__":{"polluted":true},"p1":["missing","o0",null]}')});
    if(run%19===0) data.properties[1].options='not-an-array';
    if(run%3===0) data.views[0].sorts=[{id:'s',propertyId:'p1',direction:'descending'}];
    if(run%4===0) data.views[0].filters=[{id:'f',propertyId:'title',operator:'contains',value:'row'}];
    if(run%6===0) data.views[0].hiddenPropertyIds=['p2'];
    freeze(data);
    assert.deepEqual(after.client.normalizeDatabaseData(data),before.client.normalizeDatabaseData(data),`normalize ${run}`);
    assert.equal(after.client.summarizeDatabaseData(data),before.client.summarizeDatabaseData(data),`summary ${run}`);
    assert.equal(after.server.renderDatabaseHtml({database:data}),before.server.renderDatabaseHtml({database:data}),`html ${run}`);
    const normalized=freeze(after.client.normalizeDatabaseData(data));
    for(const q of [names[run%names.length],'no-match']) assert.deepEqual(after.client.applyDatabaseSearch(normalized,normalized.rows,q),before.client.applyDatabaseSearch(normalized,normalized.rows,q),`search ${run}`);
  }
  assert.equal({}.polluted,undefined);assert.equal(globalThis.pwned,undefined);
});

test('option edits, colors, deletion, type changes and a foreign page with the same IDs never reuse stale cached values',()=>{
  const data=fixture({rows:5,properties:3,options:4});
  for(let i=0;i<60;i++) {
    data.properties[1].type=['multi_select','select','text'][i%3];
    data.properties[1].options=data.properties[1].options.filter(option=>option.id!=='temporary');
    if(i%2) data.properties[1].options.push({id:'temporary',name:'Temporary '+i,color:'green'});
    data.rows[0].values.p1=i%3===0?['o0','temporary']:i%3===1?'o0':'Text '+i;
    data.properties[1].options[0].name='Fresh '+i;
    data.properties[1].options[0].color=i%2?'red':'blue';
    const foreign=fixture({rows:4,properties:3,options:4,label:'Other account '+i});
    for(const value of [data,foreign]) {
      const normalized=after.client.normalizeDatabaseData(value);
      assert.equal(after.server.renderDatabaseHtml({database:value}),before.server.renderDatabaseHtml({database:value}));
      assert.equal(after.client.summarizeDatabaseData(value),before.client.summarizeDatabaseData(value));
      assert.deepEqual(after.client.applyDatabaseSearch(normalized,normalized.rows,'Fresh '+i),before.client.applyDatabaseSearch(normalized,normalized.rows,'Fresh '+i));
    }
    data.rows[0].values.p1=i%2?['o0']:['o3'];
  }
});

test('source metadata JSON strings and invalid metadata retain the original fail-safe rendering',()=>{
  for(const input of [null,{},[],1,'bad','null','[]',JSON.stringify({database:fixture({rows:3})})]) {
    assert.equal(after.server.renderDatabaseHtml(input),before.server.renderDatabaseHtml(input));
  }
});

// Index break-even gates are part of the resource behavior, not just timing.
test('single-row and tiny-option fast paths preserve all threshold boundaries without needless indexes',()=>{
  for(const rows of [0,1,2,9]) for(const options of [0,1,7,8,30]) for(const type of ['select','multi_select']) {
    const data=fixture({rows,properties:3,options,type});
    const normalized=freeze(after.client.normalizeDatabaseData(data));
    for(const side of ['client','server']) {
      const a=counted[side].before,b=counted[side].after;resetMetrics(a);resetMetrics(b);
      const call=m=>side==='client'?m.applyDatabaseSearch(normalized,normalized.rows,'not-found'):m.renderDatabaseHtml({database:data});
      assert.deepEqual(call(b),call(a));
      if(rows<2 || (side==='client' && options<8)) assert.equal(b.auditMetrics.optionIndexVisits,0);
      if(rows>=2 && options>=8) assert.equal(b.auditMetrics.optionComparisons,0);
    }
  }
});
