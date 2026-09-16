// Audit harness: execute the attached original/current functions verbatim.
// DOM/persistence callbacks are explicit doubles; this is not API/database E2E.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { makeClock, FakeSocket } from './resource-followup-harness.mjs';
export { makeClock, FakeSocket };
export const baseline = JSON.parse(readFileSync(new URL('../fixtures/resource-utilization-baseline.json', import.meta.url), 'utf8'));
export function extractFunction(source, name) {
  const found = source.replace(/\r\n/g, '\n').match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
  if (!found) throw new Error(`Missing complete function: ${name}`);
  return found[0];
}
export function appParts(mode = 'current') {
  if (mode === 'baseline') return { ...baseline.app };
  const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
  const names = Object.keys(baseline.app);
  if (source.includes('function createBlockLookup(')) names.push('createBlockLookup');
  return Object.fromEntries(names.map(name => [name, extractFunction(source, name)]));
}
export function payloadParts(mode = 'current') {
  if(mode === 'baseline') return { ...baseline.appPayload };
  const source=readFileSync(new URL('../../public/app.js',import.meta.url),'utf8');
  return Object.fromEntries(Object.keys(baseline.appPayload).map(name=>[name,extractFunction(source,name)]));
}
export function makeAppHarness(mode = 'current', { instrument = false, normalizePayload = null, realPayload = false } = {}) {
  const parts = appParts(mode);
  if (instrument) {
    parts.getBlockById = parts.getBlockById.replace('for (const block of blocks) {', 'for (const block of blocks) { metrics.searchVisits++;');
    if (parts.createBlockLookup) parts.createBlockLookup = parts.createBlockLookup.replace('for (const block of items) {', 'for (const block of items) { metrics.indexVisits++;');
    parts.adoptCommittedCreatedBlockLocally = parts.adoptCommittedCreatedBlockLocally
      .replaceAll('orderedIds.includes(', 'countedIncludes(orderedIds, ');
    parts.applyPersistedPageDraft = parts.applyPersistedPageDraft
      .replaceAll('selected.draft.orderedIds.includes(', 'countedIncludes(selected.draft.orderedIds, ');
  }
  const payloadSource = realPayload
    ? baseline.appPayloadConstants + '\n' + Object.values(payloadParts(mode)).join('\n').replace('  const type = row.dataset.blockType', instrument ? '  metrics.payloadBuilds++;\n  const type = row.dataset.blockType' : '  const type = row.dataset.blockType')
    : 'const buildBlockPayload = row => {metrics.payloadBuilds++; if(row.failure)throw row.failure; return structuredClone(row.payload);};';
  const factory = new Function('normalizePayload', `
    const state = {selectedPage:null, workspaceView:'page'};
    const metrics = {searchVisits:0,indexVisits:0,includesComparisons:0,payloadBuilds:0};
    const events = [];
    let rows = [], records = [], reliable = true, scopeEnabled = true, failWrites = false;
    const elements = {blockList:{querySelectorAll: () => rows}};
    ${payloadSource}
    const getDraftScope = pageId => scopeEnabled && pageId ? {userId:'user_a',pageId} : null;
    const pageDraftStore = {
      inspectPageDrafts: () => ({records,reliable,unreadableKeys:reliable?[]:['unreadable']}),
      acknowledgeTitle: value => (events.push(['title',structuredClone(value)]),!failWrites),
      acknowledgeBlock: value => (events.push(['block',structuredClone(value)]),!failWrites),
      acknowledgeBlockOrder: value => (events.push(['order',structuredClone(value)]),!failWrites)
    };
    const assertBrowserRecoveryInspectionSafe = inspection => {if(!inspection.reliable)throw Error('UNRELIABLE_STORAGE');};
    const checkDraftStoreWrite = success => {if(!success)throw Error('WRITE_FAILED');};
    const getPositiveVersion = value => Number.isSafeInteger(Number(value)) && Number(value)>0 ? Number(value) : 1;
    const jsonValuesMatch = (a,b) => JSON.stringify(a)===JSON.stringify(b);
    const normalizeRecoveredBlockPayload = normalizePayload ?? ((payload) => payload?.invalid ? null : structuredClone(payload));
    const blockPayloadsMatch = (block,payload) => Object.keys(payload).every(key=>jsonValuesMatch(block[key],payload[key]));
    function countedIncludes(values,target) {
      for(const value of values){metrics.includesComparisons++;if(value===target || (value!==value && target!==target))return true;}
      return false;
    }
    ${Object.values(parts).join('\n')}
    return {state,metrics,events,elements,sync:syncVisibleBlocksToState,adopt:adoptCommittedCreatedBlockLocally,recover:applyPersistedPageDraft,
      lookupFactory:typeof createBlockLookup==='function'?createBlockLookup:null,
      setRows(value){rows=value;},setRecords(value){records=value;},setReliable(value){reliable=value;},setScope(value){scopeEnabled=value;},setFailWrites(value){failWrites=value;},
      resetMetrics(){for(const key of Object.keys(metrics))metrics[key]=0;}};
  `);
  return factory(normalizePayload);
}
export function fixture(count, {nested = false, withDrafts = false} = {}) {
  const blocks = [], flat = [];
  for (let i=0; i<count; i++) {
    const parent = nested && i%8 ? flat[i-i%8] : null;
    const siblings = parent ? parent.children : blocks;
    const block = {id:`block_${String(i).padStart(6,'0')}`,type:'MARKDOWN',markdown:`원문 ${i}`,checked:false,version:i+1,
      parentBlockId:parent?.id??null,sortOrder:siblings.length,metadata:{marker:i},children:[]};
    siblings.push(block);flat.push(block);
  }
  const page = {id:'page_a',title:'원래 제목',version:5,blocks};
  const rows = flat.map((block,i)=>{
    const row={dataset:{blockId:block.id,blockType:block.type},classList:{contains: name=>name==='is-dirty'&&i%2===0},payload:{markdown:`편집 ${i}`,checked:i%2===0,metadata:{marker:i,updated:true}}};
    row.querySelector=selector=>selector==='textarea[name="markdown"]'?{value:row.payload.markdown}:selector==='input[name="checked"]'?{checked:row.payload.checked}:null;
    return row;
  });
  const record = {sourceId:'source_a',title:null,blocks:{},blockOrder:null};
  if (withDrafts) for(const block of flat) record.blocks[block.id]={payload:{markdown:`복구 ${block.id}`},expectedVersion:block.version,revision:1,updatedAt:100};
  record.blockOrder={parentBlockId:null,mutationId:'mutation_order',orderedIds:blocks.map(b=>b.id).reverse(),previousIds:blocks.map(b=>b.id),updatedAt:100,
    items:[...blocks].reverse().map((b,i)=>({id:b.id,parentBlockId:null,sortOrder:i,expectedVersion:b.version}))};
  return {page,flat,rows,record};
}
export function makeWebSocketHarness(mode = 'current', { instrument = false, clock = makeClock() } = {}) {
  const source = mode==='baseline' ? baseline.websocket : readFileSync(new URL('../../src/lib/websocket.ts',import.meta.url),'utf8');
  const js = stripTypeScriptTypes(source).replace(/^import[^\n]*;\r?$/gm,'').replace(/^export /gm,'');
  const metrics = {copiedInputBytes:0,byteLengthCalls:0,byteLengthCodeUnits:0};
  const bufferApi = instrument ? new Proxy(Buffer,{get(target,key){
    if(key==='from')return (value,...args)=>{if(value instanceof Uint8Array)metrics.copiedInputBytes+=value.byteLength;return Buffer.from(value,...args);};
    if(key==='byteLength')return (value,...args)=>{metrics.byteLengthCalls++;if(typeof value==='string')metrics.byteLengthCodeUnits+=value.length;return Buffer.byteLength(value,...args);};
    return Reflect.get(target,key);
  }}) : Buffer;
  const factory = new Function('createHash','Buffer','TextDecoder','setTimeout','clearTimeout','Date',js+'\nreturn {WebSocketConnection,truncateCloseReason};');
  return {...factory(createHash,bufferApi,TextDecoder,clock.setTimeout,clock.clearTimeout,clock.Date),clock,metrics};
}
