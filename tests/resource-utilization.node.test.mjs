import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WebSocketConnection as NativeConnection } from '../src/lib/websocket.ts';
import { baseline, makeAppHarness, fixture, makeWebSocketHarness, FakeSocket, makeClock } from './helpers/resource-utilization-harness.mjs';
import { settle, randomGenerator } from './helpers/resource-followup-harness.mjs';

function outcomes(setup, run) {
  return ['baseline','current'].map(mode => {
    const h=makeAppHarness(mode), f=setup(h);
    let value, error;
    try { value=run(h,f); } catch(e) { error=e.message; }
    return {page:h.state.selectedPage,otherPage:f?.page,value,error,events:h.events};
  });
}
function parity(setup,run) {const result=outcomes(setup,run);assert.deepEqual(result[1],result[0]);return result[1];}
function setPage(h,f) {h.state.selectedPage=f.page;h.setRows(f.rows);return f;}

for(const nested of [false,true]) for(const dirtyOnly of [false,true]) test(`indexed DOM synchronization preserves ${nested?'nested':'flat'} trees, dirtyOnly=${dirtyOnly}`,()=>{
  const result=parity(h=>setPage(h,fixture(64,{nested})),h=>h.sync({dirtyOnly}));
  assert.equal(result.page.blocks[0].markdown,'편집 0');
});
for(const n of [1,100,1500]) test(`DOM synchronization search cost is linear for ${n} blocks`,()=>{
  for(const mode of ['baseline','current']){
    const h=makeAppHarness(mode,{instrument:true}),f=fixture(n);setPage(h,f);h.sync();
    assert.equal(h.metrics.searchVisits,mode==='baseline'?n*(n+1)/2:0);
    assert.equal(h.metrics.indexVisits,mode==='current'?n:0);
    assert.equal(h.metrics.payloadBuilds,n);
  }
});
test('all-clean dirty-only synchronization does not build an index or payloads',()=>{
  const h=makeAppHarness('current',{instrument:true}),f=fixture(200);setPage(h,f);
  h.setRows(f.rows.map(row=>({...row,classList:{contains:()=>false}})));
  h.sync({dirtyOnly:true});assert.equal(h.metrics.indexVisits,0);assert.equal(h.metrics.payloadBuilds,0);
});
test('unknown DOM rows are ignored; throwing extraction retains exact partial progress',()=>{
  parity(h=>{const f=setPage(h,fixture(6));f.rows.unshift({dataset:{blockId:'absent'},payload:{markdown:'never'}});f.rows[4].failure=Error('PAYLOAD_FAILED');return f;},h=>h.sync());
});
test('lookup retains the first depth-first duplicate and never aliases another page/account',()=>{
  const h=makeAppHarness(),first={id:'same',markdown:'first',children:[]},second={id:'same',markdown:'second',children:[]};
  const lookup=h.lookupFactory([{id:'parent',children:[first]},second]);
  assert.strictEqual(lookup('same'),first);assert.equal(lookup('missing'),null);
  assert.equal(h.lookupFactory([{id:NaN,children:[]}])(NaN),null);
  assert.equal(h.lookupFactory([{id:'__proto__',children:[]}])('__proto__').id,'__proto__');
  const other={id:'same',markdown:'different-account',children:[]};assert.strictEqual(h.lookupFactory([other])('same'),other);
  parity(h=>{h.state.selectedPage={id:'page_a',blocks:[{id:'parent',children:[{...first}]},{...second}]};h.setRows([{dataset:{blockId:'same'},payload:{markdown:'changed'}}]);},h=>h.sync());
});
test('each synchronization resolves fresh block identities after navigation or rerender',()=>{
  const h=makeAppHarness();for(let i=0;i<20;i++){const f=fixture(3);f.page.id='account_page_'+i;setPage(h,f);h.sync();assert.equal(h.state.selectedPage.blocks[2].markdown,'편집 2');}
});
for(const kind of ['valid','duplicate','foreign','length-mismatch','no-order','nested','removed-source','wrong-page','home','missing-parent']) test(`committed-create fallback parity: ${kind}`,()=>{
  parity(h=>{
    const f=setPage(h,fixture(12,{nested:kind==='nested'}));
    f.block={id:'new',type:'MARKDOWN',markdown:'new',parentBlockId:kind==='nested'?f.page.blocks[0].id:null,sortOrder:2};
    const siblings=kind==='nested'?f.page.blocks[0].children:f.page.blocks;
    f.order=[...siblings.map(b=>b.id),'new'].reverse();
    if(kind==='duplicate')f.order[0]=f.order[1];
    if(kind==='foreign')f.order[1]='absent';
    if(kind==='length-mismatch')f.order.pop();
    if(kind==='no-order')f.order=null;
    if(kind==='removed-source'){f.removed=[siblings[0].id];f.order=f.order.filter(id=>!f.removed.includes(id));}
    if(kind==='home')h.state.workspaceView='home';
    if(kind==='missing-parent')f.block.parentBlockId='absent';
    return f;
  },(h,f)=>h.adopt(kind==='wrong-page'?'other':f.page.id,f.block,{orderedIds:f.order,removedBlockIds:f.removed??[]}));
});
test('committed-create order membership no longer performs a quadratic scan',()=>{
  const n=1500;for(const mode of ['baseline','current']){const h=makeAppHarness(mode,{instrument:true}),f=fixture(n);setPage(h,f);h.adopt(f.page.id,{...f.flat[0]},{orderedIds:f.record.blockOrder.orderedIds});assert.equal(h.metrics.includesComparisons,mode==='baseline'?n+n*(n+1)/2:0);}
});
for(const kind of ['all','nested','title-only','matching','missing-block','invalid-payload','version-conflict','divergent-source','divergent-order','missing-order-item','duplicate-order','foreign-order','unreliable-storage','failed-ack','different-selected-page','no-scope']) test(`recovery retains conflict, acknowledgment and state semantics: ${kind}`,()=>{
  const result=parity(h=>{
    const f=setPage(h,fixture(20,{nested:kind==='nested',withDrafts:true})),r=f.record;
    let records=[r];
    if(kind==='title-only'){r.title={value:'복구 제목',expectedVersion:5,revision:2,updatedAt:100};r.blocks={};r.blockOrder=null;}
    if(kind==='matching')for(const b of f.flat)r.blocks[b.id].payload.markdown=b.markdown;
    if(kind==='missing-block')r.blocks.absent={payload:{markdown:'lost'},expectedVersion:1,revision:1,updatedAt:99};
    if(kind==='invalid-payload')r.blocks[f.flat[0].id].payload={invalid:true};
    if(kind==='version-conflict'){r.blocks[f.flat[0].id].expectedVersion=99;r.blockOrder.items[0].expectedVersion=99;}
    if(kind==='divergent-source'){const b=structuredClone(r);b.sourceId='source_b';b.blocks[f.flat[0].id].payload.markdown='다른 복구';b.blocks[f.flat[0].id].updatedAt=101;records.push(b);}
    if(kind==='divergent-order'){const b=structuredClone(r);b.sourceId='source_b';[b.blockOrder.orderedIds[0],b.blockOrder.orderedIds[1]]=[b.blockOrder.orderedIds[1],b.blockOrder.orderedIds[0]];records.push(b);}
    if(kind==='missing-order-item')r.blockOrder.items[0].id='absent';
    if(kind==='duplicate-order')r.blockOrder.orderedIds[0]=r.blockOrder.orderedIds[1];
    if(kind==='foreign-order')r.blockOrder.orderedIds[0]='absent';
    if(kind==='unreliable-storage')h.setReliable(false);
    if(kind==='failed-ack'){r.blocks[f.flat[0].id].payload.markdown=f.flat[0].markdown;h.setFailWrites(true);}
    if(kind==='different-selected-page')h.state.selectedPage=fixture(20).page;
    if(kind==='no-scope')h.setScope(false);
    h.setRecords(records);f.originalRecords=JSON.stringify(records);f.records=records;return f;
  },(h,f)=>{const result=h.recover(f.page);assert.equal(JSON.stringify(f.records),f.originalRecords,'stored draft inputs must not be mutated');return result;});
  if(kind==='all'){assert.equal(result.value.blocks.length,20);assert.equal(result.value.conflictCount,20);assert(result.value.blocks.every(b=>b.conflict===true));}
});
test('recovery does not build a block index for title-only drafts',()=>{
  const h=makeAppHarness('current',{instrument:true}),f=fixture(100);setPage(h,f);h.setRecords([{sourceId:'s',blocks:{},title:{value:'recovered',expectedVersion:5,revision:1,updatedAt:1}}]);h.recover(f.page);assert.equal(h.metrics.indexVisits,0);
});
test('all-draft and sibling-order recovery share a single linear tree index',()=>{
  const n=1000;for(const mode of ['baseline','current']){const h=makeAppHarness(mode,{instrument:true}),f=fixture(n,{withDrafts:true});setPage(h,f);h.setRecords([f.record]);h.recover(f.page);assert.equal(h.metrics.searchVisits,mode==='baseline'?n*(n+1):0);assert.equal(h.metrics.indexVisits,mode==='current'?n:0);assert.equal(h.metrics.includesComparisons,mode==='baseline'?n*(n+1)/2:0);}
});
test('500 seeded randomized valid/corrupt draft scenarios exactly match the original',()=>{
  const rng=randomGenerator(0xb4a02616);
  for(let run=0;run<500;run++){
    const n=2+Math.floor(rng()*70),nested=rng()<.5,f0=fixture(n,{nested,withDrafts:true});
    for(const block of f0.flat){const d=f0.record.blocks[block.id];if(rng()<.2)delete f0.record.blocks[block.id];else if(rng()<.3)d.expectedVersion+=1;else if(rng()<.3)d.payload.markdown=block.markdown;}
    if(rng()<.25)f0.record.blockOrder.items[0].expectedVersion+=1;
    if(rng()<.2)f0.record.blockOrder.orderedIds[0]='missing';
    const page=f0.page,record=f0.record;
    parity(h=>{const f={page:structuredClone(page)};h.state.selectedPage=f.page;h.setRecords([structuredClone(record)]);return f;},(h,f)=>h.recover(f.page));
  }
});

