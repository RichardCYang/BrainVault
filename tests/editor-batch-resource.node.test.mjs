import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { getTextSelectionControlKey, getTextSelectionControlByKey, getRowTextSelectionControls } from '../public/collaboration-caret.js';
import { baseline, makeApp, makeBlocks, makeRow, makeCaret, makeControls, randomGenerator } from './helpers/editor-batch-resource-harness.mjs';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function outcome(run) { try { return { value: run() }; } catch (error) { return { error: error.message }; } }
function setBlocks(app, count, options = {}) {
  const fixture = makeBlocks(count, { ...options, metrics: options.instrument ? app.metrics : null });
  app.state.selectedPage.blocks = fixture.roots;
  app.resetMetrics(); return fixture;
}

for (const [name, hash] of Object.entries(baseline.snippetSha256)) test(`batch audit: original ${name} fixture checksum`, () => {
  assert.equal(createHash('sha256').update(baseline.app[name]).digest('hex'), hash);
});
test('batch audit: original caret module checksum', () => {
  assert.equal(createHash('sha256').update(baseline.caret).digest('hex'), baseline.fileSha256['public/collaboration-caret.js']);
});

for (const nested of [false, true]) for (const count of [1, 100, 2000]) test(`reorder ${count} ${nested ? 'nested' : 'flat'} blocks: exact task, linear lookup`, () => {
  const before = makeApp('baseline', { instrument: true }), after = makeApp('current', { instrument: true });
  const a = setBlocks(before, count, { nested, instrument: true }), b = setBlocks(after, count, { nested, instrument: true });
  const old = before.task(null, [...a.ids].reverse()), fixed = after.task(null, [...b.ids].reverse());
  assert.deepEqual(fixed, old);
  assert.equal(before.metrics.idReads, count * (count + 1) / 2);
  assert.ok(after.metrics.idReads <= 4 * count, JSON.stringify(after.metrics));
  assert.equal(after.metrics.mapConstructions, count === 1 ? 0 : 1);
  assert.equal(after.metrics.mapSets, count === 1 ? 0 : count);
});

test('reorder: complete version overrides allocate no index; partial overrides stay lazy', () => {
  const app = makeApp('current', { instrument: true });
  const fixture = setBlocks(app, 2000, { instrument: true });
  const overrides = Object.fromEntries(fixture.ids.map(id => [id, 7]));
  assert.ok(app.task(null, fixture.ids, overrides).items.every(item => item.expectedVersion === 7));
  assert.deepEqual(app.metrics, { idReads: 0, mapConstructions: 0, mapSets: 0 });
  delete overrides['block-1'];
  app.task(null, fixture.ids, overrides);
  assert.equal(app.metrics.mapSets, 2);
});

for (const kind of ['empty', 'no-page', 'no-user', 'stale-auth', 'invalid-version', 'missing', 'NaN', 'duplicate', 'prototype']) test(`reorder: exact failure/identity semantics for ${kind}`, () => {
  const results = ['baseline', 'current'].map(mode => {
    const app = makeApp(mode, { instrument: true }); const fixture = setBlocks(app, 8, { nested: true });
    let ids = [...fixture.ids], overrides = {}, options = {};
    if (kind === 'empty') ids = [];
    if (kind === 'no-page') app.state.selectedPage = null;
    if (kind === 'no-user') app.state.user = null;
    if (kind === 'stale-auth') options.authenticationScope = { generation: 0, targetKey: 'user-a' };
    if (kind === 'invalid-version') overrides[ids[1]] = 0;
    if (kind === 'missing') ids.splice(1, 0, 'missing');
    if (kind === 'NaN') ids.splice(1, 0, NaN);
    if (kind === 'duplicate') { fixture.flat[4].id = fixture.flat[1].id; ids = [fixture.flat[1].id]; }
    if (kind === 'prototype') { fixture.flat[1].id = '__proto__'; ids = ['__proto__']; overrides = Object.create(null); }
    return outcome(() => app.task(null, ids, overrides, options));
  });
  assert.deepEqual(results[1], results[0]);
});

