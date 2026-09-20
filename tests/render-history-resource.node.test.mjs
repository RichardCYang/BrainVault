import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createEditorHistory } from '../public/editor-history.js';
import { diffWorkspaceManifests } from '../src/lib/workspace-snapshot-diff.ts';
import { baseline, makeHistory, makeDiff, manifest, regenerated, randomGenerator, freeze } from './helpers/render-history-resource-harness.mjs';

for (const [path, record] of Object.entries(baseline.files)) test(`render/history audit fixture is byte-exact: ${path}`, () => {
  assert.equal(createHash('sha256').update(record.source).digest('hex'), record.sha256);
});

function withoutLegacyDiffCaps(result) {
  const value = structuredClone(result);
  delete value.detailsTruncated;
  delete value.limits;
  for (const page of value.pages) delete page.blockDetailsTruncated;
  return value;
}

function assertLegacyDiffPrefix(actual, legacy, message = undefined) {
  const expected = withoutLegacyDiffCaps(legacy);
  assert.deepEqual(actual.summary, expected.summary, message);
  assert.deepEqual(actual.workspace, expected.workspace, message);
  assert.equal(actual.identical, expected.identical, message);
  for (let index = 0; index < expected.pages.length; index++) {
    const expectedPage = expected.pages[index];
    const actualPage = actual.pages[index];
    assert.ok(actualPage, message);
    assert.deepEqual(
      { ...actualPage, blocks: actualPage.blocks.slice(0, expectedPage.blocks.length) },
      expectedPage,
      message
    );
  }
}

for (const nativeClone of [true, false]) {
  test(`1000 undo/redo commits avoid redundant defensive clones (${nativeClone ? 'structuredClone' : 'JSON fallback'})`, () => {
    const modules = ['baseline', 'current'].map(mode => makeHistory(mode, { instrument: true, nativeClone }));
    for (const m of modules) {
      const h = m.create({ maxBytes: 4 * 1024 * 1024 });
      h.seed('p', 'b', { text: 'a'.repeat(100000), nested: { n: [1, 2, 3] } });
      assert.equal(h.record({ pageId: 'p', key: 'b', value: { text: 'b'.repeat(100000), nested: { n: [1, 2, 3] } }, coalesce: false }), true);
      m.metrics.clones = 0; m.metrics.clonedJsonBytes = 0;
      for (let i = 0; i < 500; i++) { assert.equal(h.commit('p', 'undo'), true); assert.equal(h.commit('p', 'redo'), true); }
      m.state = h.getState();
    }
    assert.deepEqual(modules[1].state, modules[0].state);
    assert.equal(modules[0].metrics.clones, 1000);
    assert.ok(modules[0].metrics.clonedJsonBytes > 100_000_000);
    assert.equal(modules[1].metrics.clones, 0);
    assert.equal(modules[1].metrics.clonedJsonBytes, 0);
  });

  test(`history snapshots never alias input, metadata, or peek results after undo/redo (${nativeClone ? 'native' : 'fallback'})`, () => {
    const h = makeHistory('current', { nativeClone }).create({ captureTimeout: 600 });
    const initial = { markdown: 'A', metadata: { list: ['initial'], nested: { x: 1 } } };
    h.seed('p', 'b', initial); initial.metadata.list[0] = 'caller-mutation';
    const value = { markdown: 'B', metadata: { list: ['changed'], nested: { x: 2 } } };
    const meta = { user: { id: 'owner' } };
    h.record({ pageId: 'p', key: 'b', value, meta, now: 1 });
    value.metadata.list[0] = 'caller-mutation'; meta.user.id = 'attacker';
    for (let i = 0; i < 10; i++) {
      const undo = h.peek('p', 'undo');
      assert.equal(undo.before.metadata.list[0], 'initial');
      assert.equal(undo.after.metadata.list[0], 'changed');
      assert.equal(undo.meta.user.id, 'owner');
      undo.before.metadata.list[0] = 'peek-mutation'; undo.after.metadata.nested.x = -1;
      h.commit('p', 'undo');
      const redo = h.peek('p', 'redo');
      assert.equal(redo.before.metadata.list[0], 'initial'); assert.equal(redo.after.metadata.nested.x, 2);
      redo.before.markdown = 'spoof'; h.commit('p', 'redo');
    }
    h.commit('p', 'undo');
    assert.equal(h.record({ pageId: 'p', key: 'b', value: { markdown: 'C', metadata: { list: ['new'], nested: { x: 3 } } }, now: 2 }), true);
    assert.equal(h.getState().redoDepth, 0);
    assert.equal(h.peek('p', 'undo').before.markdown, 'A');
    assert.equal(h.peek('p', 'undo').before.metadata.list[0], 'initial');
    h.commit('p', 'undo');
    assert.equal(h.record({ pageId: 'p', key: 'b', value: { markdown: 'A', metadata: { list: ['initial'], nested: { x: 1 } } }, now: 3 }), false);
    assert.equal(h.peek('p', 'redo').after.markdown, 'C');
    h.setPage('other-owner-page'); assert.equal(h.peek('other-owner-page', 'undo'), null); assert.equal(h.peek('other-owner-page', 'redo'), null);
  });

  test(`6000 deterministic history operations preserve coalescing, budgets, reset, discard and all return values (${nativeClone ? 'native' : 'fallback'})`, () => {
    const random = randomGenerator();
    const histories = ['baseline', 'current'].map(mode => makeHistory(mode, { nativeClone }).create({ maxEntries: 7, maxBytes: 12000, captureTimeout: 100 }));
    let now = 0, pageId = 'p';
    for (let i = 0; i < 6000; i++) {
      const op = Math.floor(random() * 12), key = ['title', 'block:1', 'block:2', '__proto__', '', 'block:3'][Math.floor(random() * 6)];
      now += Math.floor(random() * 150) - 15;
      const value = { markdown: '문자😀<script>' + (i % 9), nested: { list: [i % 7, String(i % 3)] } };
      if (i % 199 === 0) value.markdown = 'oversize'.repeat(3000);
      let method, args;
      if (op <= 4) { method = 'record'; args = [{ pageId, key, value, meta: { id: i % 3 }, captureGroup: i % 2 ? key : 'field:' + key, coalesce: i % 4 !== 0, now }]; }
      else if (op === 5) { method = 'seed'; args = [pageId, key, value]; }
      else if (op === 6 || op === 7) { method = 'commit'; args = [pageId, op === 6 ? 'undo' : 'redo']; }
      else if (op === 8) { method = 'discard'; args = [pageId, i % 2 ? 'undo' : 'redo']; }
      else if (op === 9) { method = 'stopCapturing'; args = []; }
      else if (op === 10) { method = 'setPage'; pageId = random() < .9 ? pageId : pageId === 'p' ? 'q' : 'p'; args = [pageId]; }
      else { method = 'clear'; args = [pageId]; }
      assert.deepEqual(histories[1][method](...structuredClone(args)), histories[0][method](...structuredClone(args)), `${i}: ${method}`);
      assert.deepEqual(histories[1].getState(), histories[0].getState(), `${i}: state`);
      for (const direction of ['undo', 'redo']) assert.deepEqual(histories[1].peek(pageId, direction), histories[0].peek(pageId, direction), `${i}: ${direction}`);
    }
  });
}

