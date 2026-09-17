import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { baseline, makeHarness, recoveryFixture } from './helpers/rendered-row-resource-harness.mjs';

for (const [name, record] of Object.entries(baseline.records)) test(`row lookup: byte-exact uploaded baseline (${name})`, () => {
  assert.equal(createHash('sha256').update(record.source).digest('hex'), record.sha256);
});

for (const id of ['b_0', 'b_1000', 'b_1999', 'missing']) test(`single-row lookup avoids a 2,000-element snapshot (${id})`, () => {
  const before = makeHarness('baseline', {count: 2000}), after = makeHarness('current', {count: 2000});
  assert.equal(after.find(id)?._id, before.find(id)?._id);
  assert.equal(before.metrics.listedRows, 2000);
  assert.equal(after.metrics.allQueries, 0);
  assert.equal(after.metrics.yieldedRows, 0);
  assert.equal(after.metrics.singleQueries, 1);
});

for (const operation of ['conflicts', 'materialize', 'activate']) test(`2,000-row ${operation}: one snapshot, exact functional parity`, () => {
  const before = makeHarness('baseline', {count: 2000}), after = makeHarness('current', {count: 2000});
  const input = operation === 'conflicts' ? Array.from({length: 2000}, (_, i) => ({id: `b_${i}`, version: 3}))
    : operation === 'materialize' ? {blocks: Array.from({length: 2000}, (_, i) => ({id: `b_${i}`, htmlCache: `<p>new ${i}</p>`}))}
    : recoveryFixture(2000, true);
  assert.deepEqual(after[operation](structuredClone(input)), before[operation](structuredClone(input)));
  assert.deepEqual(after.outcome(), before.outcome());
  assert.deepEqual(after.state, before.state);
  assert.equal(before.metrics.allQueries, 2000);
  assert.equal(before.metrics.listedRows, 4000000);
  assert.equal(after.metrics.allQueries, 1);
  assert.equal(after.metrics.listedRows, 2000);
  assert.equal(after.metrics.yieldedRows, 2000);
});

test('empty operations and early origin conflicts do not allocate a DOM snapshot', () => {
  const h = makeHarness('current', {count: 2000, origins: [['b_0', {resolved: false}]]});
  assert.equal(h.conflicts([]), false);
  assert.equal(h.conflicts([{id: 'b_0'}, {id: 'b_1'}]), true);
  assert.equal(h.activate(recoveryFixture()), false);
  h.materialize(null); h.materialize({blocks: []}); h.materialize({blocks: [{id: 'missing', htmlCache: '<p>x</p>'}]});
  assert.equal(h.metrics.allQueries, 0); assert.equal(h.metrics.singleQueries, 0);
});

test('single-item batches use single lookup rather than indexing all rows', () => {
  const h = makeHarness('current', {count: 2000});
  h.conflicts([{id: 'b_0'}]); h.materialize({blocks: [{id: 'b_0', htmlCache: 'new'}]}); h.activate(recoveryFixture(1));
  assert.equal(h.metrics.allQueries, 0); assert.equal(h.metrics.singleQueries, 3);
});

test('strict identity, hostile selectors, Unicode, NUL and duplicate-first semantics remain unchanged', () => {
  const ids = ['', '한글 😀', 'x"], .victim, [x="', '\\', '\u0000', 'a\nb', 'b_0', 'b_0', 'B_0'];
  const before = makeHarness('baseline'), after = makeHarness('current');
  for (const h of [before, after]) h.setRows(ids.map((id, i) => Object.assign(h.makeRow(id, i === 7), { position: i })));
  for (const id of [...ids, undefined, null, 0, NaN, false, {}, new String('b_0')]) {
    assert.equal(after.find(id)?.position, before.find(id)?.position);
    assert.equal(after.batch(20)(id)?.position, before.find(id)?.position);
  }
  assert.equal(after.conflicts([{id: 'b_0'}, {id: 'missing'}]), false, 'later duplicate must not override the first match');
});

