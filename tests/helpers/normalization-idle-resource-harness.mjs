import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

export const root = new URL('../../', import.meta.url);
export const baseline = JSON.parse(readFileSync(new URL('../fixtures/normalization-idle-resource-baseline.json', import.meta.url), 'utf8'));
let moduleId = 0;

export function sourceFor(path, mode = 'current') {
  if (mode === 'current') return readFileSync(new URL(path, root), 'utf8');
  const record = baseline.files[path];
  if (!record || createHash('sha256').update(record.source).digest('hex') !== record.sha256) {
    throw new Error(`Invalid original-source fixture: ${path}`);
  }
  return record.source;
}

export function menuSource(mode = 'current') {
  const app = mode === 'current' ? readFileSync(new URL('public/app.js', root), 'utf8') : '';
  return Object.entries(baseline.menuFunctions).map(([name, record]) => {
    if (createHash('sha256').update(record.source).digest('hex') !== record.sha256) throw new Error(`Invalid menu fixture: ${name}`);
    if (mode !== 'current') return record.source;
    const match = new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(app);
    if (!match) throw new Error(`Missing menu function: ${name}`);
    return match[0];
  }).join('\n');
}

export async function loadDatabase(side = 'client', mode = 'current', { instrument = false } = {}) {
  const path = side === 'client' ? 'public/database-block.js' : 'src/lib/database.ts';
  let source = sourceFor(path, mode).replace(/\r\n/g, '\n');
  if (side === 'server') source = stripTypeScriptTypes(source);
  if (instrument) {
    source = source
      .replace(/\.some\(\(option\) => option\.id === (optionId|id|remapped)\)/g,
        '.some((option) => (auditMetrics.optionComparisons++, option.id === $1))')
      .replaceAll('resolveIdReference(candidate, propertyAliases)', '(auditMetrics.propertyAliasChecks++, resolveIdReference(candidate, propertyAliases))')
      .replaceAll('const candidates = [descriptor.sourceId, descriptor.requestedId, descriptor.property.id];',
        'auditMetrics.candidateBatches++; const candidates = [descriptor.sourceId, descriptor.requestedId, descriptor.property.id];')
      .replaceAll('validOptionIds.has(', '(auditMetrics.optionMembershipChecks++, validOptionIds).has(')
      .replace(/new Set\s*(?:<[^>]*>)?\s*\(/g, 'new AuditSet(');
    source = `export const auditMetrics = {optionComparisons:0,propertyAliasChecks:0,candidateBatches:0,optionMembershipChecks:0,setAllocations:0};
class AuditSet extends Set { constructor(...args) { super(...args); auditMetrics.setAllocations++; } }
` + source;
  }
  source = source.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
    (_, before, relative, after) => before + new URL(relative, new URL(path, root)).href + after);
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(source + '\n// resource-module-' + moduleId++).toString('base64')}`);
  if (instrument) resetMetrics(loaded.auditMetrics);
  return {
    module: loaded,
    normalize: side === 'client' ? loaded.normalizeDatabaseData : value => loaded.getDatabaseData({ database: value }),
    metrics: loaded.auditMetrics
  };
}

export function resetMetrics(metrics) {
  for (const key of Object.keys(metrics)) metrics[key] = 0;
}

export function databaseFixture({ rows = 200, properties = 20, options = 30, type = 'multi_select' } = {}) {
  const schema = Array.from({ length: properties }, (_, index) => ({
    id: index === 0 ? 'title' : 'p' + index,
    name: index === 0 ? '이름 / Name' : `Property ${index}`,
    type: index === 0 ? 'title' : type,
    options: index === 0 || !['select', 'multi_select'].includes(type) ? [] : Array.from({ length: options }, (_, j) => ({ id: 'o' + j, name: `항목 ${j} 😀`, color: 'blue' }))
  }));
  return {
    title: '정규화 회귀 / Resource audit', properties: schema,
    rows: Array.from({ length: rows }, (_, i) => ({ id: 'r' + i, values: Object.fromEntries(schema.map(property => [property.id,
      property.type === 'title' ? `Row ${i}` : property.type === 'multi_select' ? property.options.map(option => option.id)
        : property.type === 'select' ? property.options.at(-1)?.id ?? '' : property.type === 'number' ? i
          : property.type === 'checkbox' ? i % 2 === 0 : `text ${i}`])) })),
    views: [{ id: 'table', name: 'Table', type: 'table', filters: [], sorts: [], groupPropertyId: null, hiddenPropertyIds: [] }], activeViewId: 'table'
  };
}

export function randomGenerator(seed = 0x917dab) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