test('reorder: missing authentication and invalid version cannot trigger later lookups or dispatch', () => {
  const app = makeApp('current', { instrument: true }); const fixture = setBlocks(app, 100, { instrument: true });
  assert.throws(() => app.task(null, fixture.ids, {}, { authenticationScope: { generation: 0 } }), /STALE_AUTH/);
  assert.equal(app.metrics.mapConstructions, 0);
  assert.throws(() => app.task(null, fixture.ids, { 'block-0': 0 }), /BLOCK_EDIT_CONFLICT/);
  assert.equal(app.metrics.mapConstructions, 0);
  assert.deepEqual(app.events, []);
});

test('reorder: 500 seeded permutations, duplicates, nested trees and overrides match immutable inputs', () => {
  const random = randomGenerator();
  for (let run = 0; run < 500; run++) {
    const fixture = makeBlocks(run % 71, { nested: run % 2 === 0 });
    const ids = [...fixture.ids].sort(() => random() - .5);
    const overrides = Object.create(null);
    for (const id of ids) if (random() < .5) overrides[id] = [null, undefined, '4', 0, 99][Math.floor(random() * 5)];
    if (run % 9 === 0) ids.push('missing');
    if (run % 11 === 0 && ids.length) ids.push(ids[0]);
    freeze(fixture.roots); freeze(ids); freeze(overrides);
    const results = ['baseline', 'current'].map(mode => {
      const app = makeApp(mode); app.state.selectedPage.blocks = fixture.roots;
      return outcome(() => app.task(run % 3 ? null : 'parent', ids, overrides));
    });
    assert.deepEqual(results[1], results[0], `seeded reorder ${run}`);
  }
});

test('reorder: page, account and in-place version edits never reuse an index between operations', () => {
  const app = makeApp();
  for (let i = 0; i < 60; i++) {
    const fixture = setBlocks(app, 8, { nested: true });
    app.state.selectedPage.id = `page-${i}`; app.state.user.id = `user-${i}`;
    fixture.flat[7].version = i + 5;
    assert.equal(app.task(null, ['block-7']).items[0].expectedVersion, i + 5);
    fixture.flat[7].version++;
    assert.equal(app.task(null, ['block-7']).items[0].expectedVersion, i + 6);
  }
});

for (const count of [1, 100, 2000]) test(`keepalive accounting ${count} rows: exact serialized payloads and linear lookups`, () => {
  const results = ['baseline', 'current'].map(mode => {
    const app = makeApp(mode, { instrument: true, capturePayloads: true });
    const fixture = setBlocks(app, count, { instrument: true });
    const rows = new Map(fixture.ids.map(id => [id, makeRow(id)]));
    const bytes = app.bytes({ saveTitle: true, rowsToSave: rows });
    return { app, bytes };
  });
  const [before, after] = results;
  assert.equal(after.bytes, before.bytes);
  assert.deepEqual(after.app.payloads, before.app.payloads);
  assert.equal(before.app.metrics.idReads, count * (count + 1));
  assert.ok(after.app.metrics.idReads <= 4 * count, JSON.stringify(after.app.metrics));
  assert.equal(after.app.metrics.mapSets, count === 1 ? 0 : count);
});

test('keepalive: title-only, deleted/empty rows and missing metadata do not create a block index', () => {
  const app = makeApp('current', { instrument: true }); setBlocks(app, 100);
  const rows = new Map([['a', null], ['b', makeRow('')], ['c', makeRow('c', { deleting: 'true' })]]);
  assert.equal(app.bytes({ saveTitle: false, rowsToSave: rows }), 0);
  assert.ok(app.bytes({ saveTitle: true, rowsToSave: rows }) > 0);
  assert.equal(app.metrics.mapConstructions, 0);
});