test('native exported history has the same observable state as the source harness', () => {
  const a = createEditorHistory(), b = makeHistory().create();
  for (const h of [a, b]) { h.seed('p', 'k', { v: 1 }); h.record({ pageId: 'p', key: 'k', value: { v: 2 }, now: 1 }); h.commit('p', 'undo'); }
  assert.deepEqual(a.peek('p', 'redo'), b.peek('p', 'redo'));
  assert.deepEqual(a.getState(), b.getState());
});

test('1000 restore-only blocks perform zero discarded HTML SHA-256 calculations', () => {
  const input = freeze(manifest({ blocksPerPage: 1000, htmlLength: 20000 }));
  const restored = freeze(regenerated(input));
  const before = makeDiff('baseline', { instrument: true }), after = makeDiff('current', { instrument: true });
  const expected = before.diff(input, restored), actual = after.diff(input, restored);
  assertLegacyDiffPrefix(actual, expected); assert.equal(actual.identical, true); assert.equal(actual.pages.length, 0);
  assert.equal(before.metrics.hashCalls, 2000); assert.equal(before.metrics.hashInputBytes, 40_000_000);
  assert.equal(after.metrics.hashCalls, 0); assert.equal(after.metrics.hashInputBytes, 0);
  assert.deepEqual(diffWorkspaceManifests(input, restored), actual);
});

