import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { joinSummaryPrefix as browserJoin } from '../public/summary-prefix.js';
import { joinSummaryPrefix as serverJoin } from '../src/lib/summary-prefix.ts';
import { getLanguage, setLanguage, supportedLanguages } from '../public/i18n.js';
import { baseline, kinds, makeModule, makeServerSummary, fixture, freeze, randomGenerator } from './helpers/resource-deep-audit-harness.mjs';

const summaryKinds=kinds.filter(k=>k!=='treeview');
for(const [path,record] of Object.entries(baseline.files)) test(`deep audit baseline is byte-exact: ${path}`,()=>{
 assert.equal(createHash('sha256').update(record.source).digest('hex'),record.sha256);
});
for(const [side,join] of [['browser',browserJoin],['server',serverJoin]]){
 for(const separator of ['', '\n', '\n\n', '😀'])for(const skipEmpty of [false,true])test(`${side} prefix parity / separator ${JSON.stringify(separator)} / skipEmpty ${skipEmpty}`,()=>{
  for(const maxLength of [0,1,2,3,7,19_999,20_000,20_001]){
   for(const lines of [[],[''],['','','x','','y',''],['a','😀','\ud800','\udc00','\0','\r\n'],['x'.repeat(19_999),'Y','Z'],['','😀'.repeat(15000),'discard']]){
    const expected=(skipEmpty?lines.filter(Boolean):lines).join(separator).slice(0,maxLength);
    assert.equal(join(freeze(lines),{separator,skipEmpty,maxLength}),expected);
   }
  }
 });
 test(`${side} stops generator at the existing prefix, runs finally, and never visits the discarded tail`,()=>{
  let visits=0,closed=false;
  function* lines(){try{visits++;yield 'x'.repeat(20_000);visits++;throw Error('discarded tail must not be visited');}finally{closed=true;}}
  assert.equal(join(lines()).length,20_000);assert.equal(visits,1);assert.equal(closed,true);
 });
 test(`${side} empty budget does not start an iterator; errors before the limit propagate`,()=>{
  assert.equal(join({[Symbol.iterator](){throw Error('not started');}},{maxLength:0}),'');
  for(const maxLength of [-1,1.5,Infinity,NaN])assert.throws(()=>join([],{maxLength}),RangeError);
  assert.throws(()=>join({*[Symbol.iterator](){yield 'prefix';throw Error('ITERATOR_FAILURE');}}),/ITERATOR_FAILURE/);
 });
 test(`${side} 2,000 seeded UTF-16 / delimiter / empty-line differential cases`,()=>{
  const rng=randomGenerator();const alphabet=['','x',' ','\n','\r','\ud800','\udfff','한','😀','\0','<&>'];
  for(let i=0;i<2000;i++){
   const lines=Array.from({length:Math.floor(rng()*30)},()=>alphabet[Math.floor(rng()*alphabet.length)].repeat(Math.floor(rng()*80)));
   const options={maxLength:Math.floor(rng()*250),separator:alphabet[Math.floor(rng()*alphabet.length)],skipEmpty:rng()>.5};
   assert.equal(join(lines,options),(options.skipEmpty?lines.filter(Boolean):lines).join(options.separator).slice(0,options.maxLength));
  }
 });
}
for(const kind of summaryKinds){
 for(const large of [false,true])test(`${kind} exact original summary and immutable normalized metadata / large ${large}`,()=>{
  const input=freeze(fixture(kind,{large,unicode:true}));
  const a=makeModule(kind,'baseline'),b=makeModule(kind);
  const raw=JSON.stringify(input);
  assert.equal(b.summarize(input),a.summarize(input));
  assert.equal(JSON.stringify(input),raw);
  assert.deepEqual(b.normalize(input),a.normalize(input));
  if(large)assert.equal(b.summarize(input).length,20_000);
 });
 test(`${kind} native ESM exports agree with source harness`,async()=>{
  const module=await import(`../public/${kind}-block.js`);
  const suffix={'ai-chat':'AiChat',accordion:'Accordion',database:'Database',timetable:'Timetable',gantt:'Gantt'}[kind];
  const x=fixture(kind,{large:true});
  assert.equal(module['summarize'+suffix+'Data'](x),makeModule(kind).summarize(x));
 });
 test(`${kind} malformed/empty/default inputs retain exact search text`,()=>{
  const a=makeModule(kind,'baseline'),b=makeModule(kind);
  const field={'ai-chat':'turns',accordion:'items',database:'rows',timetable:'entries',gantt:'tasks'}[kind];
  for(const value of [undefined,null,false,42,'bad',[],{}, {[field]:[]}, {[field]:[null,{},false,[],{title:'',question:'',answer:'',note:'',content:''}]}]){
   assert.equal(b.summarize(value),a.summarize(value),JSON.stringify(value));
  }
 });
 test(`${kind} 7-language seeded summary differential tests`,()=>{
  const previous=getLanguage(),rng=randomGenerator();
  try{
   for(const {code} of supportedLanguages){setLanguage(code,{persist:false});
    const a=makeModule(kind,'baseline'),b=makeModule(kind);
    for(let run=0;run<100;run++){
     const x=fixture(kind,{count:Math.floor(rng()*12),unicode:run%2===0});
     x.title=run%4?'한글 <script> & 😀':' ';if(run%9===0)x.title=null;
     const field={'ai-chat':'turns',accordion:'items',database:'rows',timetable:'entries',gantt:'tasks'}[kind];
     for(const item of x[field]){
      for(const prop of ['title','answer','question','content','note','assignee'])if(prop in item)item[prop]=['',null,' \r\n ','<&>\ud800😀\udfff\0', 'X'.repeat(Math.floor(rng()*25000))][Math.floor(rng()*5)];
     }
     assert.equal(b.summarize(x),a.summarize(x),`${code}/${run}`);
    }
   }
  }finally{setLanguage(previous,{persist:false});}
 });
 test(`${kind} full normalization is NOT skipped after the summary is full`,()=>{
  const x=fixture(kind,{large:true});
  const field={'ai-chat':'turns',accordion:'items',database:'rows',timetable:'entries',gantt:'tasks'}[kind];
  const last=x[field].at(-1);let read=0;
  const target=kind==='database'?last.values:last;
  const key={'ai-chat':'answer',accordion:'content',database:'p0',timetable:'note',gantt:'title'}[kind];
  const saved=target[key];Object.defineProperty(target,key,{enumerable:true,get(){read++;return saved;}});
  const output=makeModule(kind).summarize(x);
  assert.equal(output.length,20_000);assert.ok(read>0);
 });
}
test('AI summary prefix retains exact two-newline and surrogate boundaries',()=>{
 const a=makeModule('ai-chat','baseline'),b=makeModule('ai-chat');
 const x=fixture('ai-chat',{count:1});x.title='';x.model='';x.provider='chatgpt';x.turns[0]={answeredAt:'',question:'',answer:''};
 const prefix=a.summarize(x)+'\n\n';
 for(const total of [19999,20000,20001,20002]){
  x.turns[0].answer='x'.repeat(total-prefix.length-2)+'😀';
  const raw=prefix+x.turns[0].answer;
  assert.equal(b.summarize(x),raw.slice(0,20000));assert.equal(b.summarize(x),a.summarize(x));
 }
});
test('database preserves empty title/property separators and typed cell search values',()=>{
 const x=fixture('database',{count:2});x.title='';x.properties[0].name='';
 x.properties.push({id:'s',name:'Select',type:'select',options:[{id:'yes',name:'<safe>',color:'blue'}]},
  {id:'m',name:'Multi',type:'multi_select',options:[{id:'a',name:'A',color:'blue'},{id:'b',name:'B',color:'red'}]},
  {id:'c',name:'',type:'checkbox',options:[]},{id:'n',name:'',type:'number',options:[]});
 for(const row of x.rows)Object.assign(row.values,{p0:'',p1:'',s:'yes',m:['b','a','invalid','a'],c:true,n:0});
 const a=makeModule('database','baseline').summarize(x),b=makeModule('database').summarize(x);
 assert.equal(b,a);assert.ok(b.startsWith('\n'));assert.ok(b.includes('<safe>'));assert.ok(b.includes('B A'));assert.ok(b.includes('true checked'));
});
for(const kind of ['ai-chat','accordion'])test(`${kind} exact server summary function agrees with original and client`,()=>{
 const client=makeModule(kind);let normalizations=0;
 const normalize=x=>{normalizations++;return client.normalize(x);};
 const a=makeServerSummary(kind,'baseline',normalize),b=makeServerSummary(kind,'current',normalize);
 for(const large of [false,true])for(const unicode of [false,true]){
  const x=freeze(client.normalize(fixture(kind,{large,unicode})));
  assert.equal(b(x),a(x));assert.equal(b(x),client.summarize(x));
 }
 if(kind==='accordion')assert.equal(normalizations,12);
});
test('server validation/normalization bodies are unchanged (only summary and its import changed)',()=>{
 for(const kind of ['ai-chat','accordion']){
  const path=`src/lib/${kind}.ts`;
  const clean=source=>source.replace(/\r\n/g,'\n').replace(/^import \{ joinSummaryPrefix \} from "\.\/summary-prefix\.js";\n/,'').replace(/export function summarize\w+Data\([^\n]*\) \{\n[\s\S]*?\n\}/,'');
  assert.equal(clean(readFileSync(new URL('../'+path,import.meta.url),'utf8')),clean(baseline.files[path].source));
 }
});

for (const kind of ['ai-chat','accordion','database','timetable','gantt']) {
  test(`${kind}: reproducible bounded summary allocation with full metadata retained`, () => {
    const value=fixture(kind,{large:true});
    const a=makeModule(kind,'baseline',{countSummary:true});
    const b=makeModule(kind,'current',{countSummary:true});
    assert.equal(a.summarize(value),b.summarize(value));
    assert.ok(a.metrics.joinedCodeUnits>20000);
    assert.equal(b.metrics.joinedCodeUnits,20000);
    assert.ok(b.metrics.summaryFields<a.metrics.summaryFields);
    assert.ok(Buffer.byteLength(JSON.stringify(value))<=4*1024*1024);
    assert.deepEqual(a.normalize(value),b.normalize(value));
  });
}
