import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { normalizeTreeViewData as nativeClientNormalize } from '../public/treeview-block.js';
import { normalizeTreeViewData as nativeServerNormalize } from '../src/lib/treeview.ts';
import { setLanguage } from '../public/i18n.js';
import {
  baseline, makeTreeModule, treeFixture, countPathReads,
  randomGenerator, makeMermaidLoader
} from './helpers/cpu-memory-regression-harness.mjs';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

for (const [path, record] of Object.entries(baseline.files)) test(`CPU/memory fixture preserves original bytes: ${path}`, () => {
  assert.equal(createHash('sha256').update(record.source).digest('hex'), record.sha256);
});

for (const side of ['client', 'server']) {
  for (const reverse of [false, true]) test(`${side}: 300-level normalization avoids repeated ancestor walks (${reverse ? 'leaf-first' : 'root-first'})`, () => {
    const before = makeTreeModule('baseline', { side, instrument: true });
    const after = makeTreeModule('current', { side, instrument: true });
    const input = freeze(treeFixture(300, { reverse, notes: true }));
    assert.deepEqual(after.normalize(input), before.normalize(input));
    assert.equal(before.metrics.parentMapGets, 44850);
    assert.equal(before.metrics.setAllocations, 301);
    assert.equal(before.metrics.setInsertions, 45749);
    assert.ok(after.metrics.parentMapGets <= 299, JSON.stringify(after.metrics));
    assert.ok(after.metrics.setAllocations <= 4, JSON.stringify(after.metrics));
    assert.ok(after.metrics.setInsertions <= 1500, JSON.stringify(after.metrics));
  });

  test(`${side}: flat outlines allocate no ancestor cache`, () => {
    const before = makeTreeModule('baseline', { side, instrument: true });
    const after = makeTreeModule('current', { side, instrument: true });
    const input = treeFixture(300);
    for (const node of input.nodes) node.parentId = null;
    assert.deepEqual(after.normalize(input), before.normalize(input));
    assert.deepEqual(after.metrics, before.metrics);
  });

  test(`${side}: all 1,296 four-node parent graphs retain input-order cycle repair`, () => {
    const before = makeTreeModule('baseline', { side });
    const after = makeTreeModule('current', { side });
    const parents = [null, 'missing', 'node-0', 'node-1', 'node-2', 'node-3'];
    for (let graph = 0; graph < parents.length ** 4; graph++) {
      let code = graph;
      const input = treeFixture(4);
      for (const node of input.nodes) { node.parentId = parents[code % parents.length]; code = Math.floor(code / parents.length); }
      assert.deepEqual(after.normalize(freeze(input)), before.normalize(input), `graph ${graph}`);
    }
  });

  test(`${side}: seeded malformed inputs, duplicate IDs, limits, Unicode and frozen metadata have exact parity`, () => {
    const before = makeTreeModule('baseline', { side });
    const after = makeTreeModule('current', { side });
    const random = randomGenerator();
    const invalid = [null, false, 42, [], '', undefined];
    for (let run = 0; run < 600; run++) {
      const input = treeFixture(Math.floor(random() * 90), { reverse: random() < 0.5, notes: true });
      input.title = run % 9 ? `제목 ${run} <script> & 😀` : '긴'.repeat(150);
      for (let i = 0; i < input.nodes.length; i++) {
        const node = input.nodes[i];
        node.parentId = random() < 0.2 ? null : `node-${Math.floor(random() * (input.nodes.length + 5))}`;
        if (random() < 0.08) node.id = ['__proto__', 'constructor', 'prototype', '', ' duplicate ', 'x'.repeat(90)][Math.floor(random() * 6)];
        if (random() < 0.1) node.title = invalid[Math.floor(random() * invalid.length)];
        if (random() < 0.04) node.note = '<svg/onload=alert(1)>\n'.repeat(450);
        if (random() < 0.02) input.nodes[i] = invalid[Math.floor(random() * invalid.length)];
        else node.expanded = random() < 0.5;
      }
      freeze(input);
      assert.deepEqual(after.normalize(input), before.normalize(input), `seeded case ${run}`);
      assert.equal(after.summarize(input), before.summarize(input), `summary ${run}`);
      if (side === 'server' && run < 50) assert.equal(after.render({ treeView: input }), before.render({ treeView: input }));
    }
    for (const input of [...invalid, {}, { nodes: [] }, treeFixture(301), { nodes: [false, null, [], 0] }]) {
      assert.deepEqual(after.normalize(input), before.normalize(input));
    }
    assert.equal({}.polluted, undefined);
  });

  test(`${side}: exact full HTML or visible IDs and 20,000-character summary preservation`, () => {
    const before = makeTreeModule('baseline', { side });
    const after = makeTreeModule('current', { side });
    const input = treeFixture(300, { notes: true, reverse: true });
    input.nodes[0].note = '<script>globalThis.pwned=1</script>\n'.repeat(250);
    input.nodes[40].expanded = false;
    const oldData = before.normalize(input), newData = after.normalize(input);
    assert.deepEqual(newData, oldData);
    assert.equal(after.summarize(input), before.summarize(input));
    assert.equal(after.summarize(input).length, 20000);
    if (side === 'server') {
      const html = after.render({ treeView: input });
      assert.equal(html, before.render({ treeView: input }));
      assert.doesNotMatch(html, /<script>|<svg\b/i);
      assert.match(html, /&lt;script&gt;/);
      assert.match(html, /memo 1/);
    } else assert.deepEqual(after.visible(newData), before.visible(oldData));
  });
}

