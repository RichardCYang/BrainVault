import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { baseline, sourceFor, draftRecord, storageKey, makeDraftHarness, TestAsset, makeAssetHarness, drainMicrotasks, randomGenerator } from './helpers/render-draft-asset-resource-harness.mjs';

for (const [name, record] of Object.entries(baseline.functions)) test(`uploaded resource baseline hash: ${name}`, () => {
  assert.equal(createHash('sha256').update(record.source).digest('hex'), record.sha256);
});
test('the strict recovery parser and every persistence/acknowledgment method remain byte-identical', () => {
  assert.equal(createHash('sha256').update(readFileSync(new URL('../public/draft-store.js', import.meta.url))).digest('hex'), baseline.draftStoreSha256);
});
for (const count of [1, 40, 200]) test(`actual page-render call site reads a ${count}-block source exactly once and preserves output`, () => {
  const record = draftRecord(count);
  const before = makeDraftHarness('baseline', [record]), after = makeDraftHarness('current', [record]);
  before.render(); after.render();
  assert.deepEqual(after.rendered, before.rendered);
  assert.deepEqual(after.events, before.events);
  assert.equal(before.metrics.reads, count); assert.equal(after.metrics.reads, 1);
  assert.equal(before.metrics.readBytes, after.metrics.readBytes * count);
  assert.equal(after.metrics.writes, 0); assert.equal(after.metrics.removals, 0);
  assert.deepEqual([...after.values], [...before.values]);
});
test('each render/source gets an independent snapshot, including absent and corrupt records', () => {
  const records = [draftRecord(12), draftRecord(8, { sourceId: 'another:source', offset: 12 })];
  const h = makeDraftHarness('current', records);
  h.render(); assert.equal(h.metrics.reads, 2);
  records[0].blocks['block-0'].payload.markdown = 'newer tab edit'; h.put(records[0]);
  h.render(); assert.equal(h.metrics.reads, 4); assert.equal(h.rendered[0].draft.payload.markdown, 'newer tab edit');
  h.values.delete(storageKey(records[0])); h.values.set(storageKey(records[1]), '{invalid');
  h.render(); assert.equal(h.metrics.reads, 6); assert.ok(h.rendered.every(row => row.draft === null));
  assert.equal(h.values.get(storageKey(records[1])), '{invalid');
});
test('single-block refreshes still read fresh storage every time', () => {
  const record = draftRecord(1), h = makeDraftHarness('current', [record]);
  const first = h.get('page-a', 'block-0');
  record.blocks['block-0'].payload.markdown = 'later'; h.put(record);
  const second = h.get('page-a', 'block-0');
  assert.notEqual(first.payload.markdown, second.payload.markdown); assert.equal(h.metrics.reads, 2);
});
test('different users, pages and source IDs cannot borrow a prior render snapshot', () => {
  const records = [draftRecord(2), draftRecord(2, { userId: 'user-b' }), draftRecord(2, { userId: 'user-b', pageId: 'page-b' })];
  records[1].blocks['block-0'].payload.markdown = 'user B'; records[2].blocks['block-0'].payload.markdown = 'page B';
  const h = makeDraftHarness('current', records);
  h.render(); h.state.user.id = 'user-b'; h.render(); assert.equal(h.rendered[0].draft.payload.markdown, 'user B');
  h.state.selectedPage.id = 'page-b'; h.render(); assert.equal(h.rendered[0].draft.payload.markdown, 'page B');
  h.state.user = null; h.render(); assert.equal(h.rendered[0].draft, null); assert.equal(h.metrics.reads, 3);
});
for (const kind of ['clean', 'collaborative', 'home', 'collection', 'empty']) test(`${kind} view performs no recovery read`, () => {
  const h = makeDraftHarness('current', [draftRecord(4)]);
  if (kind === 'clean') h.sources.clear();
  if (kind === 'collaborative') h.state.selectedPage.collaborative = true;
  if (['home', 'collection'].includes(kind)) h.state.workspaceView = kind;
  if (kind === 'empty') h.state.selectedPage.blocks = [];
  h.render(); assert.equal(h.metrics.reads, 0);
});
test('resolved/unresolved conflicts, source selection and fallback payloads have exact parity', () => {
  const record = draftRecord(8);
  const scenarios = [null, { resolved: true }, { resolved: false }, { revision: 88, expectedVersion: 91, payload: { type: 'MARKDOWN', markdown: 'fallback', checked: false } }];
  for (const origin of scenarios) for (const available of [true, false]) {
    const pair = ['baseline', 'current'].map(mode => makeDraftHarness(mode, [record]));
    for (const h of pair) {
      h.sources.clear(); if (!available) h.values.clear();
      if (origin) h.conflicts.set('block-0', structuredClone(origin));
      h.render();
    }
    assert.deepEqual(pair[1].rendered, pair[0].rendered);
  }
});
test('corrupt/future/foreign/duplicate-key recovery records stay rejected without being rewritten', () => {
  const valid = draftRecord(3), raw = JSON.stringify(valid);
  const variants = ['', '{', raw.replace('"schemaVersion":2', '"schemaVersion":99'), raw.replace('"userId":"user-a"', '"userId":"other"'),
    raw.replace('"sourceId":"source-a"', '"sourceId":"foreign"'), raw.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'),
    raw.replace('"schemaVersion":2', '"unknown":true,"schemaVersion":2')];
  for (const bad of variants) {
    const pair = ['baseline', 'current'].map(mode => makeDraftHarness(mode, [valid]));
    for (const h of pair) { h.values.set(storageKey(valid), bad); h.render(); }
    assert.deepEqual(pair[1].rendered, pair[0].rendered); assert.ok(pair[1].rendered.every(row => row.draft === null));
    assert.equal(pair[1].values.get(storageKey(valid)), bad); assert.equal(pair[1].metrics.writes, 0);
  }
});
test('prototype-like identifiers remain literal map keys and HTML remains unexecuted data', () => {
  const record = draftRecord(1, { sourceId: '__proto__' });
  const draft = record.blocks['block-0']; record.blocks = Object.create(null);
  for (const key of ['__proto__', 'constructor', 'prototype']) record.blocks[key] = structuredClone(draft);
  const a = makeDraftHarness('baseline', [record]), b = makeDraftHarness('current', [record]);
  a.render(); b.render(); assert.deepEqual(b.rendered, a.rendered); assert.equal(b.metrics.reads, 1);
  assert.equal({}.polluted, undefined); assert.ok(b.rendered[0].draft.payload.markdown.includes('<script>'));
});
test('200 seeded mixed-source/conflict renders keep every observable payload and leave storage unchanged', () => {
  const random = randomGenerator();
  for (let run = 0; run < 200; run++) {
    const records = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, i) => draftRecord(1 + Math.floor(random() * 8), { sourceId: 'source-' + i, offset: i * 10 }));
    const pair = ['baseline', 'current'].map(mode => makeDraftHarness(mode, records));
    for (const record of records) for (const id of Object.keys(record.blocks)) {
      if (random() < .2) for (const h of pair) h.conflicts.set(id, { ...structuredClone(record.blocks[id]), resolved: run % 2 === 0 });
      if (random() < .1) for (const h of pair) h.sources.delete(id);
    }
    if (random() < .3) for (const h of pair) h.values.delete(storageKey(records[0]));
    for (const h of pair) h.render();
    assert.deepEqual(pair[1].rendered, pair[0].rendered, `case ${run}`);
    assert.deepEqual([...pair[1].values], [...pair[0].values]);
    assert.equal(pair[1].metrics.writes + pair[1].metrics.removals, 0);
  }
});
for (const event of ['load', 'error']) test(`asset ${event} removes both listeners and cancels the now-unneeded deadline`, async () => {
  const before = makeAssetHarness('baseline', { images: [new TestAsset()], frames: [new TestAsset()] });
  const after = makeAssetHarness('current', { images: [new TestAsset()], frames: [new TestAsset()] });
  for (const h of [before, after]) {
    const promise = h.wait(); h.images[0].fire(event); h.frames[0].fire(event); await promise;
    assert.equal(h.frames[0].attributes.get('loading'), 'eager'); assert.deepEqual(h.delays, [2500]);
  }
  assert.equal(before.listeners(), 2); assert.equal(before.timers.size, 1);
  assert.equal(after.listeners(), 0); assert.equal(after.timers.size, 0);
});
test('repeated deadline expiry retains no listeners, pending element waiters or timers', async () => {
  for (const mode of ['baseline', 'current']) {
    const h = makeAssetHarness(mode, { images: Array.from({length: 12}, () => new TestAsset()), frames: Array.from({length: 8}, () => new TestAsset()) });
    for (let i = 0; i < 30; i++) { const p = h.wait(); await h.advance(2500); await p; }
    assert.equal(h.listeners(), mode === 'baseline' ? 1200 : 0); assert.equal(h.timers.size, 0);
  }
});
test('the 2,500ms deadline is preserved for a hung image/frame/font and late events are harmless', async () => {
  const image = new TestAsset(), frame = new TestAsset();
  const h = makeAssetHarness('current', { images: [image], frames: [frame], fonts: new Promise(() => {}) });
  let settled = false; const p = h.wait().then(() => { settled = true; });
  await h.advance(2499); assert.equal(settled, false); await h.advance(1); await p;
  assert.equal(settled, true); assert.equal(h.listeners(), 0); image.fire('load'); frame.fire('error');
  assert.equal(h.listeners(), 0); assert.equal(h.timers.size, 0);
});
test('already-loaded assets, decode rejection, and font rejection keep best-effort export behavior', async () => {
  let decoded = 0;
  const h = makeAssetHarness('current', { images: [new TestAsset({ complete: true, decode: () => { decoded++; return Promise.reject(new Error('bad image')); } }), new TestAsset({ complete: true })], frames: [new TestAsset({ loaded: true })], fonts: Promise.reject(new Error('font')) });
  await h.wait(); assert.equal(decoded, 1); assert.equal(h.listeners(), 0); assert.equal(h.timers.size, 0);
});
test('a completed image still waits for decode, unless the unchanged deadline expires', async () => {
  let resolve; const decoded = new Promise(r => { resolve = r; });
  const h = makeAssetHarness('current', { images: [new TestAsset({ complete: true, decode: () => decoded })] });
  let settled = false; const p = h.wait().then(() => { settled = true; }); await drainMicrotasks();
  assert.equal(settled, false); resolve(); await p; assert.equal(h.timers.size, 0);
});
test('synchronous setup failure still removes listeners installed for earlier assets', async () => {
  const error = new Error('synchronous decode failure');
  const h = makeAssetHarness('current', { images: [new TestAsset(), new TestAsset({ complete: true, decode: () => { throw error; } })] });
  await assert.rejects(h.wait(), e => e === error); assert.equal(h.listeners(), 0); assert.equal(h.timers.size, 0);
});
test('overlapping exports release only their own listeners and do not cancel one another', async () => {
  const image = new TestAsset(), h = makeAssetHarness('current', { images: [image] });
  const first = h.wait(); await h.advance(1000); const second = h.wait(); await h.advance(1500); await first;
  assert.equal(h.listeners(), 2); assert.equal(h.timers.size, 1); image.fire('load'); await second;
  assert.equal(h.listeners(), 0); assert.equal(h.timers.size, 0);
});
