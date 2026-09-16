import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { baseline, sourceFor, loadDatabase, resetMetrics, databaseFixture, randomGenerator, freeze } from './helpers/sort-sanitizer-resource-harness.mjs';

for (const [path, record] of Object.entries(baseline.files)) test(`uploaded baseline is byte-verified: ${path}`, () => {
  assert.equal(createHash('sha256').update(record.source).digest('hex'), record.sha256);
});

for (const side of ['client', 'server']) {
  test(`${side}: 200-row/30-option multi-select sorting derives each cell key at most once`, async () => {
    const before = await loadDatabase('baseline', side, { instrument: true });
    const after = await loadDatabase('current', side, { instrument: true });
    const input = freeze(databaseFixture());
    const expected = before.applyDatabaseView(input);
    const actual = after.applyDatabaseView(input);
    assert.deepEqual(actual, expected);
    for (const row of actual) assert.equal(row, input.rows.find(item => item.id === row.id));
    assert.ok(before.auditMetrics.searchableCalls > 2000, JSON.stringify(before.auditMetrics));
    assert.equal(after.auditMetrics.searchableCalls, 200);
    assert.ok(after.auditMetrics.optionIdReads < before.auditMetrics.optionIdReads / 10);
    assert.equal(after.auditMetrics.mapAllocations, 3, 'one property index and two lazy sort-key maps');
    assert.ok(after.auditMetrics.mapSetCalls <= 203);
  });

  test(`${side}: repeated single-select IDs resolve only once each, not once per comparison`, async () => {
    const before = await loadDatabase('baseline', side, { instrument: true });
    const after = await loadDatabase('current', side, { instrument: true });
    const input = freeze(databaseFixture({ type: 'select' }));
    assert.deepEqual(after.applyDatabaseView(input), before.applyDatabaseView(input));
    assert.equal(after.auditMetrics.searchableCalls, 30);
    assert.ok(before.auditMetrics.searchableCalls > 2000);
  });

  test(`${side}: ordinary text/number/checkbox and empty-only sorts allocate no option-key cache`, async () => {
    const before = await loadDatabase('baseline', side, { instrument: true });
    const after = await loadDatabase('current', side, { instrument: true });
    for (const type of ['title', 'text', 'number', 'checkbox', 'date', 'url', 'select', 'multi_select']) {
      const input = databaseFixture({ type });
      if (type === 'select' || type === 'multi_select') input.rows.forEach(row => { row.values.value = type === 'select' ? null : []; });
      resetMetrics(before.auditMetrics); resetMetrics(after.auditMetrics);
      assert.deepEqual(after.applyDatabaseView(freeze(input)), before.applyDatabaseView(input));
      assert.equal(after.auditMetrics.mapAllocations, before.auditMetrics.mapAllocations, type);
      assert.equal(after.auditMetrics.searchableCalls, before.auditMetrics.searchableCalls, type);
    }
  });

  test(`${side}: missing sorts, unsorted views and filtered-out rows do not eagerly derive keys`, async () => {
    const after = await loadDatabase('current', side, { instrument: true });
    for (const variant of ['unsorted', 'unknown-sort', 'filtered', 'empty']) {
      const data = databaseFixture();
      if (variant === 'unsorted') data.views[0].sorts = [];
      if (variant === 'unknown-sort') data.views[0].sorts[0].propertyId = 'missing';
      if (variant === 'filtered') data.views[0].filters = [{ propertyId: 'value', operator: 'equals', value: 'missing' }];
      if (variant === 'empty') data.rows = [];
      resetMetrics(after.auditMetrics); after.applyDatabaseView(freeze(data));
      assert.equal(after.auditMetrics.searchableCalls, 0, variant);
      assert.equal(after.auditMetrics.mapAllocations, 1, variant);
    }
  });

  test(`${side}: lazy secondary sort is not evaluated when the first key decides`, async () => {
    const data = databaseFixture();
    data.views[0].sorts.unshift({ propertyId: 'title', direction: 'ascending' });
    const before = await loadDatabase('baseline', side, { instrument: true });
    const after = await loadDatabase('current', side, { instrument: true });
    assert.deepEqual(after.applyDatabaseView(freeze(data)), before.applyDatabaseView(data));
    assert.equal(after.auditMetrics.searchableByType.multi_select, undefined);
    assert.equal(after.auditMetrics.mapAllocations, 1);
  });

  test(`${side}: property identity, array identity and unusual IDs do not collide`, async () => {
    const before = await loadDatabase('baseline', side);
    const after = await loadDatabase('current', side);
    const data = databaseFixture({ rows: 50 });
    data.properties[1].options[0].name = '';
    data.properties[1].options.unshift({ id: 'duplicate', name: 'FIRST', color: 'red' }, { id: 'duplicate', name: 'SECOND', color: 'blue' });
    const ids = ['__proto__', 'constructor', 'prototype', '\u0000', 'a,b', 'a', 'b', 'duplicate', 'missing'];
    const second = { ...data.properties[1], id: 'other', options: ids.map((id, i) => ({ id, name: `other ${i}`, color: 'blue' })) };
    data.properties.push(second); data.views[0].sorts.push({ propertyId: 'other', direction: 'descending' });
    data.rows.forEach((row, i) => {
      const shared = [ids[i % ids.length], ids[(i + 3) % ids.length]];
      row.values.value = shared; row.values.other = shared;
    });
    assert.deepEqual(after.applyDatabaseView(freeze(data)), before.applyDatabaseView(data));
    assert.equal({}.polluted, undefined);
  });

  test(`${side}: edits, option renames and view/page replacements never reuse stale keys`, async () => {
    const before = await loadDatabase('baseline', side);
    const after = await loadDatabase('current', side);
    const data = databaseFixture();
    for (let run = 0; run < 60; run++) {
      data.properties[1].options[run % 30].name = `${run % 2 ? 'ZZZ' : 'AAA'} edited ${run}`;
      data.rows[run % 200].values.value.reverse();
      data.rows[(run + 1) % 200].values.value.push(`o${run % 30}`);
      data.views[0].sorts[0].direction = run % 2 ? 'ascending' : 'descending';
      assert.deepEqual(after.applyDatabaseView(data), before.applyDatabaseView(data));
      assert.deepEqual(after.applyDatabaseView(databaseFixture()), before.applyDatabaseView(databaseFixture()));
    }
  });

  test(`${side}: 1200 seeded cases preserve filtering, stable multi-key sorting and malformed-value semantics`, async () => {
    const before = await loadDatabase('baseline', side);
    const after = await loadDatabase('current', side);
    const random = randomGenerator();
    const types = ['title', 'text', 'number', 'select', 'multi_select', 'checkbox', 'date', 'url'];
    const words = ['', '가나다', '한글 12', 'İ', 'ı', 'Ä', 'a2', 'a12', '😀', 'e\u0301', 'é', '<script>evil()</script>', '__proto__'];
    for (let run = 0; run < 1200; run++) {
      const data = databaseFixture({ rows: Math.floor(random() * 90) });
      data.properties = types.map(type => ({ id: type, type, name: type, options: Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, name: words[(run + i) % words.length], color: 'blue' })) }));
      for (const row of data.rows) row.values = Object.fromEntries(types.map(type => {
        const roll = random();
        const value = roll < .12 ? null : roll < .18 ? undefined
          : type === 'number' ? [0, -0, -9, 10, NaN, Infinity, 'not-a-number'][Math.floor(random() * 7)]
          : type === 'checkbox' ? random() < .5
          : type === 'select' ? `o${Math.floor(random() * 10)}`
          : type === 'multi_select' ? Array.from({ length: Math.floor(random() * 5) }, () => `o${Math.floor(random() * 10)}`)
          : words[Math.floor(random() * words.length)];
        return [type, value];
      }));
      data.views[0].sorts = Array.from({ length: Math.floor(random() * 9) }, () => ({ propertyId: [...types, 'unknown'][Math.floor(random() * 9)], direction: random() < .5 ? 'ascending' : 'descending' }));
      if (run % 3 === 0) data.views[0].filters = [{ propertyId: types[run % types.length], operator: ['contains','equals','is_empty','is_not_empty','checked','unchecked'][run % 6], value: words[run % words.length] }];
      freeze(data);
      assert.deepEqual(after.applyDatabaseView(data), before.applyDatabaseView(data), `case ${run}`);
      assert.equal({}.polluted, undefined);
    }
  });

  test(`${side}: full normalized table/list/board representations retain exact row order and serialized values`, async () => {
    const before = await loadDatabase('baseline', side);
    const after = await loadDatabase('current', side);
    const normalize = mod => side === 'server' ? value => mod.getDatabaseData({ database: value }) : mod.normalizeDatabaseData;
    for (const type of ['table', 'list', 'board']) {
      const input = databaseFixture(); input.views[0].type = type;
      const oldData = normalize(before)(input), newData = normalize(after)(input);
      assert.deepEqual(newData, oldData);
      assert.deepEqual(after.applyDatabaseView(newData), before.applyDatabaseView(oldData));
      if (side === 'server') assert.equal(after.renderDatabaseHtml({ database: input }), before.renderDatabaseHtml({ database: input }));
    }
  });
}