for(const length of [0,1,124,125,126,127,65535,65536,1024*1024]) test(`WebSocket ${length}-byte typed subview has identical owned wire bytes`,()=>{
  const frames=[];
  for(const mode of ['baseline','current']){
    const w=makeWebSocketHarness(mode,{instrument:true}),s=new FakeSocket();
    // Retain exactly the transport's argument, rather than hiding aliases with a fake-socket copy.
    s.write=value=>{s.writes.push(value);return true;};
    const c=new w.WebSocketConnection(s,2**21);c.start();
    const backing=new Uint8Array(length+24).fill(0xee),view=backing.subarray(11,11+length);view.fill(0x73);
    c.sendBinary(view);assert.equal(s.writes.length,1);
    const expected=Buffer.from(s.writes[0]);backing.fill(0x19);assert.deepEqual(s.writes[0],expected);
    const header=length<126?2:length<=65535?4:10;assert.equal(expected.length,header+length);assert.equal(expected[0],0x82);assert.deepEqual(expected.subarray(header),Buffer.alloc(length,0x73));
    assert.equal(w.metrics.copiedInputBytes,mode==='baseline'?length:0);frames.push(expected);c.terminate();
  }
  assert.deepEqual(frames[1],frames[0]);
});
test('native exported WebSocket class sends buffer, shared-buffer and typed views without aliases',()=>{
  for(const value of [Buffer.from('한글'),new Uint8Array([1,2,3]),new Uint8Array(new SharedArrayBuffer(10),3,4)]){
    const s=new FakeSocket();s.write=v=>{s.writes.push(v);return true;};const c=new NativeConnection(s,4096);c.start();c.sendBinary(value);const expected=Buffer.from(s.writes[0]);value.fill(0x99);assert.deepEqual(s.writes[0],expected);c.terminate();
  }
});
test('oversized output and writable backlog retain fail-closed transport limits',()=>{
  for(const mode of ['baseline','current']) for(const backlog of [false,true]){
    const w=makeWebSocketHarness(mode),s=new FakeSocket(),c=new w.WebSocketConnection(s,1024);c.start();if(backlog)s.writableLength=2048;c.sendBinary(new Uint8Array(backlog?100:4096));assert.equal(s.destroyed,true);assert.equal(s.writes.length,0);
  }
});
for(const event of ['terminate','end','close','error']) test(`closing timer is cancelled on ${event} while callback fires at most once`,async()=>{
  for(const mode of ['baseline','current']){
    const w=makeWebSocketHarness(mode),s=new FakeSocket(),c=new w.WebSocketConnection(s,4096);let closed=0;c.onClose(()=>closed++);c.start();c.close(1000,'done');assert.equal(w.clock.timers.size,1);assert.equal([...w.clock.timers.values()][0].hasRef(),false);
    if(event==='terminate')c.terminate();else s.emit(event,...(event==='error'?[Error('transport closed')]:[]));
    assert.equal(w.clock.timers.size,mode==='current'?0:1);assert.equal(closed,1);w.clock.tick(5000);await settle();assert.equal(closed,1);
  }
});
test('the two-second stalled-peer termination deadline is unchanged and idempotent',async()=>{
  for(const mode of ['baseline','current']){const w=makeWebSocketHarness(mode),s=new FakeSocket(),c=new w.WebSocketConnection(s,4096);c.start();c.close();c.close();assert.equal(w.clock.timers.size,1);w.clock.tick(1999);assert.equal(s.destroyed,false);w.clock.tick(1);assert.equal(s.destroyed,true);assert.equal(w.clock.timers.size,0);await settle();}
});
test('a transport failure during close-frame write cannot install an orphan deadline',()=>{
  const w=makeWebSocketHarness(),s=new FakeSocket(),c=new w.WebSocketConnection(s,4096);c.start();s.write=()=>{s.emit('close');return true;};c.close();assert.equal(w.clock.timers.size,0);
});
test('1000 explicit connection teardowns retain zero scheduled timeout closures',()=>{
  for(const mode of ['baseline','current']){const clock=makeClock(),w=makeWebSocketHarness(mode,{clock});for(let i=0;i<1000;i++){const s=new FakeSocket(),c=new w.WebSocketConnection(s,4096);c.start();c.close();c.terminate();}assert.equal(clock.timers.size,mode==='baseline'?1000:0);clock.tick(2000);}
});
for(const value of ['', 'a'.repeat(124), '한'.repeat(5000), '😀'.repeat(2000), '\ud800'.repeat(4000), 'a'.repeat(122)+'😀tail', 'a'.repeat(121)+'😀tail']) test(`close-reason prefix is byte-equivalent (${value.length} UTF-16 units)`,()=>{
  const a=makeWebSocketHarness('baseline').truncateCloseReason(value),w=makeWebSocketHarness('current',{instrument:true}),b=w.truncateCloseReason(value);assert.equal(a,b);assert(Buffer.byteLength(b)<=123);assert(w.metrics.byteLengthCodeUnits<=123*124/2);
});
test('500 mixed Unicode close reasons retain exact truncation and wire bytes',()=>{
  const random=randomGenerator(923),a=makeWebSocketHarness('baseline'),b=makeWebSocketHarness();const chars=['a','한','😀','\ud800','\udc00','\u0000','é'];
  for(let i=0;i<500;i++){const value=Array.from({length:Math.floor(random()*700)},()=>chars[Math.floor(random()*chars.length)]).join('');assert.equal(b.truncateCloseReason(value),a.truncateCloseReason(value));}
});
test('long close reason work is bounded independently of the discarded tail',()=>{
  const w=makeWebSocketHarness('current',{instrument:true});w.truncateCloseReason('한'.repeat(1_000_000));assert(w.metrics.byteLengthCodeUnits<=123*124/2);
});
test('immutable archive fixture records complete original production-source hashes',()=>{
  assert.match(baseline.inputArchiveSha256,/^[a-f0-9]{64}$/);
  const originalWebsocketHash=createHash('sha256').update(baseline.websocket.replace(/\n/g,'\r\n')).digest('hex');assert.equal(originalWebsocketHash,baseline.sourceSha256['src/lib/websocket.ts']);
  const source=readFileSync(new URL('../src/lib/websocket.ts',import.meta.url),'utf8');assert(source.includes('Buffer.from(value.buffer, value.byteOffset, value.byteLength)'));
});

