import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { baseline, sourceFor, loadApp, loadTimetable, countTimetableWork, pagesFixture, timetableFixture, formatTime, randomGenerator, freeze } from './helpers/chronological-sort-resource-harness.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const sameRows = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((row, i) => assert.equal(row, expected[i], `row identity/order ${i}`));
};
for (const [path, record] of Object.entries(baseline.files)) test(`chronological-sort uploaded baseline checksum: ${path}`, () => {
  assert.equal(sha(record.source), record.sourceSha256);
});
for (const operation of ['sortByRecent', 'sortByNavigationOrder']) {
  test(`${operation}: 5000 pages parse each compared page once, not every comparison`, () => {
    const before = loadApp('baseline', { instrument: true }), after = loadApp('current', { instrument: true });
    const pages = freeze(pagesFixture());
    sameRows(after[operation](pages), before[operation](pages));
    // Sort comparison counts are engine-specific; exact observed counts live in
    // the benchmark report rather than becoming a cross-version assertion.
    assert.ok(before.metrics.dates > pages.length * 2, 'baseline must reproduce redundant parsing');
    assert.equal(after.metrics.dates, 5000);
    assert.equal(after.metrics.maps, 1);
    assert.equal(after.metrics.mapEntries, 5000);
  });
  test(`${operation}: empty/single-item inputs do not parse dates or allocate caches`, () => {
    const api = loadApp('current', { instrument: true });
    const item = { id: 'alone', get updatedAt() { throw Error('unneeded timestamp access'); } };
    assert.deepEqual(api[operation]([]), []);
    sameRows(api[operation]([item]), [item]);
    assert.deepEqual(api.metrics, { dates: 0, maps: 0, mapEntries: 0 });
  });
  test(`${operation}: duplicate IDs, repeated objects, invalid dates and timezone offsets preserve exact ordering`, () => {
    const a = loadApp('baseline'), b = loadApp();
    const pages = ['2026-09-17T10:00:00+09:00', '2026-09-17T01:00:00Z', 'invalid', null, 0, 1,
      '2026-02-30', undefined, '', '1900-01-01', '9999-12-31'].map((updatedAt, i) => ({ id: ['same', '__proto__', 'constructor'][i % 3], updatedAt }));
    pages.push(pages[0], pages[0]);
    for (const sequence of [pages, [...pages].reverse(), new Set(pages)]) {
      const original = [...sequence];
      sameRows(b[operation](sequence), a[operation](sequence));
      sameRows([...sequence], original);
    }
  });
  test(`${operation}: 1000 seeded cases preserve timestamp ties, rank rules and immutable inputs`, () => {
    const random = randomGenerator(), before = loadApp('baseline'), after = loadApp();
    const invalid = [undefined, null, '', 'invalid', '2026-02-30', 0];
    const ranks = [-1, 0, 1, 2, 7, 1.5, NaN, Infinity, '0', null, undefined];
    for (let run = 0; run < 1000; run++) {
      const pages = Array.from({ length: Math.floor(random() * 150) }, (_, i) => ({
        id: `id-${i % 70}`,
        updatedAt: random() < .15 ? invalid[Math.floor(random() * invalid.length)]
          : new Date(Date.UTC(2026, 0, 1) + Math.floor(random() * 12) * 1000).toISOString()
      }));
      const rankEntries = pages.filter(() => random() < .6).map(p => [p.id, ranks[Math.floor(random() * ranks.length)]]);
      before.state.navigationPageOrder = new Map(rankEntries); after.state.navigationPageOrder = new Map(rankEntries);
      freeze(pages); sameRows(after[operation](pages), before[operation](pages));
    }
  });
  test(`${operation}: in-place edits and account/page replacements never reuse previous timestamps`, () => {
    const before = loadApp('baseline'), after = loadApp(), pages = pagesFixture(120);
    for (let run = 0; run < 120; run++) {
      pages[run].updatedAt = new Date(Date.UTC(2030, 0, 1) + run * 1000).toISOString();
      after.state.navigationPageOrder.set(pages[run].id, run % 7);
      before.state.navigationPageOrder.set(pages[run].id, run % 7);
      sameRows(after[operation](pages), before[operation](pages));
      const otherAccount = pages.map(p => ({ ...p, updatedAt: '2020-01-01' }));
      sameRows(after[operation](otherAccount), before[operation](otherAccount));
    }
  });
}
test('navigation: unique explicit ranks never allocate a timestamp cache or inspect dates', () => {
  const api = loadApp('current', { instrument: true });
  const pages = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, get updatedAt() { throw Error('rank decided already'); } }));
  pages.forEach((p, i) => api.state.navigationPageOrder.set(p.id, pages.length - i));
  sameRows(api.sortByNavigationOrder(pages), [...pages].reverse());
  assert.deepEqual(api.metrics, { dates: 0, maps: 0, mapEntries: 0 });
});
test('navigation: direct incremental comparator remains equivalent, including NaN and locale ID tie-breaks', () => {
  const a = loadApp('baseline'), b = loadApp();
  const pages = pagesFixture(50).map((p, i) => ({ ...p, id: ['a', 'A', '가', 'ä', '__proto__'][i % 5], updatedAt: i % 3 ? '2026-09-17' : 'invalid' }));
  for (const left of pages) for (const right of pages) assert.ok(Object.is(a.compareNavigationOrder(left, right), b.compareNavigationOrder(left, right)));
});
test('home recent selection algorithm is unchanged', () => {
  const range = source => source.slice(source.indexOf('function takeMostRecent('), source.indexOf('function compareNavigationOrder('));
  assert.equal(range(sourceFor('public/app.js')), range(sourceFor('public/app.js', 'baseline')));
});