test('sort key caches remain invocation-local; no persistent cache or security/source mutation is added', () => {
  for (const path of ['public/database-block.js', 'src/lib/database.ts']) {
    const source = sourceFor(path).replace(/\r\n/g, '\n');
    const start = source.indexOf('export function applyDatabaseView(');
    const end = source.indexOf('\n}', start);
    assert.match(source.slice(start, end), /let sortTextByProperty/);
    assert.doesNotMatch(source.slice(0, start) + source.slice(end), /let sortTextByProperty/);
    assert.doesNotMatch(source.slice(start, end), /JSON\.stringify|localStorage|sessionStorage|setTimeout|\.options\s*=/);
  }
});

test('sanitizer protocol allowlist and every node/attribute policy remain unchanged', () => {
  const before = sourceFor('public/rendered-html-sanitizer.js', 'baseline').replace(/\r\n/g, '\n');
  let after = sourceFor('public/rendered-html-sanitizer.js').replace(/\r\n/g, '\n');
  // Reverse only the allocation-only rewrite; any other security-policy edit
  // must fail this exact-source assertion rather than being hidden by a mock.
  after = after
    .replace('const allowedRenderedHrefSchemes = new Set(["http:", "https:", "mailto:"]);\n', '')
    .replace('!allowedRenderedHrefSchemes.has(parsed.protocol)', '!new Set(["http:", "https:", "mailto:"]).has(parsed.protocol)')
    .replace('// The parsed source tree is never mutated: build fresh nodes in a separate\n// fragment and iterate its source NodeLists directly, without per-node copies.\n', '')
    .replaceAll('of node.childNodes)', 'of [...node.childNodes])')
    .replaceAll('of template.content.childNodes)', 'of [...template.content.childNodes])');
  assert.equal(after, before);
});
