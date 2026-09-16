import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { diffWorkspaceManifests } from '../src/lib/workspace-snapshot-diff.ts';
import { databaseFixture } from './helpers/resource-cost-harness.mjs';
import { baseline, sourceFor, loadDatabase, makeDiff, countLowercase, filterFixture,
  manifest, regenerated, randomGenerator, freeze } from './helpers/resource-hotpaths-harness.mjs';

for (const [path, record] of Object.entries(baseline.files)) test(`hot-path original fixture SHA-256: ${path}`, () => {
  assert.equal(createHash('sha256').update(record.source).digest('hex'), record.sha256);
});

for (const side of ['client', 'server']) {
  const before = await loadDatabase(side, 'baseline'), after = await loadDatabase(side);
  test(`${side}: 200 rows × 8 text filters normalize filter text 8 times instead of 1600`, () => {
    const data = freeze(filterFixture());
    const a = countLowercase(() => before.applyDatabaseView(data));
    const b = countLowercase(() => after.applyDatabaseView(data));
    assert.deepEqual(b.value, a.value);
    assert.equal(a.lowercaseCalls, 3200);
    assert.equal(b.lowercaseCalls, 1608);
    assert.equal(a.lowercaseInputCodeUnits - b.lowercaseInputCodeUnits, 1592 * data.views[0].filters[0].value.length);
    for (let i = 0; i < b.value.length; i++) assert.equal(b.value[i], data.rows[i]);
    assert.notEqual(b.value, data.rows);
  });
  test(`${side}: no text normalization for empty rows, missing properties, typed filters, or short-circuited filters`, () => {
    for (const propertyId of ['number', 'select', 'multi_select', 'checkbox', 'missing']) {
      const data = databaseFixture();
      data.views[0].sorts = [];
      data.views[0].filters = [{ propertyId, operator: propertyId === 'checkbox' ? 'checked' : 'equals', value: 1 }];
      const actual = countLowercase(() => after.applyDatabaseView(data));
      assert.equal(actual.lowercaseCalls, 0, propertyId);
      assert.deepEqual(actual.value, before.applyDatabaseView(data));
    }
    const data = filterFixture();
    data.rows = [];
    assert.equal(countLowercase(() => after.applyDatabaseView(data)).lowercaseCalls, 0);
    const gated = filterFixture();
    gated.views[0].filters.unshift({ propertyId: 'title', operator: 'is_empty', value: '' });
    assert.equal(countLowercase(() => after.applyDatabaseView(gated)).lowercaseCalls, 0);
  });
  test(`${side}: in-place filter, row, option and sort edits never reuse stale cached results`, () => {
    const data = databaseFixture();
    data.views[0].filters = [{ propertyId: 'title', operator: 'contains', value: 'item' }];
    for (const text of ['item', '', 'a', '東京', '😀', null, true, 19, 'İ', 'does-not-exist']) {
      data.views[0].filters[0].value = text;
      data.rows[0].values.title = String(text ?? '');
      data.properties.find(p => p.id === 'select').options[0].name = String(text);
      data.views[0].sorts[0].direction = text ? 'descending' : 'ascending';
      assert.deepEqual(after.applyDatabaseView(data), before.applyDatabaseView(data));
    }
    assert.deepEqual(after.applyDatabaseView(databaseFixture()), before.applyDatabaseView(databaseFixture()));
  });
  test(`${side}: 1500 seeded mixed filter/sort scenarios retain exact row identities and input bytes`, () => {
    const random = randomGenerator(0xb41626);
    const ids = ['title', 'text', 'number', 'select', 'multi_select', 'checkbox', 'date', 'url', 'missing'];
    const operators = ['contains', 'equals', 'is_empty', 'is_not_empty', 'checked', 'unchecked'];
    const values = ['', 'a', 'İ', 'i', 'ı', '가', '😀', '\ud800', 'e\u0301', null, true, false, 0, '0', -1, 'o1', 'constructor'];
    for (let n = 0; n < 1500; n++) {
      const data = databaseFixture(n % 83, n + 1), view = data.views[0];
      view.filters = Array.from({ length: n % 9 }, (_, i) => ({ id: 'f' + i,
        propertyId: ids[Math.floor(random() * ids.length)], operator: operators[Math.floor(random() * operators.length)],
        value: values[Math.floor(random() * values.length)] }));
      view.sorts = Array.from({ length: n % 5 }, () => ({ propertyId: ids[Math.floor(random() * ids.length)], direction: random() < .5 ? 'ascending' : 'descending' }));
      if (n % 7 === 0) view.filters.push(...view.filters.slice(0, 1));
      const bytes = JSON.stringify(data);
      freeze(data);
      const expected = before.applyDatabaseView(data), actual = after.applyDatabaseView(data);
      assert.deepEqual(actual, expected, `scenario ${n}`);
      actual.forEach((row, i) => assert.equal(row, expected[i]));
      assert.equal(JSON.stringify(data), bytes);
    }
  });
  test(`${side}: empty filter text is cached and locale changes are observed on each invocation`, () => {
    const data = filterFixture(200, 1);
    data.views[0].filters[0].value = '';
    assert.equal(countLowercase(() => after.applyDatabaseView(data)).lowercaseCalls, 201);
    const lower = String.prototype.toLocaleLowerCase;
    try {
      for (const locale of ['en-US', 'tr', 'de', 'ko-KR', 'ja-JP']) {
        String.prototype.toLocaleLowerCase = function () { return lower.call(this, locale); };
        data.views[0].filters[0].value = 'I';
        data.rows[0].values.text_0 = 'İstanbul I ı i';
        assert.deepEqual(after.applyDatabaseView(data), before.applyDatabaseView(data));
      }
    } finally { String.prototype.toLocaleLowerCase = lower; }
  });
  test(`${side}: prototype-like identifiers and literal HTML remain data, not cache-object properties or executable code`, () => {
    const data = filterFixture(4, 1);
    data.properties[1].id = '__proto__';
    data.views[0].filters[0].propertyId = '__proto__';
    data.views[0].filters[0].value = '<script>';
    for (const row of data.rows) row.values = JSON.parse('{"title":"row","__proto__":"<script>alert(1)</script>"}');
    assert.deepEqual(after.applyDatabaseView(data), before.applyDatabaseView(data));
    assert.equal({}.polluted, undefined);
  });
}