for (const [field, value] of Object.entries({ type: 'CODE', parent_block_id: 'block_parent', markdown: '새 내용 😀 <img onerror=x>', checked: 1, sort_order: 2048, metadata: '{"note":"중요"}', created_at: '2026-09-15 12:00:00', updated_at: '2026-09-16 11:00:00' })) {
  test(`real block change still retains contextual HTML hash and optimistic version: ${field}`, () => {
    const input = manifest({ htmlLength: 2000 }), changed = regenerated(input);
    changed.data.blocks[0][field] = value;
    const before = makeDiff('baseline', { instrument: true }), after = makeDiff('current', { instrument: true });
    const actual = after.diff(freeze(input), freeze(changed));
    assertLegacyDiffPrefix(actual, before.diff(input, changed));
    assert.deepEqual(after.metrics, before.metrics);
    const fields = actual.pages[0].blocks[0].fields;
    const html = fields.find(item => item.field === 'htmlCache');
    assert.equal(html.snapshot.sha256, createHash('sha256').update(input.data.blocks[0].html_cache).digest('hex'));
    assert.ok(fields.some(item => item.field === 'editVersion'));
    assert.ok(actual.pages[0].fields.some(item => item.field === 'contentVersion'));
  });
}

test('attachment-file changes preserve contextual detail and complete integrity metadata', () => {
  const input = manifest(), changed = regenerated(input);
  changed.attachments.push({ blockId: input.data.blocks[0].id, path: 'file/x', size: 3, sha256: 'digest', crc32: 123 });
  const actual = makeDiff().diff(input, changed);
  assertLegacyDiffPrefix(actual, makeDiff('baseline').diff(input, changed));
  assert.ok(actual.pages[0].blocks[0].fields.some(item => item.field === 'attachmentFile'));
  assert.ok(actual.pages[0].blocks[0].fields.some(item => item.field === 'htmlCache'));
});

for (const [pages, blocksPerPage] of [[1, 501], [201, 3], [205, 0]]) test(`page/block details are complete beyond the former caps (${pages}×${blocksPerPage})`, () => {
  const input = manifest({ pages, blocksPerPage }), changed = regenerated(input);
  for (const block of changed.data.blocks) block.markdown = 'real semantic modification';
  for (const page of changed.data.pages) page.title += ' changed';
  const actual = makeDiff().diff(freeze(input), freeze(changed));
  assertLegacyDiffPrefix(actual, makeDiff('baseline').diff(input, changed));
  assert.equal(actual.summary.pages.modified, pages); assert.equal(actual.summary.blocks.modified, pages * blocksPerPage);
  assert.equal(actual.pages.length, pages);
  assert.equal(actual.pages.reduce((total, page) => total + page.blocks.length, 0), pages * blocksPerPage);
  assert.equal(Object.hasOwn(actual, 'detailsTruncated'), false);
});

test('500 deterministic mixed diff scenarios retain exact fields, excerpts, hashes, versions and workspace identity', () => {
  const random = randomGenerator();
  const before = makeDiff('baseline'), after = makeDiff();
  for (let run = 0; run < 500; run++) {
    const input = manifest({ pages: 1 + run % 4, blocksPerPage: run % 9, htmlLength: run % 17 ? 32 : 2000 });
    const changed = regenerated(input);
    for (const block of changed.data.blocks) {
      if (random() < .2) block.markdown = ['new', '', null, '한😀\ud800<script>'][Math.floor(random() * 5)];
      if (random() < .15) block.metadata = '{"payload":' + JSON.stringify('x'.repeat(run)) + '}';
      if (random() < .1) block.updated_at = '2026-09-17 00:00:00';
      if (random() < .05) block.sort_order = '1024';
    }
    if (random() < .25) changed.data.blocks.pop();
    if (random() < .15 && changed.data.blocks[0]) changed.data.blocks.push({ ...changed.data.blocks[0], id: 'new-block' });
    for (const page of changed.data.pages) {
      if (random() < .2) page.title += ' changed';
      if (random() < .15) changed.data.pageComments.push({ id: 'c' + page.id, page_id: page.id, author_user_id: 'u', author_username: 'writer', body: 'comment 😀', created_at: '2026-09-16', updated_at: '2026-09-16' });
      if (random() < .15) changed.data.pageVersions.push({ page_id: page.id, revision: 1, page_edit_version: 1, page_content_version: 1, actors: '[]', source: 'edit', change_count: 1, change_summary: 'changed', changes: '[]', created_at: '2026-09-16' });
      if (random() < .15) changed.data.navigationCollapsedPageIds.push(page.id);
    }
    if (random() < .15) changed.data.pages.pop();
    if (random() < .1) changed.account.name = 'changed account';
    assertLegacyDiffPrefix(after.diff(freeze(input), freeze(changed)), before.diff(input, changed), `scenario ${run}`);
  }
});
