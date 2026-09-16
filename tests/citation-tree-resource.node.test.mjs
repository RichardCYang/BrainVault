import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  baseline, makeAiModule, makeTreeValidator, text, element, link, snapshot,
  treeFixture, randomGenerator, outcome
} from './helpers/citation-tree-resource-harness.mjs';

const ai = { baseline: await makeAiModule('baseline'), current: await makeAiModule() };
const trees = { baseline: makeTreeValidator('baseline'), current: makeTreeValidator() };
for (const [file, record] of Object.entries(baseline.files)) test(`attached original source checksum: ${file}`, () => {
  assert.equal(createHash('sha256').update(record.source).digest('hex'), record.sha256);
});
function compareAi(build, operations = ['group', 'wrapper']) {
  const original = build(), current = build();
  for (const operation of operations) {
    ai.baseline[operation](original); ai.current[operation](current);
    assert.deepEqual(snapshot(current), snapshot(original), operation);
  }
  return current;
}
for (const count of [0, 1, 300, 50_000, 500_000]) {
  for (const kind of ['plain', 'one-link', 'split-parentheses']) test(`AI ${kind}, ${count} UTF-16 units: exact DOM and source metadata`, () => {
    const prose = '한글😀 '.repeat(Math.ceil(count / 5)).slice(0, count);
    const block = compareAi(() => element('p', [text(prose), ...(kind === 'plain' ? [] : kind === 'one-link'
      ? [link('1')] : [element('em', [text('(')]), link('1'), element('strong', [text(')！')])])]),
    ['group', 'wrapper', 'group', 'wrapper']);
    assert.ok(block.textContent.startsWith(prose));
  });
}
for (const wrapper of [['[', ']'], ['(', ')'], ['{', '}'], ['( [ ', ' ] )'], ['', '']]) {
  test(`grouped citations preserve wrappers, ordering and Unicode: ${JSON.stringify(wrapper)}`, () => {
    const block = compareAi(() => element('p', [text('A😀e\u0301한글 ' + wrapper[0]),
      link('1'), text(' , '), element('em', [link('[2]')]), text(wrapper[1] + '。')]), ['group', 'wrapper']);
    const first = block.children[0];
    assert.equal(first.aiChatCitationSources.length, 2);
    assert.equal(first.aiChatCitationSources[0].referenceNumber, '1');
    assert.equal(first.aiChatCitationSources[1].referenceNumber, '2');
  });
}
for (const value of ['(\ufffc)', '한글😀 ( \ufffc,\ufffc )！', '\ud800(\ufffc)\udfff', '(\ufffd)', '(1)', '(😀)', '(\ufffc)\n\r', '(\ufffc) trailing']) {
  test(`literal placeholder/barrier/UTF-16 compatibility: ${JSON.stringify(value)}`, () => {
    compareAi(() => element('li', [text(value)]), ['wrapper', 'group', 'wrapper']);
  });
}
test('links and controls behind non-inline barriers cannot create new citation groups', () => {
  for (const tag of ['code', 'pre', 'a', 'button', 'div', 'p', 'li', 'script', 'style', 'textarea']) {
    compareAi(() => element('p', [text('Text ('), element(tag, [link('1'), text(','), link('2')]), text(')')]), ['group', 'wrapper']);
  }
});
test('unsafe URLs, definition links, explicit citation class and duplicate sources keep exact treatment', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@example.invalid', 'https://example.invalid/a', 'http://127.0.0.1/a', 'relative', '']) {
    for (const attributes of [{}, { 'data-ai-chat-source-definition': 'true' }, { class: 'rendered-ai-chat-citation-reference' }]) {
      compareAi(() => element('p', [text('(('), link('1', { href, ...attributes }), text(', '),
        link('2', { href, ...attributes }), text(')) prose')]), ['group', 'wrapper']);
    }
  }
});
test('1500 seeded DOM trees match all original DOM nodes, attributes, sources and repeat-call results', () => {
  const random = randomGenerator();
  const fragments = ['word', '한글😀', '\ud800', '\udfff', '\ufffc', '\ufffd', ' ', '\n', '\u00a0', '\u200b', '(', ')', '[', ']', '{', '}', ',', '；', ':', '！', '\"', ''];
  const tags = ['span', 'em', 'strong', 's', 'del', 'sup', 'code', 'pre', 'div', 'button', 'p', 'li'];
  const makeSpec = depth => Array.from({ length: 1 + Math.floor(random() * 8) }, () => {
    const choice = random();
    if (depth < 3 && choice < .18) return { tag: tags[Math.floor(random() * tags.length)], children: makeSpec(depth + 1) };
    if (choice < .43) return { tag: 'a', children: [{ text: ['1', '[2]', '3', 'nonnumeric', '9999'][Math.floor(random() * 5)] }],
      attrs: { href: random() < .15 ? 'javascript:alert(1)' : 'https://example.invalid/' + Math.floor(random() * 3),
        ...(random() < .15 ? { 'data-ai-chat-source-definition': 'true' } : {}),
        ...(random() < .4 ? { class: 'rendered-ai-chat-citation-reference' } : {}) } };
    return { text: Array.from({ length: Math.floor(random() * 12) }, () => fragments[Math.floor(random() * fragments.length)]).join('') };
  });
  const fromSpec = spec => Object.hasOwn(spec, 'text') ? text(spec.text) : element(spec.tag, spec.children.map(fromSpec), spec.attrs);
  for (let run = 0; run < 1500; run++) {
    const spec = { tag: run % 2 ? 'p' : 'li', children: makeSpec(0) };
    compareAi(() => fromSpec(spec), run % 2 ? ['group', 'wrapper', 'group', 'wrapper'] : ['wrapper', 'group', 'wrapper', 'group']);
  }
});
test('plain 500k-unit paragraphs allocate no group units and one wrapper span, not one million objects', async () => {
  for (const mode of ['baseline', 'current']) {
    const module = await makeAiModule(mode, { instrument: true });
    module.auditMetrics.groupUnits = module.auditMetrics.wrapperUnits = 0;
    const block = element('p', [text('x'.repeat(500_000))]);
    module.group(block); module.wrapper(block);
    assert.deepEqual(module.auditMetrics, mode === 'baseline' ? { groupUnits: 500_000, wrapperUnits: 500_000 } : { groupUnits: 0, wrapperUnits: 1 });
  }
});
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}
for (const shape of ['flat', 'chain', 'reverse', 'balanced']) {
  for (const count of [0, 1, 30, 300]) test(`TREEVIEW ${shape}/${count} validates unchanged frozen metadata`, () => {
    const input = deepFreeze(treeFixture(count, shape));
    assert.deepEqual(outcome(trees.current.validate, input), outcome(trees.baseline.validate, input));
    assert.equal(trees.current.validate(input), input);
  });
}
test('TREEVIEW rejection messages/order remain exact at each integrity/security boundary', () => {
  const invalid = [null, undefined, [], false, 1, '', '{bad}', 'null', '{}', '{} ', { treeView: [] }, treeFixture(301),
    JSON.parse('{"treeView":{"title":"x","nodes":[]},"__proto__":{"polluted":true}}')];
  for (const change of [
    x => { x.treeView.nodes[0].id = '__proto__'; },
    x => { x.treeView.nodes[0].id = 'constructor'; },
    x => { x.treeView.nodes[0].id = 'prototype'; },
    x => { x.treeView.nodes[0].id = ' node '; },
    x => { x.treeView.nodes[0].id = 'x'.repeat(65); },
    x => { x.treeView.nodes[1].id = x.treeView.nodes[0].id; },
    x => { x.treeView.nodes[0].parentId = 'missing'; },
    x => { x.treeView.nodes[0].parentId = 'node-0'; },
    x => { x.treeView.nodes[0].parentId = 'node-299'; },
    x => { x.treeView.nodes[1].parentId = 'node-2'; },
    x => { x.treeView.nodes[0].note = 'n'.repeat(8001); },
    x => { x.treeView.nodes[0].unexpected = true; },
    x => { x.treeView.nodes[0].expanded = 'true'; },
    x => { x.treeView.nodes[0] = null; }
  ]) { const input = treeFixture(); change(input); invalid.push(input); }
  for (const input of invalid) assert.deepEqual(outcome(trees.current.validate, input), outcome(trees.baseline.validate, input));
  assert.equal({}.polluted, undefined);
});
test('3000 seeded valid/malformed parent graphs preserve acceptance and exact errors', () => {
  const random = randomGenerator(0xab51);
  for (let run = 0; run < 3000; run++) {
    const count = Math.floor(random() * 301), input = treeFixture(count);
    input.treeView.nodes.forEach((node, index) => {
      node.parentId = random() < .28 ? null : `node-${Math.floor(random() * (count + 2))}`;
      if (run % 13 === 0 && index === count - 1) node.id = 'node-0';
    });
    const value = run % 3 ? deepFreeze(input) : JSON.stringify(input);
    assert.deepEqual(outcome(trees.current.validate, value), outcome(trees.baseline.validate, value), `case ${run}`);
  }
});
test('an accepted object is revalidated after mutation; no cross-call stale validation cache', () => {
  const input = treeFixture();
  trees.current.validate(input);
  input.treeView.nodes[0].parentId = 'node-299';
  assert.deepEqual(outcome(trees.current.validate, input), outcome(trees.baseline.validate, input));
  assert.equal(outcome(trees.current.validate, input).accepted, false);
  input.treeView.nodes[0].parentId = null;
  assert.equal(trees.current.validate(input), input);
});
test('300-node chains follow 300 rather than 45150 parent edges in either input order', () => {
  for (const shape of ['chain', 'reverse']) {
    const before = makeTreeValidator('baseline', { instrument: true });
    const after = makeTreeValidator('current', { instrument: true });
    before.validate(treeFixture(300, shape)); after.validate(treeFixture(300, shape));
    assert.equal(before.metrics.mapGets, 45_150);
    assert.equal(after.metrics.mapGets, 300);
    assert.ok(after.metrics.setAdds < before.metrics.setAdds / 10);
  }
});
