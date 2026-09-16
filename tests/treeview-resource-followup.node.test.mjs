import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { baseline, makeTreeModule, treeFixture, randomGenerator } from './helpers/resource-followup-harness.mjs';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

for (const [name, record] of Object.entries(baseline.files)) test(`audit fixture retains exact original ${name} bytes`, () => {
  assert.equal(createHash('sha256').update(record.source).digest('hex'), record.sha256);
});

for (const side of ['server', 'client']) {
  for (const shape of ['flat', 'balanced', 'chain']) {
    for (const count of [0, 1, 25, 300]) test(`${side} tree ${shape}/${count}: exact summary, normalization and immutable input`, () => {
      const input = freeze(treeFixture(count, { shape, noteLength: 77 }));
      const a = makeTreeModule('baseline', { side }), b = makeTreeModule('current', { side });
      assert.deepEqual(b.normalize(input), a.normalize(input));
      assert.equal(b.summarize(input), a.summarize(input));
      if (side === 'server') assert.equal(b.render({ treeView: input }), a.render({ treeView: input }));
      else assert.deepEqual(b.visible(b.normalize(input)), a.visible(a.normalize(input)));
    });
  }
  for (const totalLength of [19999, 20000, 20001]) test(`${side} summary: exact UTF-16 prefix at ${totalLength} code units`, () => {
    const lastLength = totalLength - 16017;
    const notes = ['x'.repeat(8000), 'y'.repeat(8000), 'z'.repeat(lastLength - 2) + '😀'];
    const input = { title: '', nodes: notes.map((note, i) => ({ id: 'n' + i, parentId: null, title: '', note })) };
    const full = notes.map(note => '- \n  ' + note).join('\n');
    assert.equal(full.length, totalLength);
    const a = makeTreeModule('baseline', { side }), b = makeTreeModule('current', { side });
    assert.equal(a.summarize(input), full.slice(0, 20000));
    assert.equal(b.summarize(input), full.slice(0, 20000));
  });
  test(`${side} large notes: only summary is truncated; complete memo metadata survives`, () => {
    const input = treeFixture(300, { noteLength: 8000 });
    const a = makeTreeModule('baseline', { side, instrument: true });
    const b = makeTreeModule('current', { side, instrument: true });
    assert.equal(b.summarize(input), a.summarize(input));
    assert.ok(a.metrics.fullSummaryCodeUnits > 2_400_000);
    assert.equal(b.metrics.fullSummaryCodeUnits, 0);
    assert.equal(b.metrics.childComparisons, 0);
    assert.equal(b.metrics.childIndexVisits, 300);
    assert.deepEqual(b.normalize(input), a.normalize(input));
    assert.equal(b.normalize(input).nodes.reduce((sum, node) => sum + node.note.length, 0), 2_400_000);
  });
  test(`${side} 500 deterministic malformed/random hierarchies match the original`, () => {
    const random = randomGenerator();
    for (let run = 0; run < 500; run += 1) {
      const count = Math.floor(random() * 36);
      const ids = Array.from({ length: count }, (_, i) => i % 13 === 0 ? '__proto__' : 'n' + i);
      const input = { title: run % 5 ? 'title\n<&>😀' : '', nodes: ids.map((id, i) => ({
        id: run % 7 === 0 && i > 1 ? ids[i - 1] : id,
        parentId: random() < .25 ? null : random() < .1 ? 'missing' : ids[Math.floor(random() * count)],
        title: random() < .1 ? 123 : random() < .2 ? '' : 'node ' + i + ' <script> & 😀',
        note: random() < .15 ? null : random() < .2 ? '   ' : 'memo\n\n' + i + '\u0000<&>',
        expanded: random() > .3
      })) };
      if (run % 11 === 0) input.nodes.push(null, [], 1, 'text');
      const a = makeTreeModule('baseline', { side }), b = makeTreeModule('current', { side });
      assert.deepEqual(b.normalize(input), a.normalize(input), `normalization case ${run}`);
      assert.equal(b.summarize(input), a.summarize(input), `summary case ${run}`);
      if (side === 'server') assert.equal(b.render({ treeView: input }), a.render({ treeView: input }), `HTML case ${run}`);
      else assert.deepEqual(b.visible(b.normalize(input)), a.visible(a.normalize(input)), `visible case ${run}`);
    }
  });
  test(`${side} untrusted size limits, missing data and duplicate IDs are unchanged`, () => {
    for (const input of [undefined, null, false, [], {}, { nodes: [] }, {
      title: '<'.repeat(200), nodes: Array.from({ length: 310 }, () => ({
        id: 'x'.repeat(100), parentId: '__proto__', title: 't'.repeat(400), note: 'n'.repeat(9000), expanded: false
      }))
    }]) {
      const a = makeTreeModule('baseline', { side }), b = makeTreeModule('current', { side });
      assert.deepEqual(b.normalize(input), a.normalize(input));
      assert.equal(b.summarize(input), a.summarize(input));
      if (side === 'server') assert.equal(b.render({ treeView: input }), a.render({ treeView: input }));
    }
  });
}

test('server render indexes children once and does not rebuild 300 ID maps', () => {
  const input = treeFixture(300, { noteLength: 32 });
  const a = makeTreeModule('baseline', { instrument: true }), b = makeTreeModule('current', { instrument: true });
  assert.equal(b.render({ treeView: input }), a.render({ treeView: input }));
  assert.equal(a.metrics.childComparisons, 90300);
  assert.equal(a.metrics.pathIndexVisits, 90000);
  assert.equal(b.metrics.childComparisons, 0);
  assert.equal(b.metrics.childIndexVisits, 300);
  assert.equal(b.metrics.pathIndexVisits, 300);
});

test('static HTML continues to escape executable strings and preserves every memo', () => {
  const b = makeTreeModule();
  const input = { title: '<script>alert(1)</script>', nodes: [
    { id: '__proto__', parentId: null, title: '<img src=x onerror=alert(1)>', note: '<svg/onload=alert(2)>\n& " \'\n끝', expanded: false },
    { id: 'constructor', parentId: '__proto__', title: 'child', note: 'full memo', expanded: false }
  ] };
  const a = makeTreeModule('baseline');
  const html = b.render({ treeView: input });
  assert.equal(html, a.render({ treeView: input }));
  assert.doesNotMatch(html, /<(?:script|img|svg)\b/i);
  assert.match(html, /&lt;svg\/onload/);
  assert.match(html, /full memo/);
  assert.match(html, /&amp; &quot; &#39;/);
  assert.equal({}.polluted, undefined);
});

test('metadata strings, malformed JSON and nested normalization have exact server output', () => {
  const values = [undefined, null, '', '{bad}', '[]', 'null', 42,
    JSON.stringify({ treeView: treeFixture(12, { shape: 'balanced', noteLength: 100 }) })];
  for (const value of values) {
    const a = makeTreeModule('baseline'), b = makeTreeModule('current');
    assert.deepEqual(b.get(value), a.get(value));
    assert.equal(b.render(value), a.render(value));
  }
});
