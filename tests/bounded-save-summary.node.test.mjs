// Run: node --test tests/bounded-save-summary.node.test.mjs
// Exact-source differential tests. Browser DOM and live DB are tested separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { joinSummaryPrefix } from '../public/summary-prefix.js';
import { makeHarness, makeFixture, original, currentApp, currentServer, extractFunction, setLanguage } from './helpers/bounded-save-summary-harness.mjs';
setLanguage('en', {persist:false});
const old=makeHarness('original');
const fixed=makeHarness('current');
function deepFreeze(value) {
  if(value && typeof value==='object') {Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}
  return value;
}
function payload(h,type,data,block={metadata:{userMarker:{keep:true},toggleOpen:true,codeLanguage:'js',table:{},kanban:{},bookmark:{},database:{},aiChat:{},timetable:{},gantt:{},accordion:{},treeView:{}}}) {
  return h.buildBlockPayload({dataset:{blockType:type},data,checkbox:{checked:true}},block);
}
let seed=0xB0A7D;
function random(n) {seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;}
const alphabet=['','a','\n','\t','한국어','📝','\ud800','\udc00','<script>','&',' ',':'];
function randomText(n=50) {return Array.from({length:random(n)},()=>alphabet[random(alphabet.length)]).join('');}
for(const kind of ['table','kanban','bookmark']) {
  test(`${kind}: maximum supported fixture keeps exact whole payload and full tail metadata`,()=>{
    const data=deepFreeze(makeFixture(kind));
    assert.ok(Buffer.byteLength(JSON.stringify(data))<4_194_304);
    const expected=payload(old,kind.toUpperCase(),data);
    const actual=payload(fixed,kind.toUpperCase(),data);
    assert.deepEqual(actual,expected);
    assert.equal(actual.markdown.length,20_000);
    assert.equal(actual.checked,true);
    assert.deepEqual(actual.metadata.userMarker,{keep:true});
    const saved=actual.metadata[kind];
    if(kind==='table') {assert.equal(saved.rows.length,50);assert.equal(saved.rows[49][19],data.rows[49][19]);}
    if(kind==='kanban') {assert.equal(saved.columns.length,12);assert.deepEqual(saved.columns[11].cards[49],data.columns[11].cards[49]);}
    if(kind==='bookmark') {assert.equal(saved.items.length,500);assert.equal(saved.items[499].description,data.items[499].description);}
    assert.equal('toggleOpen' in actual.metadata,false);
    assert.equal('codeLanguage' in actual.metadata,false);
  });
  test(`${kind}: repeated different documents never reuse an earlier summary`,()=>{
    for(let i=0;i<30;i++) {
      const data=makeFixture(kind,i,true);
      assert.deepEqual(payload(fixed,kind.toUpperCase(),data),payload(old,kind.toUpperCase(),data));
    }
  });
}
test('table: 700 seeded differential cases include ragged/empty rows, nulls and UTF-16',()=>{
  for(let i=0;i<700;i++) {
    const data={rows:Array.from({length:random(55)},()=>random(9)===0?null:Array.from({length:random(24)},()=>random(8)===0?null:randomText(75))),headerRow:!!random(2),headerColumn:!!random(2)};
    const normalized=old.normalizeTableData(data);
    assert.deepEqual(fixed.normalizeTableData(data),normalized);
    assert.equal(fixed.tableSummary(data),old.tableSummary(data),`case ${i}`);
  }
});
test('table: truncation at every position around a cell, tab and newline boundary',()=>{
  for(let offset=-8;offset<=8;offset++) {
    const data={rows:[['a'.repeat(4000),'b'.repeat(4000),'c'.repeat(4000),'d'.repeat(4000),'e'.repeat(3986+offset),'📝\ud800'],['\t','\n','tail']],headerRow:true};
    assert.equal(fixed.tableSummary(data),old.tableSummary(data));
  }
});
test('table: empty cells and empty header values preserve every separator',()=>{
  for(const rows of [[['']], [['','',''],['','','']], [], [null,[],[1,true,null,undefined]], [['\ud800','\udc00']]]) {
    assert.equal(fixed.tableSummary({rows}),old.tableSummary({rows}));
  }
});
test('kanban: 400 seeded normalized boards preserve all fields and summary bytes',()=>{
  for(let i=0;i<400;i++) {
    const data={title:randomText(),columns:Array.from({length:random(14)},(_,c)=>({id:`c${c}`,title:randomText(),color:['gray','invalid','red'][random(3)],cards:Array.from({length:random(54)},(_,k)=>({id:`k${c}-${k}`,title:randomText(),description:randomText(100),icon:randomText(10),tags:Array.from({length:random(8)},()=>randomText(8)),color:'pink'}))}))};
    // Empty boards legitimately allocate random fallback IDs; compare the summary
    // and stable-field contents separately, rather than asserting random equality.
    const a=old.normalizeKanbanData(data), b=fixed.normalizeKanbanData(data);
    if(data.columns.length)assert.deepEqual(b,a);
    assert.equal(fixed.summarizeKanbanData(b),old.summarizeKanbanData(a),`case ${i}`);
  }
});
test('kanban: all supported UI languages retain untitled-card translations',()=>{
  try {
    for(const language of ['en','ko','ja','fr','de','es','pt']) {
      setLanguage(language,{persist:false});
      const board={title:'',columns:[{title:'',cards:[{title:'',icon:'',tags:[],description:'\n📝'}]}]};
      assert.equal(fixed.summarizeKanbanData(board),old.summarizeKanbanData(board));
    }
  } finally {setLanguage('en',{persist:false});}
});
test('kanban: UTF-16 boundaries, empty board titles and descriptions stay byte-identical',()=>{
  for(let n=19985;n<=20005;n++) {
    // Summary takes normalized strings; wide descriptions here directly exercise
    // boundary semantics, not a claim these lengths pass metadata admission.
    const board={title:'',columns:[{title:'x',cards:[{title:'y',icon:'',tags:[],description:'a'.repeat(n)+'📝\ud800'}]}]};
    assert.equal(fixed.summarizeKanbanData(board),old.summarizeKanbanData(board));
  }
});
test('kanban: valid 600-card board avoids all 615 discarded UUID allocations',()=>{
  const counts={};
  for(const mode of ['original','current']) {
    let count=0;
    const h=makeHarness(mode,{crypto:{randomUUID(){return `test-${++count}`;}}});
    assert.deepEqual(h.normalizeKanbanData(makeFixture('kanban')),old.normalizeKanbanData(makeFixture('kanban')));
    counts[mode]=count;
  }
  assert.deepEqual(counts,{original:615,current:0});
});
test('kanban: missing, duplicate, whitespace and truncated IDs remain unique',()=>{
  for(const mode of ['original','current']) {
    const h=makeHarness(mode);
    const data={columns:[{id:'same',cards:[{id:'same'},{id:'same'},{id:' '},{id:7},{}]},{id:'same',cards:[{id:'same'}]},{id:'x'.repeat(80),cards:[]},{id:'x'.repeat(70),cards:[]},{id:'',cards:[]}]};
    const normalized=h.normalizeKanbanData(data);
    const cols=normalized.columns.map(c=>c.id),cards=normalized.columns.flatMap(c=>c.cards.map(card=>card.id));
    assert.equal(new Set(cols).size,cols.length);assert.equal(new Set(cards).size,cards.length);
    for(const id of [...cols,...cards])assert.ok(id.length>0&&id.length<=64);
    assert.equal(cols[0],'same');assert.equal(cards[0],'same');
    assert.deepEqual(h.normalizeKanbanData(normalized),normalized);
    assert.notDeepEqual(h.normalizeKanbanData({}).columns.map(c=>c.id),h.normalizeKanbanData({}).columns.map(c=>c.id));
  }
});
test('kanban: secure UUID source and fallback implementation are unchanged',()=>{
  assert.equal(extractFunction(currentApp,'createClientId'),extractFunction(original.sections.kanban,'createClientId'));
  const h=makeHarness('current',{crypto:{}});
  assert.match(h.createClientId('card'),/^card-.+/);
  const normalized=fixed.normalizeKanbanData({columns:[{id:'__proto__',cards:[{id:'constructor'},{id:'__proto__'}]}]});
  assert.deepEqual(normalized.columns[0].cards.map(c=>c.id),['constructor','__proto__']);
  assert.equal({}.polluted,undefined);
});
test('kanban: invalid tag admission is not weakened',()=>{
  for(const tags of [['a','a'],Array.from({length:9},(_,i)=>`${i}`),['x'.repeat(41)],['valid'],null]) {
    assert.equal(fixed.validateKanbanTags(tags),old.validateKanbanTags(tags));
  }
});
test('bookmark: 350 seeded URL/field normalization and summary differential cases',()=>{
  for(let i=0;i<350;i++) {
    const data={title:randomText(),view:random(2)?'list':'gallery',maxItems:500,items:Array.from({length:random(60)},(_,k)=>({id:`i${k}`,url:random(8)?`https://example.com/${i}/${k}#fragment`:'http://127.0.0.1/private',title:randomText(),description:randomText(80),verified:!!random(2),previewToken:random(2)?'a'.repeat(43):'forged',imageUrl:'http://169.254.169.254/latest/meta-data',faviconUrl:'javascript:alert(1)',siteName:randomText()}))};
    assert.deepEqual(fixed.normalizeBookmarkData(data),old.normalizeBookmarkData(data));
    assert.equal(fixed.summarizeBookmarkData(data),old.summarizeBookmarkData(data));
    const normalized=fixed.normalizeBookmarkData(data);
    assert.equal(fixed.serverSummary(normalized),old.serverSummary(normalized));
    assert.equal(fixed.summarizeBookmarkData(data),fixed.serverSummary(normalized));
  }
});
test('bookmark: items past the prefix are still normalized and cannot bypass URL checks',()=>{
  let tailReads=0;
  const data=makeFixture('bookmark');
  data.items[498]={id:'forbidden',get url(){tailReads++;return 'http://169.254.169.254/latest/meta-data';}};
  data.items[499]={id:'tail',url:'https://example.com/tail',title:'\x00 Tail \n Title ',description:'x'.repeat(2000),verified:true,previewToken:'forged',imageUrl:'http://127.0.0.1/secret'};
  const actual=payload(fixed,'BOOKMARK',data);
  assert.equal(tailReads,1,'Payload extraction validates the tail before discarding the denied item');
  tailReads=0;
  fixed.summarizeBookmarkData(data);
  assert.equal(tailReads,1,'Direct summary callers also normalize all tail entries');
  assert.equal(actual.metadata.bookmark.items.length,499);
  const tail=actual.metadata.bookmark.items.at(-1);
  assert.equal(tail.title,'Tail Title');assert.equal(tail.description.length,1000);
  assert.equal(tail.verified,false);assert.equal(tail.imageUrl,'');assert.equal(tail.previewToken,'');
  assert.deepEqual(actual,payload(old,'BOOKMARK',data));
});
test('bookmark: server empty-item separators and surrogate cut points are exact',()=>{
  const cases=[{title:'',items:[]},{title:'',items:[{title:'',description:'',url:''},{title:'',description:'',url:''}]},{title:' ',items:[{title:'\n',description:'\n',url:''}]}];
  for(let n=19985;n<=20005;n++)cases.push({title:'h',items:[{title:'',description:'a'.repeat(n)+'📝\ud800',url:''},{title:'tail',description:'',url:''}]});
  for(const data of cases)assert.equal(fixed.serverSummary(data),old.serverSummary(data));
});
test('bookmark: denied schemes, credentials and private/local addresses stay denied',()=>{
  const urls=['javascript:alert(1)','file:///etc/passwd','data:text/html,a','https://u:p@example.com','http://localhost/','http://127.0.0.1/','http://10.0.0.1/','http://172.16.0.1/','http://192.168.1.1/','http://169.254.169.254/','http://[::1]/','http://[fc00::1]/'];
  for(const url of urls){assert.equal(fixed.normalizeBookmarkUrl(url),old.normalizeBookmarkUrl(url));assert.equal(fixed.normalizeBookmarkUrl(url),'');}
});
test('bookmark: metadata and URL security helpers are verbatim unchanged',()=>{
  for(const name of ['normalizeBookmarkData','normalizeBookmarkText','normalizeBookmarkUrl']) {
    assert.equal(extractFunction(currentApp,name),extractFunction(original.sections.bookmark,name));
  }
});
test('the shared frontend/backend prefix implementation has not diverged',()=>{
  const ts=readFileSync(new URL('../src/lib/summary-prefix.ts',import.meta.url),'utf8');
  assert.ok(ts.includes('remaining -= part.length'));
  assert.equal(joinSummaryPrefix(['','x',''],{skipEmpty:false}), '\nx\n');
  assert.equal(joinSummaryPrefix(['a'.repeat(20001)]).length,20000);
});
test('only the intended payload expression changed; all security/metadata branches are identical',()=>{
  assert.equal(extractFunction(currentApp,'buildBlockPayload'),original.functions.buildBlockPayload.replace('table.rows.map((cells) => cells.join("\\t")).join("\\n").slice(0, 20_000)','summarizeTableData(table)'));
});
test('server summary reuses the existing helper with no new package dependency',()=>{
  assert.match(currentServer,/^import \{ joinSummaryPrefix \} from "\.\/summary-prefix\.js";/);
  assert.ok(!extractFunction(currentServer,'summarizeBookmarkData').includes('.map('));
});
