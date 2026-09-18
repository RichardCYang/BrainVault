import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { baseline, sourceFor, makeKeyboard, makeTree, treeFixture, makeSearch, searchFixture } from './helpers/search-tree-resource-harness.mjs';

for (const [path, entry] of Object.entries(baseline.files)) test(`retained original source checksum: ${path}`, () => {
  assert.equal(createHash('sha256').update(entry.source).digest('hex'),entry.sha256);
});
const passiveKeys = ['a','한','Process','Unidentified','Dead','Backspace','Delete','Enter',' ','Shift','Control','Alt','Meta','CapsLock','ArrowLeft','ArrowRight','PageUp','PageDown','F5'];
for (const count of [0,1,30,50]) test(`search key semantics match the original with ${count} results`, () => {
  const configs = [{count}, {count, disabled:[0,2], hidden:[1,3]}, {count,open:false}, {count,noFocusables:true}];
  for (const config of configs) for (const key of [...passiveKeys,'ArrowDown','ArrowUp','Home','End','Tab','Escape']) {
    for (const focus of ['input','close','dialog',...(count?['buttons']:[])]) for (const shiftKey of [false,true]) {
      const results = ['baseline','current'].map(mode => {
        const h = makeKeyboard(mode,config);
        (focus === 'buttons' ? h.buttons.at(-1) : h[focus]).focus();
        return h.key(key,{shiftKey,isComposing:key==='Process'});
      });
      assert.deepEqual(results[1],results[0],JSON.stringify({config,key,focus,shiftKey}));
    }
  }
});
test('ordinary/IME/modifier input performs no result scan or geometry lookup',()=>{
  for(const mode of ['baseline','current']) {
    const h=makeKeyboard(mode);
    for(let i=0;i<1000;i++)h.key(passiveKeys[i%passiveKeys.length]);
    assert.equal(h.metrics.queries,mode==='baseline'?1000:0);
    assert.equal(h.metrics.rectReads,mode==='baseline'?30000:0);
  }
});
test('Tab preserves the focus trap without redundantly scanning search results',()=>{
  const before=makeKeyboard('baseline'),after=makeKeyboard();
  before.buttons.at(-1).focus();after.buttons.at(-1).focus();
  assert.deepEqual(after.key('Tab'),before.key('Tab'));
  assert.equal(after.metrics.queries,0);assert.equal(after.metrics.focusableQueries,1);
  assert.equal(before.metrics.rectReads-after.metrics.rectReads,30);
});
test('navigation uses fresh DOM visibility/disabled state and wraps in both directions',()=>{
  const traces=['baseline','current'].map(mode=>{
    const h=makeKeyboard(mode,{count:5}),trace=[];
    for(const key of ['ArrowDown','End','ArrowDown','ArrowUp','Home'])trace.push(h.key(key));
    h.buttons[1].disabled=true;h.buttons[2].hidden=true;
    trace.push(h.key('ArrowDown'));assert.equal(trace.at(-1).focused,'result-3');
    h.buttons[1].disabled=false;h.buttons[2].hidden=false;
    trace.push(h.key('ArrowUp'));assert.equal(trace.at(-1).focused,'result-2');
    return trace;
  });
  assert.deepEqual(traces[1],traces[0]);
});
test('Escape and a closed search dialog never query geometry',()=>{
  const h=makeKeyboard();assert.equal(h.key('Escape').stopped,true);
  for(const key of ['Tab','ArrowDown',...passiveKeys])h.key(key);
  assert.deepEqual(h.metrics,{queries:0,rectReads:0,focusableQueries:0});
});

