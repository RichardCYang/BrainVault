import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { baseline, loadDatabase, databaseFixture, randomGenerator, freeze, resetMetrics } from './helpers/normalization-idle-resource-harness.mjs';

for (const [name, record] of Object.entries({ ...baseline.files, ...baseline.menuFunctions })) {
  test(`normalization/idle: original fixture SHA-256 (${name})`, () => {
    assert.equal(createHash('sha256').update(record.source).digest('hex'), record.sha256);
  });
}

const implementations = {};
for (const side of ['client', 'server']) {
  implementations[side] = { before: await loadDatabase(side, 'baseline'), after: await loadDatabase(side) };
  for (const type of ['select', 'multi_select', 'text', 'number', 'checkbox', 'date', 'url']) {
    test(`${side} ${type}: maximum-capacity input remains byte-identical and unmodified`, () => {
      const input = freeze(databaseFixture({ type }));
      const { before, after } = implementations[side];
      const bytes = JSON.stringify(input);
      assert.deepEqual(after.normalize(input), before.normalize(input));
      assert.equal(JSON.stringify(input), bytes);
      assert.deepEqual(after.normalize(after.normalize(input)), before.normalize(before.normalize(input)));
    });
  }
  test(`${side}: 200 x 20 x 30 removes repeated option scans and per-cell alias sets`, async () => {
    const input = freeze(databaseFixture());
    const before = await loadDatabase(side, 'baseline', { instrument: true });
    const after = await loadDatabase(side, 'current', { instrument: true });
    assert.deepEqual(after.normalize(input), before.normalize(input));
    assert.equal(before.metrics.optionComparisons, 200 * 19 * 465);
    assert.equal(before.metrics.propertyAliasChecks, 4000);
    assert.equal(before.metrics.candidateBatches, 4000);
    assert.equal(after.metrics.optionComparisons, 0);
    assert.equal(after.metrics.optionMembershipChecks, 200 * 19 * 30);
    assert.equal(after.metrics.propertyAliasChecks, 20);
    assert.equal(after.metrics.candidateBatches, 20);
    assert.ok(after.metrics.setAllocations <= before.metrics.setAllocations - 3900, JSON.stringify({ before: before.metrics, after: after.metrics }));
    resetMetrics(after.metrics);
    after.normalize(freeze(databaseFixture({ rows: 0, type: 'text' })));
    assert.equal(after.metrics.candidateBatches, 0, 'do not allocate per-property row caches for an empty table');
    assert.equal(after.metrics.optionMembershipChecks, 0);
  });
}

const dangerousIds = ['__proto__', 'constructor', 'prototype', ' duplicate ', 'duplicate', '', 'x'.repeat(90), 'title', 'property-1', null, 7];
const values = [null, false, true, 0, -1, 3.5, '', 'o0', 'o29', 'unknown', ' constructor ', '__proto__', ['o1', 'o1', false, null, 'o0', 'unknown'], { id: 'o1' }];