test('keepalive: mismatched map key and row ID keep separate content/version identities', () => {
  const results = ['baseline', 'current'].map(mode => {
    const app = makeApp(mode, { capturePayloads: true }); const f = setBlocks(app, 4);
    f.flat[2].markdown = 'original attachment';
    const rows = new Map([['block-3', makeRow('block-2', { type: 'ATTACHMENT' })], ['block-1', makeRow('missing')]]);
    return { bytes: app.bytes({ saveTitle: false, rowsToSave: rows }), payloads: app.payloads };
  });
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[1].payloads[0].markdown, 'original attachment');
  assert.equal(results[1].payloads[0].expectedVersion, 4);
  assert.equal(results[1].payloads[1].expectedVersion, 2);
});

test('keepalive: circular metadata still yields Infinity, throwing DOM extraction still propagates', () => {
  for (const mode of ['baseline', 'current']) {
    const app = makeApp(mode); const f = setBlocks(app, 2);
    f.flat[0].metadata.loop = f.flat[0].metadata;
    assert.equal(app.bytes({ saveTitle: false, rowsToSave: new Map([['block-0', makeRow('block-0')]]) }), Infinity);
    const row = makeRow('block-1'); row.querySelector = () => { throw Error('DOM_EXTRACTION_FAILED'); };
    assert.throws(() => app.bytes({ saveTitle: false, rowsToSave: new Map([['block-1', row]]) }), /DOM_EXTRACTION_FAILED/);
  }
});

test('keepalive: 500 seeded metadata, version, Unicode, toggle, attachment and deleting-row cases match byte-for-byte', () => {
  const random = randomGenerator(0x20480001);
  const texts = ['', '\u0000', '한글😀', '\ud800', '<img src=x onerror=alert(1)>', 'line\r\nline', '"\\'];
  const types = ['MARKDOWN', 'TODO', 'ATTACHMENT', 'TOGGLE', 'QUOTE', 'DIVIDER'];
  for (let run = 0; run < 500; run++) {
    const fixture = makeBlocks(run % 45, { nested: run % 2 === 0 });
    for (const block of fixture.flat) block.metadata = run % 5 ? { text: texts[run % texts.length], toggleOpen: true, textAlign: 'right' }
      : JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}');
    freeze(fixture.roots);
    const entries = fixture.ids.map((id, i) => [run % 3 ? id : fixture.ids[(i + 1) % fixture.ids.length], {
      id: run % 17 === 0 && i === 0 ? 'missing' : id, type: types[(run + i) % types.length], text: texts[(run + i) % texts.length],
      checked: random() > .5, deleting: random() < .1 ? 'true' : 'false',
      draftExpectedVersion: [undefined, '', '0', '4', '9007199254740992'][Math.floor(random() * 5)],
      textAlign: ['left', 'center', 'invalid'][i % 3]
    }]);
    const results = ['baseline', 'current'].map(mode => {
      const app = makeApp(mode, { capturePayloads: true }); app.state.selectedPage.blocks = fixture.roots;
      app.elements.pageTitle.value = texts[run % texts.length]; app.setTitleVersion(run % 5 ? undefined : 5);
      const rows = new Map(entries.map(([key, { id, ...options }]) => [key, makeRow(id, options)]));
      return { bytes: app.bytes({ saveTitle: run % 2 === 0, rowsToSave: rows }), payloads: app.payloads };
    });
    assert.deepEqual(results[1], results[0], `seeded payload ${run}`);
    assert.equal({}.polluted, undefined);
  }
});

for (const mode of ['baseline', 'current']) test(`collaborative reorder (${mode}): original block data, order and mutation fence are preserved`, async () => {
  const app = makeApp(mode, { instrument: true }); const f = setBlocks(app, 2000, { instrument: true });
  let call;
  app.state.collaborationSession = { isReady: true, async upsertBlocks(updates, options) { call = { updates, options }; } };
  const result = await app.persist(null, [...f.ids].reverse());
  assert.equal(call.options.beforeCommit(), true);
  assert.deepEqual(result.blocks, call.updates);
  assert.deepEqual(result.blocks.map(x => x.id), [...f.ids].reverse());
  assert.ok(result.blocks.every((x, i) => x.sortOrder === i && x.metadata === f.flat[1999 - i].metadata));
  if (mode === 'current') assert.ok(app.metrics.idReads < 20_000);
  else assert.ok(app.metrics.idReads > 2_000_000);
});