for(const dirtyOnly of [false,true]) test(`complete production payload builder reuses resolved blocks, dirtyOnly=${dirtyOnly}`,()=>{
  const outputs=[];
  for(const mode of ['baseline','current']){
    const h=makeAppHarness(mode,{instrument:true,realPayload:true}),f=fixture(120,{nested:true});setPage(h,f);h.sync({dirtyOnly});
    assert.equal(h.metrics.searchVisits,mode==='baseline'?(dirtyOnly?7200:14520):0);
    assert.equal(h.metrics.indexVisits,mode==='current'?(dirtyOnly?119:120):0);
    outputs.push(h.state.selectedPage);
  }
  assert.deepEqual(outputs[0],outputs[1]);
});
test('complete payload builder still resolves the current page when called without a known block',()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const builder=source.match(/^function buildBlockPayload\([\s\S]*?^}/m)[0];
  let lookups=0;const first={id:'one',markdown:'attachment',metadata:{attachment:{originalName:'first.txt'}}};
  const second={id:'one',markdown:'other attachment',metadata:{attachment:{originalName:'second.txt'}}};
  let selected=first;
  const build=new Function('getBlockById','getBlockTextarea','getBlockChecked','getBlockMetadata',builder+'\nreturn buildBlockPayload;')(
    id=>{lookups++;assert.equal(id,'one');return selected;},()=>null,()=>null,block=>({...block.metadata}));
  const row={dataset:{blockId:'one',blockType:'ATTACHMENT'}};
  assert.equal(build(row).markdown,'attachment');selected=second;assert.equal(build(row).markdown,'other attachment');
  assert.equal(lookups,2);assert.equal(build(row,first).markdown,'attachment');assert.equal(lookups,2);
});

for(const position of [0,1,4999]) test(`sparse synchronization indexes only the visited prefix (position ${position})`,()=>{
  const h=makeAppHarness('current',{instrument:true,realPayload:true}),f=fixture(5000);setPage(h,f);
  h.setRows([f.rows[position]]);h.sync();assert.equal(h.metrics.indexVisits,position+1);assert.equal(h.metrics.searchVisits,0);
});
test('incremental lookup revisits no nodes after a late query or missing ID',()=>{
  const h=makeAppHarness('current',{instrument:true}),f=fixture(100,{nested:true});
  const lookup=h.lookupFactory(f.page.blocks);assert.strictEqual(lookup(f.flat[90].id),f.flat[90]);
  assert.equal(h.metrics.indexVisits,91);assert.strictEqual(lookup(f.flat[2].id),f.flat[2]);assert.equal(h.metrics.indexVisits,91);
  assert.equal(lookup('missing'),null);assert.equal(h.metrics.indexVisits,100);assert.strictEqual(lookup(f.flat[99].id),f.flat[99]);assert.equal(h.metrics.indexVisits,100);
});