function changedFixture(blocks = 2000, pages = 1) {
  const a = manifest({ pages, blocksPerPage: blocks, htmlLength: 16000 });
  for (const block of a.data.blocks) block.type = 'MARKDOWN';
  const b = regenerated(a);
  for (const block of b.data.blocks) block.markdown = 'changed ' + block.id;
  return [a, b];
}

test('2000 changed blocks retain 500 complete details while reducing SHA-256 calls from 8000 to 2000', () => {
  const [a, b] = changedFixture();
  const original = makeDiff('baseline', { instrument: true }), current = makeDiff('current', { instrument: true });
  const expected = original.diff(a, b), actual = current.diff(a, b);
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.equal(original.metrics.hashCalls, 8000);
  assert.equal(current.metrics.hashCalls, 2000);
  assert.equal(actual.summary.blocks.modified, 2000);
  assert.equal(actual.pages[0].blocks.length, 500);
  assert.equal(actual.detailsTruncated, true);
  assert.deepEqual(diffWorkspaceManifests(a, b), actual);
});

for (const count of [0, 1, 499, 500, 501, 700]) test(`detail cap boundary ${count}: exact serialized output, summaries, hashes, and truncation flags`, () => {
  const [a, b] = changedFixture(count);
  const original = makeDiff('baseline'), current = makeDiff();
  assert.equal(JSON.stringify(current.diff(freeze(a), freeze(b))), JSON.stringify(original.diff(a, b)));
});