for (const change of ['navigation', 'auth', 'page', 'read-only']) test(`collaborative reorder: ${change} changing while queued prevents commit`, async () => {
  for (const mode of ['baseline', 'current']) {
    const app = makeApp(mode); setBlocks(app, 2);
    let release, committed = 0;
    app.state.collaborationSession = { isReady: true, async upsertBlocks(_updates, { beforeCommit }) {
      await new Promise(resolve => { release = resolve; });
      if (beforeCommit()) committed++;
    }};
    const pending = app.persist(null, ['block-1', 'block-0']);
    if (change === 'navigation') app.gate.navigation++;
    if (change === 'auth') app.gate.auth++;
    if (change === 'page') app.state.selectedPage = { id: 'other', blocks: [] };
    if (change === 'read-only') app.gate.writable = false;
    release();
    if (change === 'auth') await assert.rejects(pending, /STALE_AUTH/);
    else assert.equal(await pending, app.skippedApiRequest);
    assert.equal(committed, 0);
  }
});

for (const failure of ['not-ready', 'unknown-block', 'read-only', 'stale-auth']) test(`collaborative reorder fails closed: ${failure}`, async () => {
  for (const mode of ['baseline', 'current']) {
    const app = makeApp(mode); setBlocks(app, 2); let calls = 0;
    app.state.collaborationSession = { isReady: failure !== 'not-ready', async upsertBlocks() { calls++; } };
    if (failure === 'read-only') app.gate.writable = false;
    const options = failure === 'stale-auth' ? { authenticationScope: { generation: 0 } } : {};
    const pending = app.persist(null, failure === 'unknown-block' ? ['missing'] : ['block-0'], {}, options);
    if (failure === 'read-only') assert.equal(await pending, app.skippedApiRequest);
    else await assert.rejects(pending);
    assert.equal(calls, 0);
  }
});

for (const kind of ['success', 'transient', 'definitive']) test(`noncollaborative reorder preserves recovery acknowledgement and queue state: ${kind}`, async () => {
  const results = [];
  for (const mode of ['baseline', 'current']) {
    const app = makeApp(mode); setBlocks(app, 4); app.gate.collaborative = false;
    if (kind !== 'success') app.gate.dispatchError = Error('NETWORK_FAILURE');
    app.gate.definitive = kind === 'definitive';
    let result;
    try { result = await app.persist(null, ['block-2', 'block-0', 'block-3', 'block-1']); }
    catch (error) { result = { error: error.message }; }
    results.push({ result, events: app.events, queue: app.getQueueState() });
  }
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[1].events.filter(x => x[0] === 'acknowledge').length, kind === 'transient' ? 0 : 1);
  assert.equal(results[1].queue.blockOrderSaving, kind === 'transient');
});

for (const target of [0, 1, 999]) test(`caret: only inspect the selected prefix for index ${target}`, () => {
  const { controls, row } = makeControls(1000);
  const expected = makeCaret('baseline'); const after = makeCaret();
  assert.equal(after.key(controls[target], row), expected.key(controls[target], row));
  assert.equal(after.byKey(row, `text:${target}`), expected.byKey(row, `text:${target}`));
  for (const mode of ['baseline', 'current']) {
    const metrics = { selectionReads: 0, queries: 0 }; const f = makeControls(1000, { metrics }); const api = makeCaret(mode);
    api.key(f.controls[target], f.row); api.byKey(f.row, `text:${target}`);
    assert.equal(metrics.selectionReads, mode === 'baseline' ? 2000 : 2 * (target + 1));
    assert.equal(metrics.queries, 2);
  }
});

