import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

export const baseline = JSON.parse(readFileSync(new URL('../fixtures/sort-sanitizer-resource-baseline.json', import.meta.url), 'utf8'));
export const rootUrl = new URL('../../', import.meta.url);

export function sourceFor(path, mode = 'current') {
  if (mode !== 'baseline') return readFileSync(new URL(path, rootUrl), 'utf8');
  const record = baseline.files[path];
  if (!record || createHash('sha256').update(record.source).digest('hex') !== record.sha256) {
    throw new Error(`Invalid uploaded-source fixture: ${path}`);
  }
  return record.source;
}

// Execute the complete production module. TypeScript syntax alone is erased;
// browser dependencies remain the project's real native ES modules. Counters
// are injected only for deterministic work-count tests, never timing samples.
export async function loadDatabase(mode = 'current', side = 'client', { instrument = false } = {}) {
  const path = side === 'server' ? 'src/lib/database.ts' : 'public/database-block.js';
  let source = sourceFor(path, mode).replace(/\r\n/g, '\n');
  if (side === 'server') source = stripTypeScriptTypes(source);
  if (instrument) {
    source = source
      .replace(/function searchableValue\(property\s*,\s*value\s*\)\s*\{/, 'function searchableValue(property, value) { auditMetrics.searchableCalls++; auditMetrics.searchableByType[property.type] = (auditMetrics.searchableByType[property.type] || 0) + 1;')
      .replace('return property.options.find((option) => option.id === optionId)', 'return property.options.find((option) => (auditMetrics.optionIdReads++, option.id === optionId))')
      .replace(/new Map\s*\(/g, 'new AuditMap(');
    source = `export const auditMetrics = {searchableCalls:0,searchableByType:Object.create(null),optionIdReads:0,mapAllocations:0,mapSetCalls:0,largestMap:0};
class AuditMap extends Map {
  constructor(...args) { super(...args); auditMetrics.mapAllocations++; }
  set(key, value) { const result = super.set(key, value); auditMetrics.mapSetCalls++; auditMetrics.largestMap = Math.max(auditMetrics.largestMap, this.size); return result; }
}
` + source;
  }
  source = source.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
    (_, start, relative, end) => start + new URL(relative, new URL(path, rootUrl)).href + end);
  // Distinct imports keep counters independent across test cases.
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(source + '\n// ' + nextModuleId++).toString('base64')}`);
  if (instrument) resetMetrics(loaded.auditMetrics); // Exclude module initialization.
  return loaded;
}
let nextModuleId = 0;

export function resetMetrics(metrics) {
  for (const key of Object.keys(metrics)) metrics[key] = key === 'searchableByType' ? Object.create(null) : 0;
}

export function databaseFixture({ rows = 200, options = 30, selections = 10, type = 'multi_select' } = {}) {
  const labels = Array.from({ length: options }, (_, i) => ({ id: `o${i}`, name: `Label ${i} 한글 Ä`, color: 'blue' }));
  const properties = [{ id: 'title', name: 'Title', type: 'title', options: [] }, { id: 'value', name: 'Value', type, options: labels }];
  const view = { id: 'view', name: 'Table', type: 'table', filters: [], sorts: [{ id: 'sort', propertyId: 'value', direction: 'ascending' }], hiddenPropertyIds: [], groupPropertyId: null };
  return { title: 'Resource regression', properties,
    rows: Array.from({ length: rows }, (_, i) => ({ id: `r${i}`, values: { title: `Row ${i}`, value:
      type === 'multi_select' ? Array.from({ length: selections }, (_, j) => `o${(i * 17 + j * 7) % options}`)
        : type === 'select' ? `o${(i * 17) % options}`
        : type === 'number' ? (i * 17) % rows
        : type === 'checkbox' ? i % 2 === 0 : `Text ${(i * 17) % rows}` } })),
    views: [view], activeViewId: view.id };
}

export function randomGenerator(seed = 0x916bca) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
