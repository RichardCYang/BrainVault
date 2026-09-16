// Test-only: exact uploaded sources, real production functions, no npm dependencies.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
export { manifest, regenerated, randomGenerator, freeze } from './render-history-resource-harness.mjs';

const root = new URL('../../', import.meta.url);
export const baseline = JSON.parse(readFileSync(new URL('../fixtures/resource-hotpaths-baseline.json', import.meta.url), 'utf8'));
export function sourceFor(path, mode = 'current') {
  const record = baseline.files[path];
  if (!record || createHash('sha256').update(record.source).digest('hex') !== record.sha256) {
    throw new Error(`Invalid original-source fixture: ${path}`);
  }
  return mode === 'baseline' ? record.source : readFileSync(new URL(path, root), 'utf8');
}
export async function loadDatabase(side = 'client', mode = 'current') {
  const path = side === 'client' ? 'public/database-block.js' : 'src/lib/database.ts';
  let source = sourceFor(path, mode);
  if (side === 'server') source = stripTypeScriptTypes(source);
  source = source.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
    (_, prefix, relative, suffix) => prefix + new URL(relative, new URL(path, root)).href + suffix);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
export function makeDiff(mode = 'current', { instrument = false } = {}) {
  const metrics = { hashCalls: 0, hashInputBytes: 0 };
  const source = stripTypeScriptTypes(sourceFor('src/lib/workspace-snapshot-diff.ts', mode))
    .replace(/^import[^\n]*;\r?$/gm, '').replace(/^export /gm, '');
  const hash = (...args) => {
    const result = createHash(...args);
    if (instrument) {
      metrics.hashCalls++;
      const update = result.update;
      result.update = function (value, encoding) {
        metrics.hashInputBytes += typeof value === 'string' ? Buffer.byteLength(value, encoding) : value.byteLength;
        return update.call(this, value, encoding);
      };
    }
    return result;
  };
  return { diff: new Function('createHash', source + '\nreturn diffWorkspaceManifests;')(hash), metrics };
}
export function countLowercase(run) {
  const original = String.prototype.toLocaleLowerCase;
  const metrics = { lowercaseCalls: 0, lowercaseInputCodeUnits: 0 };
  String.prototype.toLocaleLowerCase = function (...args) {
    metrics.lowercaseCalls++;
    metrics.lowercaseInputCodeUnits += String(this).length;
    return Reflect.apply(original, this, args);
  };
  try { return { value: run(), ...metrics }; }
  finally { String.prototype.toLocaleLowerCase = original; }
}
export function filterFixture(rows = 200, filters = 8) {
  const needle = 'AB가😀'.repeat(100);
  const properties = [{ id: 'title', name: 'Title', type: 'title', options: [] },
    ...Array.from({ length: filters }, (_, i) => ({ id: `text_${i}`, name: `Text ${i}`, type: 'text', options: [] }))];
  const view = { id: 'view', name: 'Filtered', type: 'table', filters: properties.slice(1).map(p =>
    ({ id: `filter_${p.id}`, propertyId: p.id, operator: 'contains', value: needle })), sorts: [], groupPropertyId: null, hiddenPropertyIds: [] };
  return { title: 'Filter regression', properties, rows: Array.from({ length: rows }, (_, i) => ({ id: `row_${i}`,
    values: Object.fromEntries(properties.map(p => [p.id, p.type === 'title' ? `Row ${i}` : `prefix ${needle.toLowerCase()} suffix ${i}`])) })),
    views: [view], activeViewId: view.id };
}