test('3,000 seeded malformed JSON models preserve ID ownership, alias priority, filters, sorts and all values', () => {
  const random = randomGenerator();
  const pick = items => items[Math.floor(random() * items.length)];
  for (let run = 0; run < 3000; run++) {
    const input = databaseFixture({ rows: 1 + run % 4, properties: 1 + run % 20, options: run % 31, type: pick(['select', 'multi_select', 'text', 'checkbox', 'number', 'url']) });
    for (let index = 0; index < input.properties.length; index++) {
      const property = input.properties[index], old = property.id;
      if (random() < 0.6) property.id = pick(dangerousIds);
      if (random() < 0.2) property.type = pick(['title', 'text', 'invalid', null, 'multi_select']);
      property.options.forEach(option => { if (random() < 0.3) option.id = pick(dangerousIds); });
      for (const row of input.rows) {
        const pairs = Object.entries(row.values).filter(([key]) => key !== old);
        pairs.push([String(property.id), pick(values)]);
        if (random() < 0.3) pairs.push([old, pick(values)]);
        row.values = Object.fromEntries(pairs);
      }
    }
    if (run % 5 === 0) input.properties.unshift(null, 42, {});
    if (run % 7 === 0) input.rows.unshift(null, [], {});
    input.views[0].filters = Array.from({ length: run % 11 }, (_, i) => ({ id: pick(dangerousIds), propertyId: input.properties.at(-1)?.id, value: pick(values), operator: pick(['equals', 'contains', 'unchecked', 'is_empty', 'invalid']) }));
    input.views[0].sorts = [{ id: 's', propertyId: input.properties.at(-1)?.id, direction: 'descending' }];
    input.views[0].hiddenPropertyIds = [input.properties.at(-1)?.id, '__proto__'];
    input.views[0].type = pick(['table', 'board', 'list']);
    input.views[0].groupPropertyId = input.properties.at(-1)?.id;
    freeze(input);
    for (const [side, { before, after }] of Object.entries(implementations)) {
      const actual = after.normalize(input);
      assert.deepEqual(actual, before.normalize(input), `${side}, seed case ${run}`);
      assert.equal(JSON.stringify(actual).includes('"valueKeys"'), false);
      assert.equal(JSON.stringify(actual).includes('"validOptionIds"'), false);
    }
    assert.deepEqual(implementations.client.after.normalize(input), implementations.server.after.normalize(input), `client/server parity case ${run}`);
    assert.equal({}.polluted, undefined);
  }
});

test('aliases: inherited properties never override own fields, and undefined own values retain precedence', () => {
  for (const ownValue of [undefined, null, '', ['o0', 'o1']]) {
    const input = databaseFixture({ rows: 1, properties: 2 });
    input.properties[1].id = ' p1 ';
    input.rows[0].values = Object.assign(Object.create({ ' p1 ': ['o29'], title: 'inherited' }), { p1: ['o2'] });
    Object.defineProperty(input.rows[0].values, ' p1 ', { value: ownValue, enumerable: true });
    freeze(input);
    for (const { before, after } of Object.values(implementations)) assert.deepEqual(after.normalize(input), before.normalize(input));
  }
});

test('each normalization sees changed options and schemas; no cache crosses a row batch or account', () => {
  const input = databaseFixture({ rows: 10, properties: 3 });
  for (let turn = 0; turn < 120; turn++) {
    const id = 'account-' + turn;
    input.properties[1].options = [{ id, name: id, color: 'blue' }];
    input.rows[0].values.p1 = [id, 'account-' + (turn - 1)];
    for (const { before, after } of Object.values(implementations)) {
      const result = after.normalize(input);
      assert.deepEqual(result, before.normalize(input));
      assert.deepEqual(result.rows[0].values.p1, [id]);
      result.properties[1].options[0].id = 'caller-mutated';
      assert.deepEqual(after.normalize(input), before.normalize(input));
    }
  }
});

test('server HTML remains exact for table/board/list, filtering/sorting and untrusted text/URLs', () => {
  const { before, after } = implementations.server;
  for (const type of ['table', 'board', 'list']) {
    const input = databaseFixture({ rows: 20, properties: 3, type: 'select' });
    input.title = '<img src=x onerror=alert(1)>';
    input.properties[0].name = '</script><script>alert(1)</script>';
    input.rows[0].values.title = '<svg/onload=alert(1)>';
    input.views[0].type = type;
    input.views[0].groupPropertyId = 'p1';
    input.views[0].sorts = [{ id: 'sort', propertyId: 'p1', direction: 'descending' }];
    const oldHtml = before.module.renderDatabaseHtml({ database: input });
    const newHtml = after.module.renderDatabaseHtml({ database: input });
    assert.equal(newHtml, oldHtml);
    assert.ok(!newHtml.includes('<img src=x') && !newHtml.includes('<svg/onload') && !newHtml.includes('<script>'));
  }
});
