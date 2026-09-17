// Test-only loaders for byte-exact uploaded/current source. No production imports,
// algorithms, storage, authentication state, or .git files are rewritten.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { formatDateTime, formatNumber, t } from '../../public/i18n.js';
import { joinSummaryPrefix } from '../../public/summary-prefix.js';

export const baseline = JSON.parse(readFileSync(new URL('../fixtures/chronological-sort-resource-baseline.json', import.meta.url), 'utf8'));
export const sourceFor = (path, mode = 'current') => {
  if (mode === 'baseline') return baseline.files[path].source;
  let source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  if (path === 'public/app.js') {
    const { startMarker, endMarker } = baseline.files[path];
    const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
    if (start < 0 || end <= start) throw new Error('Chronological-sort source boundary changed');
    source = source.slice(start, end);
  }
  return source;
};

export function loadApp(mode = 'current', { instrument = false } = {}) {
  const metrics = { dates: 0, maps: 0, mapEntries: 0 };
  class CountedDate extends Date {
    constructor(...args) { super(...args); metrics.dates++; }
  }
  class CountedMap extends Map {
    constructor(...args) { super(...args); metrics.maps++; }
    set(key, value) { metrics.mapEntries++; return super.set(key, value); }
  }
  const state = { navigationPageOrder: new Map() };
  const api = new Function('Date', 'Map', 'state', sourceFor('public/app.js', mode) + '\nreturn {sortByRecent, sortByNavigationOrder, compareNavigationOrder, takeMostRecent};')(
    instrument ? CountedDate : Date, instrument ? CountedMap : Map, state);
  return { ...api, state, metrics, reset() { for (const key of Object.keys(metrics)) metrics[key] = 0; } };
}

export function loadTimetable(mode = 'current', side = 'client') {
  const path = side === 'client' ? 'public/timetable-block.js' : 'src/lib/timetable.ts';
  let source = sourceFor(path, mode);
  if (side === 'server') source = stripTypeScriptTypes(source);
  source = source.replace(/^import[^\n]*;\r?$/gm, '').replace(/^export /gm, '');
  let ids = 0;
  const fakeGlobal = { crypto: { randomUUID: () => `sort-fixture-${++ids}` } };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-09-17T12:00:00.000Z'])); }
    static now() { return Date.parse('2026-09-17T12:00:00.000Z'); }
  }
  const exports = side === 'client'
    ? 'normalize: normalizeTimetableData, summarize: summarizeTimetableData, create: createDefaultTimetableData'
    : 'normalize: getTimetableData, render: renderTimetableHtml, create: createDefaultTimetableData';
  const api = new Function('t', 'formatNumber', 'formatDateTime', 'joinSummaryPrefix', 'globalThis', 'Date', source + `\nreturn {${exports}, sortEntries, parseTime};`)(
    t, formatNumber, formatDateTime, joinSummaryPrefix, fakeGlobal, FixedDate);
  return { ...api, resetIds() { ids = 0; } };
}

export function countTimetableWork(run) {
  const originalExec = RegExp.prototype.exec, originalMap = Array.prototype.map;
  const metrics = { timeRegexMatches: 0, sortWrapperObjects: 0 };
  RegExp.prototype.exec = function (...args) {
    if (this.source === '^([01]\\d|2[0-3]):([0-5]\\d)$') metrics.timeRegexMatches++;
    return Reflect.apply(originalExec, this, args);
  };
  Array.prototype.map = function (callback, thisArg) {
    const result = Reflect.apply(originalMap, this, [callback, thisArg]);
    for (let i = 0; i < result.length; i++) {
      const value = result[i];
      if (value && typeof value === 'object' && value.entry === this[i] && value.index === i) metrics.sortWrapperObjects++;
    }
    return result;
  };
  try { return { value: run(), ...metrics }; }
  finally { RegExp.prototype.exec = originalExec; Array.prototype.map = originalMap; }
}

export function pagesFixture(count = 5000) {
  return Array.from({ length: count }, (_, i) => ({
    id: `page-${i}`, title: `문서 ${i} <&> 😀`,
    updatedAt: new Date(Date.UTC(2026, 0, 1) + ((i * 7919) % 50001) * 1000).toISOString()
  }));
}
export function formatTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
export function timetableFixture(count = 200, tied = false) {
  return { title: '시간표 <&> 😀', date: '2026-09-17', interval: 1,
    entries: Array.from({ length: count }, (_, i) => {
      const start = tied ? 540 : (i * 127) % 1400;
      return { id: `entry-${i}`, start: formatTime(start), end: formatTime(start + 30),
        title: `작업 ${i} <script>not executable</script>`, note: `메모 ${i} 😀`, completed: i % 3 === 0 };
    }) };
}
export function randomGenerator(seed = 0x9172026) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
