// No application dependencies or database. The fixture is the exact uploaded
// source; only TypeScript erasure / private-export exposure happens in tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

export const root = new URL('../../', import.meta.url);
export const baseline = JSON.parse(readFileSync(new URL('../fixtures/database-option-render-baseline.json', import.meta.url), 'utf8'));
export const paths = { client: 'public/database-block.js', server: 'src/lib/database.ts' };
let serial = 0;
export function sourceFor(side, mode = 'current') {
  const path = paths[side], record = baseline.files[path];
  assert.equal(createHash('sha256').update(record.source).digest('hex'), record.sha256);
  return mode === 'baseline' ? record.source : readFileSync(new URL(path, root), 'utf8');
}
export function executableSource(side, mode = 'current', instrument = false) {
  let source = sourceFor(side, mode).replace(/\r\n/g, '\n');
  if (side === 'server') source = stripTypeScriptTypes(source);
  source += side === 'client' ? '\nexport { applyDatabaseSearch };' : '';
  if (instrument) {
    source = source.replaceAll('.find((option) => option.id === optionId)',
      '.find((option) => (++auditMetrics.optionComparisons, option.id === optionId))');
    source = source.replaceAll('const id = option.id;', 'auditMetrics.optionIndexVisits++; const id = option.id;');
    // Only count string encoding, not normalization/view work or retained bytes.
    if (side === 'server') source = source.replace(/function escapeHtml\(value\s*\)\s*\{/,
      'function escapeHtml(value) { auditMetrics.escapeCalls++;');
    source = source.replace(/new Map\s*\(/g, 'new AuditMap(');
    source = `export const auditMetrics = {optionComparisons:0,optionIndexVisits:0,escapeCalls:0,mapAllocations:0};
class AuditMap extends Map { constructor(...args) { super(...args); auditMetrics.mapAllocations++; } }\n` + source;
  }
  return source;
}
export async function loadModule(side, mode = 'current', { instrument = false } = {}) {
  let source = executableSource(side, mode, instrument);
  source = source.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
    (_, a, relative, b) => a + new URL(relative, new URL(paths[side], root)).href + b);
  return import('data:text/javascript;base64,' + Buffer.from(source + '\n// audit-module-' + serial++).toString('base64'));
}
export function resetMetrics(module) { for (const key of Object.keys(module.auditMetrics)) module.auditMetrics[key] = 0; }
export function fixture({ rows = 200, properties = 20, options = 30, type = 'multi_select', view = 'table', label = '항목' } = {}) {
  const schema = Array.from({ length: properties }, (_, i) => ({
    id: i ? 'p' + i : 'title', name: i ? 'Property ' + i : 'Name', type: i ? type : 'title',
    options: i && ['select', 'multi_select'].includes(type) ? Array.from({ length: options }, (_, j) => ({id:'o' + j,name:`${label} ${j} 😀 <&>`,color:'blue'})) : []
  }));
  return {title:'선택 옵션 회귀검증',properties:schema,
    rows:Array.from({length:rows},(_,i)=>({id:'r'+i,values:Object.fromEntries(schema.map(p=>[p.id,
      p.type==='title'?'Row '+i:p.type==='multi_select'?p.options.map(o=>o.id):p.type==='select'?p.options.at(-1)?.id??'':p.type==='number'?i:p.type==='checkbox'?i%2===0:p.type==='date'?'2026-09-17':p.type==='url'?'https://example.org/?a=1&b=2':'Text '+i]))})),
    views:[{id:'v',name:'View',type:view,filters:[],sorts:[],groupPropertyId:type==='select'?'p1':null,hiddenPropertyIds:[]}],activeViewId:'v'};
}
export function seededRandom(seed = 0x20260917) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