const oldTree=makeTree('baseline'),newTree=makeTree();
for (const count of [0,1,10,300]) for (const config of [{},{reverse:true},{flat:true},{oneNote:true},{notes:false},{reverse:true,long:true}]) {
  test(`tree HTML, normalized data and summary retain exact output: ${count} / ${JSON.stringify(config)}`,()=>{
    const input=treeFixture(count,config),copy=JSON.stringify(input);
    assert.equal(newTree.render({treeView:input}),oldTree.render({treeView:input}));
    assert.equal(newTree.summarize(input),oldTree.summarize(input));
    assert.deepEqual(newTree.normalize(input),oldTree.normalize(input));
    assert.equal(JSON.stringify(input),copy);
  });
}
test('all 1,296 four-node parent graphs preserve input-order cycle repair and escaped output',()=>{
  const choices=[null,'n0','n1','n2','n3','missing'];
  for(let code=0;code<6**4;code++) {
    let value=code;
    const nodes=Array.from({length:4},(_,i)=>{
      const parentId=choices[value%6];value=Math.floor(value/6);
      return {id:`n${i}`,parentId,title:i%2?'':'<svg onload=alert(1)>',note:'<script>unsafe</script>\n한글 😀',expanded:false};
    });
    const input={title:'<&\'">',nodes};
    assert.equal(newTree.render({treeView:input}),oldTree.render({treeView:input}),`graph ${code}`);
  }
});
test('400 seeded malformed/duplicate/special-ID metadata cases preserve normalization and output',()=>{
  let seed=0x9182026;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  const ids=['__proto__','constructor','toString','n0','n1','n2','',null,99,'x'.repeat(80)];
  for(let run=0;run<400;run++) {
    const nodes=Array.from({length:1+Math.floor(random()*35)},(_,i)=>{
      if(random()<.1)return i%2?null:[];
      return {id:ids[Math.floor(random()*ids.length)],parentId:ids[Math.floor(random()*ids.length)],title:random()<.3?null:ids[Math.floor(random()*ids.length)],note:random()<.3?' \n ':`memo ${i} <img src=x onerror=alert(1)>`,expanded:random()<.5};
    });
    const data={title:run%3?'title':null,nodes};
    for(const input of [{treeView:data},JSON.stringify({treeView:data})])assert.equal(newTree.render(input),oldTree.render(input),`seeded ${run}`);
  }
});
test('invalid metadata, size limits and HTML escaping remain unchanged',()=>{
  for(const input of [null,undefined,1,[],{},'{',JSON.stringify({treeView:null}),{treeView:treeFixture(350,{long:true})}]) {
    const html=newTree.render(input);assert.equal(html,oldTree.render(input));
    assert.doesNotMatch(html,/<script>|<img |<svg /);
  }
});
test('tree path cache is request-local: edits, reparenting and account switches never reuse stale paths',()=>{
  for(let i=0;i<100;i++) {
    const data=treeFixture(30,{reverse:i%2===0});
    data.nodes.forEach(node=>{node.title=`Account ${i} ${node.id}`;if(i%3===0)node.parentId=null;});
    assert.equal(newTree.render({treeView:data}),oldTree.render({treeView:data}));
  }
});
test('defensive private path guard retains cycle/missing-parent behavior and never caches cyclic prefixes',()=>{
  const nodes=[{id:'a',parentId:'b',title:'A'},{id:'b',parentId:'a',title:'B'},{id:'c',parentId:'missing',title:''}];
  const byId=new Map(nodes.map(node=>[node.id,node])),cache=new Map();
  for(const node of nodes)assert.equal(newTree.path(byId,node,cache),oldTree.path(byId,node));
  assert.equal(cache.has('a'),false);assert.equal(cache.has('b'),false);
});
for(const reverse of [false,true])test(`300-level all-memo tree no longer revisits all ancestor paths; reverse=${reverse}`,()=>{
  const before=makeTree('baseline',true),after=makeTree('current',true),metadata={treeView:treeFixture(300,{reverse})};
  assert.equal(after.render(metadata),before.render(metadata));
  assert.ok(before.metrics.mapGets>45000);
  assert.ok(after.metrics.mapGets<=2100,JSON.stringify(after.metrics));
  assert.ok(after.metrics.setAdds<before.metrics.setAdds/20);
});

test('search query validation, authentication registration and response serialization are byte-identical',()=>{
  const before=sourceFor('src/routes/search.routes.ts','baseline'),after=sourceFor('src/routes/search.routes.ts');
  assert.equal(after.slice(0,after.indexOf('function snippet(')),before.slice(0,before.indexOf('function snippet(')));
  assert.equal(after.slice(after.indexOf('    res.setHeader')),before.slice(before.indexOf('    res.setHeader')));
});
for(const q of ['needle','한글','%','_','!','%_!','x\' OR 1=1 --','\\','😀'])test(`search preserves literal escaping, query predicates, transaction and output: ${JSON.stringify(q)}`,async()=>{
  const data=searchFixture(5,100),before=makeSearch('baseline',data),after=makeSearch('current',data);
  const a=await before.run({q,limit:5}),b=await after.run({q,limit:5});
  assert.deepEqual(b.response,a.response);assert.deepEqual(b.headers,a.headers);
  assert.equal(b.transactions,1);assert.equal(after.calls.length,2);
  for(let i=0;i<2;i++) {
    const original=before.calls[i],current=after.calls[i];
    assert.equal(current.sql.slice(current.sql.indexOf('FROM')),original.sql.slice(original.sql.indexOf('FROM')));
    assert.deepEqual(current.params,original.params);
    assert.equal(current.params.filter(p=>p==='user-owner').length,4);
  }
});
for(const limit of [1,20,30,50])test(`search page/block ordering, null icons, snippets and global result cap: ${limit}`,async()=>{
  const data=searchFixture(50,5);
  data.blocks[0].markdown='begin '+'x '.repeat(200)+'needle '+ '한글 '.repeat(200);
  const before=await makeSearch('baseline',data).run({limit}),after=await makeSearch('current',data).run({limit});
  assert.deepEqual(after.response,before.response);assert.equal(after.response.results.length,limit);
  assert.equal(after.response.results[0].kind,'block');
  assert.equal(after.headers['Cache-Control'],'private, no-store');
});
for(const failAt of [1,2])test(`database failure ${failAt} never produces a partial search response`,async()=>{
  for(const mode of ['baseline','current']) {
    const h=makeSearch(mode,{...searchFixture(2,0),failAt}),result=await h.run();
    assert.equal(result.nextError,'Database fixture failure');assert.equal(result.response,undefined);
    assert.equal(h.calls.length,failAt);assert.deepEqual(result.headers,{});
  }
});
test('missing authenticated identity cannot reach search database queries',async()=>{
  for(const mode of ['baseline','current']) {
    const h=makeSearch(mode),result=await h.run({user:null});
    assert.equal(result.transactions,0);assert.equal(h.calls.length,0);assert.equal(result.response,undefined);
  }
});
test('large unused search columns are absent from selected rows without response changes',async()=>{
  const data=searchFixture(30),a=await makeSearch('baseline',data).run({limit:30}),b=await makeSearch('current',data).run({limit:30});
  assert.deepEqual(b.response,a.response);
  assert.ok(a.selectedBytes>15*1024*1024);assert.ok(b.selectedBytes<10000);
  const sql=sourceFor('src/routes/search.routes.ts');
  assert.doesNotMatch(sql,/SELECT [pb]\.\*/);
});