test('indexes are operation-local: reorder, removal, replacement and page/account changes are fresh', () => {
  const h = makeHarness('current', {count: 3});
  assert.equal(h.conflicts([{id: 'b_1'}, {id: 'b_2'}]), false);
  const oldRow = h.find('b_1'), replacement = h.makeRow('b_1', true);
  h.setRows([replacement, h.rows[0]]);
  assert.notEqual(h.find('b_1'), oldRow);
  assert.equal(h.conflicts([{id: 'b_2'}, {id: 'b_1'}]), true);
  h.setRows([]); h.state.selectedPage = null;
  assert.equal(h.find('b_1'), undefined);
  assert.equal(h.conflicts([{id: 'b_1'}, {id: 'b_2'}]), false);
  h.state.selectedPage = {id: 'page-other-account', blocks: [{id: 'b_1', htmlCache: 'other'}]};
  const otherRow = h.makeRow('b_1'); h.setRows([otherRow]);
  h.materialize({blocks: [{id: 'b_1', htmlCache: 'current'}, {id: 'b_2', htmlCache: 'ignored'}]});
  assert.equal(h.events.at(-1)[1], otherRow._id);
  assert.equal(oldRow.dataset.draftConflict, 'false');
});

test('500 seeded malformed/duplicate conflict snapshots preserve the fail-closed decision', () => {
  let seed = 0x91720;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let run = 0; run < 500; run++) {
    const ids = Array.from({length: 1 + Math.floor(random() * 60)}, () => `b_${Math.floor(random() * 45)}`);
    const flags = ids.map(() => random() < 0.15);
    const origins = ids.filter(() => random() < 0.2).map(id => [id, {resolved: random() < 0.5}]);
    const input = Array.from({length: Math.floor(random() * 70)}, () => ({id: random() < 0.1 ? null : `b_${Math.floor(random() * 60)}`}));
    const values = ['baseline', 'current'].map(mode => {
      const h = makeHarness(mode, {origins}); h.setRows(ids.map((id, i) => h.makeRow(id, flags[i]))); return h.conflicts(input);
    });
    assert.equal(values[1], values[0], `case ${run}`);
  }
});

for (const invalidScope of [false, true]) for (const failPersistence of [false, true]) test(`recovery gates, errors and timers preserved (auth=${invalidScope}, storage=${failPersistence})`, async () => {
  for (const conflict of [true, false]) {
    const before = makeHarness('baseline', {count: 4, invalidScope, failPersistence}), after = makeHarness('current', {count: 4, invalidScope, failPersistence});
    const recovery = recoveryFixture(4, conflict);
    recovery.blocks.splice(1, 0, {...structuredClone(recovery.blocks[0]), blockId: 'missing'});
    let expected, actual;
    try { expected = before.activate(structuredClone(recovery)); } catch (e) { expected = e.message; }
    try { actual = after.activate(structuredClone(recovery)); } catch (e) { actual = e.message; }
    assert.deepEqual(actual, expected); assert.deepEqual(after.outcome(), before.outcome());
    await before.fireTimers(); await after.fireTimers(); assert.deepEqual(after.outcome(), before.outcome());
    if (conflict || invalidScope || failPersistence) assert.ok(!after.events.some(event => event[0] === 'save-block'));
  }
});

for (const conflict of [true, false]) test(`title/order recovery and current-tab ownership preserved (conflict=${conflict})`, async () => {
  const recovery = recoveryFixture(3, conflict);
  recovery.title = {value: '한글 😀', sourceId: 'origin-tab', revision: 4, expectedVersion: 9, conflict};
  recovery.blockOrder = {sourceId: 'origin-tab', serverIds: ['b_0', 'b_1', 'b_2'], draft: {parentBlockId: null,
    orderedIds: ['b_2', 'b_1', 'b_0'], mutationId: 'order-1', items: [{id: 'b_2', expectedVersion: 7}]}};
  const before = makeHarness('baseline', {count: 3}), after = makeHarness('current', {count: 3});
  assert.equal(after.activate(structuredClone(recovery)), before.activate(structuredClone(recovery)));
  assert.deepEqual(after.outcome(), before.outcome());
  await before.fireTimers(); await after.fireTimers(); assert.deepEqual(after.outcome(), before.outcome());
  assert.equal(after.titleState().pageTitleDraftSourceId, 'current-tab');
  assert.equal(after.orderState().pendingBlockOrderTask.recoveredOrigin.sourceId, 'origin-tab');
});

test('materialization preserves order, duplicate server IDs, invalid caches and missing blocks', () => {
  const before = makeHarness('baseline', {count: 4}), after = makeHarness('current', {count: 4});
  const data = {blocks: [null, {id: 'b_0', htmlCache: null}, {id: 'missing', htmlCache: 'missing'},
    {id: 'b_2', htmlCache: '<script>not executed by lookup</script>'}, {id: 'b_2', htmlCache: ''}, {id: 'b_1', htmlCache: 'final'}]};
  before.materialize(data); after.materialize(data);
  assert.deepEqual(after.state, before.state); assert.deepEqual(after.events, before.events);
});