test('caret: malformed selectors, missing targets/rows, exceptions and non-text inputs retain exact behavior', () => {
  const good = { value: 'safe', selectionStart: 0, selectionEnd: 0 };
  const bad = { value: 'number', selectionStart: null, selectionEnd: null };
  const throwing = { get value() { throw Error('restricted input'); } };
  const row = { querySelectorAll: () => [bad, throwing, good] };
  const before = makeCaret('baseline'), after = makeCaret();
  assert.deepEqual(after.all(row), before.all(row));
  assert.equal(after.key(good, row), 'text:0');
  assert.equal(after.key(bad, row), null); assert.equal(after.key({}, row), null);
  for (const key of [undefined, null, '', 'text:0', 'text:0000', 'text:1', 'text:9999', 'text:10000', 'text:-1', 'text:1.0', 'text:NaN', 'input[name=password]', '__proto__']) {
    assert.equal(after.byKey(row, key), before.byKey(row, key));
    assert.equal(after.byKey(null, key), before.byKey(null, key));
  }
  assert.equal(after.key(good, null), null);
});

test('caret: native exports match the harness and do not retain stale elements after edits/navigation', () => {
  const f = makeControls(15), api = makeCaret();
  const native = { key: getTextSelectionControlKey, byKey: getTextSelectionControlByKey, all: getRowTextSelectionControls };
  const target = f.controls[7];
  for (let i = 0; i < 15; i++) {
    assert.deepEqual(native.all(f.row), api.all(f.row));
    assert.equal(native.key(target, f.row), api.key(target, f.row));
    assert.equal(native.byKey(f.row, 'text:0'), api.byKey(f.row, 'text:0'));
    f.controls.shift();
  }
  assert.equal(native.key(target, f.row), null);
});

test('caret: 1000 seeded input-type changes preserve indices, identity and unchanged source arrays', () => {
  const before = makeCaret('baseline'), after = makeCaret(); const random = randomGenerator(0xaabb3322);
  for (let run = 0; run < 1000; run++) {
    const f = makeControls(run % 81);
    for (const control of f.controls) if (random() < .45) Object.defineProperty(control, 'selectionStart', { value: null });
    const index = Math.floor(random() * (f.controls.length + 1)), target = f.controls[index];
    Object.freeze(f.controls);
    assert.deepEqual(after.all(f.row), before.all(f.row));
    assert.equal(after.key(target, f.row), before.key(target, f.row));
    assert.equal(after.byKey(f.row, `text:${index}`), before.byKey(f.row, `text:${index}`));
  }
});

for (const operation of ['reorder', 'keepalive']) test(`${operation}: one late block on a 10000-block page needs no Map`, () => {
  const app = makeApp('current', { instrument: true });
  const fixture = setBlocks(app, 10000, { instrument: true });
  if (operation === 'reorder') app.task(null, [fixture.ids.at(-1)]);
  else app.bytes({ saveTitle: false, rowsToSave: new Map([[fixture.ids.at(-1), makeRow(fixture.ids.at(-1))]]) });
  assert.equal(app.metrics.mapConstructions, 0);
  assert.equal(app.metrics.idReads, 10000);
});

for (const delta of [-1, 0, 1]) test(`keepalive: exact 60KiB boundary ${delta >= 0 ? '+' : ''}${delta} byte`, () => {
  const budget = 60 * 1024;
  const results = ['baseline', 'current'].map(mode => {
    const app = makeApp(mode); setBlocks(app, 2);
    const row = makeRow('block-1', { text: '' });
    const rowsToSave = new Map([['block-1', row]]);
    const overhead = app.bytes({ saveTitle: false, rowsToSave });
    row.controls['textarea[name="markdown"]'].value = 'x'.repeat(budget + delta - overhead);
    return app.bytes({ saveTitle: false, rowsToSave });
  });
  assert.deepEqual(results, [budget + delta, budget + delta]);
  assert.equal(results[1] <= budget, delta <= 0);
});
