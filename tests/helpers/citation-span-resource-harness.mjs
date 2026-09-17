// Differential harness against the exact user-supplied archive. The native AI
// module is executed, with only its import URLs and test-only exports changed.
// DOM doubles here are complemented by the real Chromium runner in scripts/.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
export { element, text, link, snapshot, randomGenerator } from './citation-tree-resource-harness.mjs';
import { element, text, link } from './citation-tree-resource-harness.mjs';

export const rootUrl = new URL('../../', import.meta.url);
export const baseline = JSON.parse(readFileSync(new URL('../fixtures/citation-span-resource-baseline.json', import.meta.url), 'utf8'));
export const hash = value => createHash('sha256').update(value).digest('hex');
export function sourceFor(file, mode = 'current') {
  if (mode !== 'baseline') return readFileSync(new URL(file, rootUrl), 'utf8');
  const record = baseline.files[file];
  assert.equal(hash(record.source), record.sha256, 'immutable original source hash');
  return record.source;
}
export function extractFunction(source, name) {
  const match = source.replace(/\r\n/g, '\n').match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}
export function aiModuleSource(mode = 'current', { instrument = false, browser = false } = {}) {
  let source = sourceFor('public/ai-chat-block.js', mode);
  if (instrument) {
    const start = source.indexOf('function collectAiChatCitationGroupUnits(');
    const end = source.indexOf('function isAiChatCitationGroupSeparatorUnits(', start);
    assert.ok(start >= 0 && end > start);
    source = source.slice(0, start)
      + source.slice(start, end).replaceAll('units.push(', 'auditPush(units, ')
      + source.slice(end);
    source = source.replaceAll('value.split("")', 'auditSplit(value)');
  }
  source = source.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g, (_, a, path, b) =>
    a + (browser ? new URL(path, new URL('public/ai-chat-block.js', 'http://fixture.invalid/')).pathname
      : new URL(path, new URL('public/ai-chat-block.js', rootUrl)).href) + b);
  return source + `\nexport const auditMetrics = { groupUnits: 0, splitCodeUnits: 0 };
function auditPush(units, value) { auditMetrics.groupUnits++; return units.push(value); }
function auditSplit(value) { auditMetrics.splitCodeUnits += value.length; return value.split(""); }
export { collectAiChatCitationGroupUnits as collect, collapseAiChatInlineCitationGroupsInBlock as group,
  stripAiChatTrailingReferenceParentheses as wrapper, hydrateRenderedAiChatLinks as hydrate };
export const removeOffsets = typeof removeAiChatTextOffsets === 'function' ? removeAiChatTextOffsets : (value, offsets) => value.split("").filter((_, index) => !offsets.has(index)).join("");\n`;
}
export async function makeAiModule(mode = 'current', options = {}) {
  return import('data:text/javascript;base64,' + Buffer.from(aiModuleSource(mode, options)).toString('base64'));
}
export function appSources(mode = 'current') {
  if (mode === 'baseline') return { ...baseline.files['public/app.js'].functions };
  const source = readFileSync(new URL('public/app.js', rootUrl), 'utf8');
  return Object.fromEntries(['flattenBlocks', 'getCollaborationBlockSignature'].map(name => [name, extractFunction(source, name)]));
}
export function makeSignature(mode = 'current', { instrument = false } = {}) {
  const sources = appSources(mode);
  if (instrument) sources.flattenBlocks = sources.flattenBlocks.replace('result.push({ ...block, depth });', 'metrics.clones++; result.push({ ...block, depth });');
  return new Function(`${Object.values(sources).join('\n')}\nconst metrics = {clones:0};return {signature:getCollaborationBlockSignature,metrics};`)();
}
export function proseFixture(length = 44_000) {
  const value = '한글 abc 😀 '.repeat(Math.ceil(length / 10)).slice(0, length);
  return element('p', [text(value + ' ['), link('1'), text(', '), link('2'), text(']')]);
}
export function wrapperFixture(length = 44_000) {
  return element('p', [text('x'.repeat(length) + ' ('), link('1'), text(')')]);
}
export function blockFixture(count = 5000, { nested = false } = {}) {
  const roots = [], all = [];
  for (let i = 0; i < count; i++) {
    const parent = nested && i % 64 ? all[i - 1] : null;
    const siblings = parent ? parent.children : roots;
    const block = { id: `block-${i}`, type: i % 3 ? 'MARKDOWN' : 'TODO', markdown: `본문 ${i} 😀`, checked: i % 2 === 0,
      parentBlockId: parent?.id ?? null, sortOrder: siblings.length, metadata: { textAlign: 'left', values: [i, null] },
      version: i + 1, contentVersion: i + 3, html: `<p>본문 ${i}</p>`, createdAt: '2026-09-17T00:00:00.000Z',
      updatedAt: '2026-09-17T00:00:01.000Z', children: [] };
    siblings.push(block); all.push(block);
  }
  return roots;
}
export function fromSpec(spec) {
  if (typeof spec === 'string') return text(spec);
  return element(spec.tag, (spec.children ?? []).map(fromSpec), spec.attrs ?? {});
}
export function referenceSpec(number, extra = {}) {
  return {tag:'a', attrs:{href:`https://example.invalid/ref/${number}`, ...extra}, children:[String(number)]};
}