test('after the detail cap, every semantic field is still counted and operational-only restores are not', () => {
  const mutations = [
    block => { block.type = 'CODE'; }, block => { block.parent_block_id = 'parent'; },
    block => { block.markdown = 'new'; }, block => { block.checked = 1; },
    block => { block.sort_order = 19; }, block => { block.metadata = '{"x":1}'; },
    block => { block.created_at = '2026-09-15'; }, block => { block.updated_at = '2026-09-17'; },
    (_block, backup) => { backup.attachments.push({ blockId: backup.data.blocks.at(-1).id, path: 'safe/data', size: 9, crc32: 1, sha256: 'f'.repeat(64) }); },
    block => { block.html_cache = 'regenerated only'; block.edit_version = 900; }
  ];
  for (const mutate of mutations) {
    const [a, b] = changedFixture(501);
    b.data.blocks[500] = structuredClone(a.data.blocks[500]);
    mutate(b.data.blocks[500], b);
    assert.deepEqual(makeDiff().diff(a, b), makeDiff('baseline').diff(a, b));
  }
});

test('truncated text comparison preserves null/empty equivalence, Unicode, lone surrogates, and JSON-number semantics', () => {
  const [a, b] = changedFixture(510);
  const values = [null, '', '한글😀', '\ud800', '<script>', '{"a":1}', ' ', undefined, '\u0000', 'tail'];
  values.forEach((value, i) => {
    a.data.blocks[500 + i].metadata = value;
    b.data.blocks[500 + i].metadata = i < 2 ? '' : value;
    b.data.blocks[500 + i].markdown = a.data.blocks[500 + i].markdown;
  });
  a.data.blocks[508].sort_order = NaN;
  b.data.blocks[508].sort_order = Infinity;
  assert.deepEqual(makeDiff().diff(a, b), makeDiff('baseline').diff(a, b));
});

test('added/removed blocks, cross-page IDs, archived pages and the 200-page cap retain exact aggregate and admission behavior', () => {
  const a = manifest({ pages: 205, blocksPerPage: 3, htmlLength: 100 });
  const b = regenerated(a);
  b.data.blocks.forEach((block, i) => { if (i % 3) block.markdown += ' modified'; });
  b.data.blocks.splice(0, 13);
  b.data.blocks.push({ ...b.data.blocks[0], id: 'added_a' }, { ...b.data.blocks.at(-1), id: 'added_z' });
  b.data.blocks[30].page_id = b.data.pages[2].id;
  b.data.pages.forEach((page, i) => { page.title += ' changed'; if (i % 4 === 0) page.is_archived = 1; });
  b.data.pages.splice(12, 1);
  b.data.pages.push({ ...b.data.pages.at(-1), id: 'added_page' });
  assert.deepEqual(makeDiff().diff(freeze(a), freeze(b)), makeDiff('baseline').diff(a, b));
});

test('100 seeded above-cap differential cases preserve account/workspace metadata and all disclosed fields', () => {
  const random = randomGenerator(0x991426);
  const original = makeDiff('baseline'), current = makeDiff();
  for (let run = 0; run < 100; run++) {
    const a = manifest({ blocksPerPage: 520, htmlLength: 64 }), b = regenerated(a);
    b.data.blocks.forEach((block, i) => {
      if (i < 500 || random() < .7) block.markdown += ` changed ${run}`;
      if (random() < .1) block.metadata = JSON.stringify({ n: run, x: '<&>😀' });
      if (random() < .05) block.sort_order = String(run * 1024);
      if (random() < .03) block.parent_block_id = 'parent_' + run;
    });
    if (run % 3 === 0) b.data.blocks.pop();
    if (run % 4 === 0) b.data.blocks.push({ ...b.data.blocks[0], id: 'new_' + run });
    if (run % 5 === 0) b.account.name = 'another account label';
    assert.equal(JSON.stringify(current.diff(a, b)), JSON.stringify(original.diff(a, b)), `seeded diff ${run}`);
  }
});

test('no long-lived memoization or validation/integrity bypass was introduced', () => {
  const source = sourceFor('src/lib/workspace-snapshot-diff.ts');
  assert.match(source, /totalBlockDetails >= maxBlockDetails/);
  assert.match(source, /blockHasSemanticDifference/);
  for (const path of ['public/database-block.js', 'src/lib/database.ts']) {
    const text = sourceFor(path);
    const start = text.indexOf('export function applyDatabaseView(');
    assert.ok(text.indexOf('let filterTextByFilter', start) > start);
    assert.equal((text.match(/let filterTextByFilter/g) ?? []).length, 1);
  }
});