test('native client ESM and native stripped TypeScript exports match the source-level harness', () => {
  const input = treeFixture(300, { reverse: true });
  assert.deepEqual(nativeClientNormalize(input), makeTreeModule('current').normalize(input));
  assert.deepEqual(nativeServerNormalize(input), makeTreeModule('current', { side: 'server' }).normalize(input));
});

test('selected deep-node path uses one local index rather than 300 repeated array scans', () => {
  const before = makeTreeModule('baseline', { instrument: true });
  const after = makeTreeModule('current', { instrument: true });
  const input = treeFixture(300);
  const oldPath = before.path(countPathReads(input, before.metrics), 'node-299');
  const newPath = after.path(countPathReads(input, after.metrics), 'node-299');
  assert.equal(newPath, oldPath);
  assert.equal(before.metrics.pathIndexReads, 45150);
  assert.equal(after.metrics.pathIndexReads, 600);
  assert.equal(after.metrics.parentMapGets, 299);
});

test('root and missing selections do not allocate an unnecessary ancestor index', () => {
  const before = makeTreeModule('baseline', { instrument: true });
  const after = makeTreeModule('current', { instrument: true });
  const input = treeFixture(300);
  assert.equal(after.path(countPathReads(input, after.metrics), 'node-0'), before.path(countPathReads(input, before.metrics), 'node-0'));
  assert.equal(after.metrics.pathIndexReads, 1);
  assert.equal(after.metrics.parentMapGets, 0);
  assert.equal(after.path(input, 'missing'), '');
});

test('breadcrumb text preserves blank-title numbering and all supported locales after live edits', () => {
  try {
    for (const language of ['en', 'ko', 'ja', 'fr', 'de', 'es', 'pt']) {
      setLanguage(language, { persist: false });
      const before = makeTreeModule('baseline'), after = makeTreeModule('current');
      const input = treeFixture(30);
      for (let i = 0; i < input.nodes.length; i += 3) input.nodes[i].title = '';
      assert.equal(after.path(input, 'node-29'), before.path(input, 'node-29'));
      input.nodes[15].parentId = null;
      input.nodes[22].title = '<img src=x onerror=alert(1)> & 새 제목';
      assert.equal(after.path(input, 'node-29'), before.path(input, 'node-29'));
      input.nodes[20].parentId = 'node-25';
      assert.equal(after.path(input, 'node-29'), before.path(input, 'node-29'), 'cycle guard is retained');
      input.nodes[20].parentId = 'deleted-node';
      assert.equal(after.path(input, 'node-29'), before.path(input, 'node-29'), 'dangling parent terminates');
    }
  } finally { setLanguage('en', { persist: false }); }
});

for (const event of ['error', 'load']) test(`Mermaid: 100 ${event === 'error' ? 'network failures' : 'invalid bundle loads'} release failed scripts and listeners`, async () => {
  for (const mode of ['baseline', 'current']) {
    const loader = makeMermaidLoader(mode);
    for (let attempt = 0; attempt < 100; attempt++) {
      const pending = loader.load();
      loader.scripts.at(-1).dispatch(event);
      await assert.rejects(pending, event === 'error' ? /could not be loaded/ : /did not expose/);
    }
    assert.equal(loader.createdScripts.length, 100, 'retry remains possible');
    assert.equal(loader.scripts.length, mode === 'baseline' ? 100 : 0);
    if (mode === 'current') assert.ok(loader.createdScripts.every(script => script.listenerCount === 0));
  }
});

test('Mermaid: concurrent failures share one request and a subsequent successful retry remains cached', async () => {
  const loader = makeMermaidLoader();
  const first = Array.from({ length: 30 }, () => loader.load());
  assert.equal(loader.scripts.length, 1);
  loader.scripts[0].dispatch('error');
  assert.ok((await Promise.allSettled(first)).every(result => result.status === 'rejected'));
  assert.equal(loader.scripts.length, 0);
  const retry = Array.from({ length: 30 }, () => loader.load());
  const script = loader.scripts[0];
  const api = { initialize() {}, render() {} };
  loader.context.mermaid = api;
  script.dispatch('load');
  assert.ok((await Promise.all(retry)).every(result => result === api));
  assert.equal(script.listenerCount, 0);
  assert.equal(loader.scripts.length, 1, 'successful script retains existing DOM behavior');
  for (let i = 0; i < 100; i++) assert.equal(await loader.load(), api);
  assert.equal(loader.createdScripts.length, 2);
  assert.match(script.src, /^\/vendor\/mermaid\/11\.17\.2\/mermaid\.min\.js$/);
});

test('Mermaid: an already loaded valid API needs no script and failed APIs are not cached', async () => {
  const loader = makeMermaidLoader();
  const api = { initialize() {}, render() {} };
  loader.context.mermaid = api;
  assert.equal(await loader.load(), api);
  assert.equal(loader.createdScripts.length, 0);
});