for (const side of ['client', 'server']) {
  const wrap = value => side === 'server' ? { timetable: value } : value;
  test(`${side} timetable: normalization still validates 400 endpoints; sorting creates no regex matches or wrappers`, () => {
    const a = loadTimetable('baseline', side), b = loadTimetable('current', side), data = freeze(timetableFixture());
    const before = countTimetableWork(() => a.normalize(wrap(data)));
    const after = countTimetableWork(() => b.normalize(wrap(data)));
    assert.deepEqual(after.value, before.value);
    assert.ok(before.timeRegexMatches > data.entries.length * 2, 'baseline sort must reparse validated endpoints');
    assert.equal(after.timeRegexMatches, 400);
    assert.equal(before.sortWrapperObjects, side === 'server' ? 200 : 0);
    assert.equal(after.sortWrapperObjects, 0);
  });
  test(`${side} timetable: every minute of the day preserves sorted endpoints and stable equal keys`, () => {
    const a = loadTimetable('baseline', side), b = loadTimetable('current', side);
    for (let start = 0; start < 1440; start++) {
      const input = timetableFixture(6, true);
      input.entries[0].start = formatTime(start); input.entries[0].end = formatTime(Math.min(start + 1, 1439));
      input.entries[1].start = input.entries[0].start; input.entries[1].end = input.entries[0].end;
      a.resetIds(); b.resetIds(); assert.deepEqual(b.normalize(wrap(input)), a.normalize(wrap(input)));
    }
  });
  test(`${side} timetable: 1000 malformed/oversize seeded inputs preserve normalization, truncation and escaping`, () => {
    const random = randomGenerator(), a = loadTimetable('baseline', side), b = loadTimetable('current', side);
    const times = [undefined, null, 0, {}, [], '9:00', '09:00', '24:00', '23:59', '00:00', '99:99', '09:00<script>', ' 09:00', '09:00:00'];
    for (let run = 0; run < 1000; run++) {
      const pick = () => times[Math.floor(random() * times.length)];
      const value = { title: '<img src=x onerror=alert(1)>'.repeat(run % 10), date: run % 2 ? '2026-02-30' : '2026-09-17', interval: pick(),
        entries: Array.from({ length: Math.floor(random() * 225) }, (_, i) => random() < .1 ? pick() : ({
          id: i % 3 ? 'duplicate' : ['__proto__', 'constructor', 'x'.repeat(100)][i % 3],
          start: pick(), end: pick(), title: '한글 <script>unsafe</script>'.repeat(i % 10), note: '😀'.repeat(i % 260), completed: i % 2 ? true : 'true'
        })) };
      freeze(value); a.resetIds(); b.resetIds();
      assert.deepEqual(b.normalize(wrap(value)), a.normalize(wrap(value)), `input ${run}`);
      if (side === 'server') assert.equal(b.render(wrap(value)), a.render(wrap(value)));
      else { a.resetIds(); b.resetIds(); assert.equal(b.summarize(value), a.summarize(value)); }
    }
  });
  test(`${side} timetable: empty/missing collections and rejected container types retain their existing behavior`, () => {
    const a = loadTimetable('baseline', side), b = loadTimetable('current', side);
    for (const input of [undefined, null, false, 7, '', [], {}, { entries: [] }, { entries: null }, { entries: 'not an array' }]) {
      a.resetIds(); b.resetIds(); assert.deepEqual(b.normalize(wrap(input)), a.normalize(wrap(input)));
    }
  });
  test(`${side} timetable: internal sort preserves row identities, stable ties and array mutation contract`, () => {
    const a = loadTimetable('baseline', side), b = loadTimetable('current', side);
    const entries = timetableFixture(200, true).entries;
    const before = [...entries], after = [...entries], result = b.sortEntries(after);
    sameRows(result, a.sortEntries(before)); sameRows(result, entries);
    assert.equal(result === after, side === 'client');
    if (side === 'server') sameRows(after, entries);
  });
  test(`${side} timetable: normalization, read-only/edit handlers and HTML escaping are byte-unchanged outside sorting`, () => {
    const path = side === 'client' ? 'public/timetable-block.js' : 'src/lib/timetable.ts';
    const removeSort = source => {
      const start = source.indexOf('function sortEntries('), end = source.indexOf('export function createDefaultTimetableData(', start);
      return source.slice(0, start) + source.slice(end);
    };
    assert.equal(removeSort(sourceFor(path)), removeSort(sourceFor(path, 'baseline')));
  });
}
