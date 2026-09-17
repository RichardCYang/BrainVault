import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baseline, rootUrl, hash, makeAiModule, makeSignature, proseFixture, wrapperFixture,
  blockFixture, fromSpec, referenceSpec, snapshot, randomGenerator } from './helpers/citation-span-resource-harness.mjs';

const old = await makeAiModule('baseline');
const current = await makeAiModule('current');
const oldSignature = makeSignature('baseline').signature;
const newSignature = makeSignature('current').signature;
function compare(spec, operations = ['group', 'wrapper']) {
  const a = fromSpec(spec), b = fromSpec(spec);
  for (const operation of operations) { old[operation](a); current[operation](b); }
  assert.deepEqual(snapshot(b), snapshot(a));
  return b;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

test('citation-span audit retains the exact attached-original source checksum', () => {
  assert.equal(hash(baseline.files['public/ai-chat-block.js'].source), baseline.files['public/ai-chat-block.js'].sha256);
  assert.match(baseline.inputArchiveSha256, /^[a-f0-9]{64}$/);
});
test('44k prose with two citations uses bounded group tokens, with identical merged output', async () => {
  const a = await makeAiModule('baseline', {instrument:true});
  const b = await makeAiModule('current', {instrument:true});
  a.auditMetrics.groupUnits = b.auditMetrics.groupUnits = 0;
  const x=proseFixture(), y=proseFixture(); a.group(x); b.group(y);
  assert.deepEqual(snapshot(y),snapshot(x));
  assert.ok(a.auditMetrics.groupUnits >= 44000);
  assert.ok(b.auditMetrics.groupUnits <= 16, JSON.stringify(b.auditMetrics));
});
test('removing parentheses from a long text node no longer splits the entire prose into characters', async () => {
  const a=await makeAiModule('baseline',{instrument:true}), b=await makeAiModule('current',{instrument:true});
  a.auditMetrics.splitCodeUnits=b.auditMetrics.splitCodeUnits=0;
  const x=wrapperFixture(), y=wrapperFixture();a.wrapper(x);b.wrapper(y);
  assert.deepEqual(snapshot(y),snapshot(x));
  assert.ok(a.auditMetrics.splitCodeUnits >= 44000);
  assert.equal(b.auditMetrics.splitCodeUnits,0);
});
for (const tag of ['p','li']) for (const prefix of ['', '한글 😀\ud800 text ', ' \t', 'x'.repeat(44000), '[[', '\u00a0\u2003']) {
  test(`citation groups preserve wrappers, prose and UTF-16 offsets (${tag}, ${prefix.length})`, () => {
    compare({tag,children:[prefix+' (([',referenceSpec(1),{tag:'strong',children:[', ',referenceSpec(2)]},'])) .']});
    compare({tag,children:[prefix+' [',referenceSpec(1),'] middle [',referenceSpec(2),',',referenceSpec(3),']']});
  });
}
test('non-citation links, script URLs, source definitions and excluded element boundaries remain unchanged', () => {
  const variants=[{href:'javascript:alert(1)'},{href:'data:text/html,unsafe'},{href:'https://safe.invalid','data-ai-chat-source-definition':'true'},
    {href:'https://safe.invalid',class:'rendered-ai-chat-citation-reference'}];
  for (const attrs of variants) for (const barrier of ['code','pre','button','img','div','span','em','sup']) {
    compare({tag:'p',children:['body [',referenceSpec(1,attrs),{tag:barrier,children:[',']},referenceSpec(2),']']});
  }
});
test('group compression changes neither original DOM node identities nor untouched prose', () => {
  const p=proseFixture(), body=p.childNodes[0], first=p.children[0];
  current.group(p);
  assert.equal(p.childNodes[0],body);assert.equal(p.children[0],first);
  assert.equal(first.aiChatCitationSources.length,2);
  assert.ok(body.nodeValue.startsWith('한글 abc 😀 '));
});
test('5000 deterministic mixed DOM/wrapper/group traces match the original exactly', () => {
  const random=randomGenerator(0xa12573), choose=xs=>xs[Math.floor(random()*xs.length)];
  const strings=['',' ', '\t\n',',',':',';', '，；：、','[]','((', '))', '{ ', ' }', '. next ', '한글😀', '\ud800', '\udfff', '\ufffc', 'x [ y ] z', '\u00a0', '\u200b'];
  const tags=['span','em','strong','s','del','sup','code','button','br'];
  function part(depth=0) {
    const roll=random();
    if (roll<.52) return choose(strings).repeat(1+Math.floor(random()*5));
    if (roll<.85) return referenceSpec(1+Math.floor(random()*5),random()<.12?{'data-ai-chat-source-definition':'true'}:random()<.15?{href:'javascript:alert(1)'}:{});
    return depth>2?choose(strings):{tag:choose(tags),children:Array.from({length:1+Math.floor(random()*4)},()=>part(depth+1))};
  }
  for(let i=0;i<5000;i++) {
    const spec={tag:choose(['p','li']),children:Array.from({length:2+Math.floor(random()*16)},()=>part())};
    compare(spec, i%3===0?['group']:i%3===1?['wrapper']:['group','wrapper','group','wrapper']);
  }
});
test('5000 offset-set edits preserve split/filter/join semantics including surrogate halves and invalid offsets', () => {
  const random=randomGenerator(0xca181), chars=['a','b','😀','한','\ud800','\udfff','\u0000','\r\n','(',')'];
  for(let i=0;i<5000;i++) {
    const value=Array.from({length:Math.floor(random()*80)},()=>chars[Math.floor(random()*chars.length)]).join('');
    const offsets=new Set(Array.from({length:Math.floor(random()*30)},()=>Math.floor(random()*(value.length+10))-3));
    offsets.add(NaN);offsets.add('1');offsets.add(1.5);offsets.add(Infinity);
    const expected=value.split('').filter((_,index)=>!offsets.has(index)).join('');
    assert.equal(current.removeOffsets(value,offsets),expected);
  }
});
test('5000-block collaboration signatures avoid the discarded flatten copies without changing wire-comparison bytes', () => {
  const a=makeSignature('baseline',{instrument:true}),b=makeSignature('current',{instrument:true});
  const blocks=freeze(blockFixture());
  assert.equal(b.signature(blocks),a.signature(blocks));
  assert.equal(a.metrics.clones,5000);assert.equal(b.metrics.clones,0);
});
test('collaboration signature defaults, depth-first order, Unicode and special IDs remain exact', () => {
  const cases=[undefined,null,[],[{}],blockFixture(160,{nested:true}),[
    {id:'__proto__',type:'MARKDOWN',markdown:null,checked:0,parentBlockId:'constructor',sortOrder:'3',metadata:JSON.parse('{"__proto__":{"safe":true}}'),children:[]},
    {id:'constructor',type:'TODO',markdown:'\ud800😀',checked:'yes',sortOrder:'NaN',children:[]}
  ]];
  for(const blocks of cases) assert.equal(newSignature(freeze(blocks)),oldSignature(blocks));
  assert.equal({}.safe,undefined);
});
test('1000 seeded signature comparisons retain current metadata and never reuse state across pages', () => {
  const random=randomGenerator(0xffac);
  for(let i=0;i<1000;i++) {
    const blocks=blockFixture(Math.floor(random()*100),{nested:random()<.5});
    assert.equal(newSignature(blocks),oldSignature(blocks));
    if(blocks.length) {blocks[0].markdown='changed '+i;blocks[0].metadata={changing:i};}
    assert.equal(newSignature(blocks),oldSignature(blocks));
  }
});
test('security rendering module, dependency policy and collaboration local-signature bypass are not replaced', () => {
  const source=readFileSync(new URL('public/ai-chat-block.js',rootUrl),'utf8');
  assert.ok(source.includes('import { renderServerBlockHtml } from "./rendered-html-sanitizer.js";'));
  const app=readFileSync(new URL('public/app.js',rootUrl),'utf8');
  assert.match(app,/previousBlockSignature = source === "local"\s*\? null/);
  assert.match(app,/nextBlockSignature = source === "local"\s*\? null/);
});
