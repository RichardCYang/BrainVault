// Executes the supplied/current production source, not a reimplementation.
// AI imports remain native ESM. TREEVIEW validation is isolated from unrelated
// Zod/icon policies; calling one of those untested boundaries fails explicitly.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

export const baseline = JSON.parse(readFileSync(new URL('../fixtures/citation-tree-resource-baseline.json', import.meta.url), 'utf8'));
export const rootUrl = new URL('../../', import.meta.url);
export function sourceFor(file, mode = 'current') {
  if (mode !== 'baseline') return readFileSync(new URL(file, rootUrl), 'utf8');
  const record = baseline.files[file];
  assert.equal(createHash('sha256').update(record.source).digest('hex'), record.sha256);
  return record.source;
}
export function aiModuleSource(mode = 'current', { instrument = false, browser = false, memoryProbe = false } = {}) {
  const file = 'public/ai-chat-block.js';
  let source = sourceFor(file, mode);
  if (instrument) {
    for (const [name, next, counter] of [
      ['collectAiChatCitationGroupUnits', 'isAiChatCitationGroupSeparatorUnits', 'groupUnits'],
      ['collectAiChatReferenceWrapperUnits', mode === 'baseline' ? 'stripAiChatTrailingReferenceParentheses' : 'getAiChatReferenceWrapperPoint', 'wrapperUnits']
    ]) {
      const start = source.indexOf(`function ${name}(`), end = source.indexOf(`function ${next}(`, start);
      assert.ok(start >= 0 && end > start);
      const section = source.slice(start, end).replaceAll('units.push(', `auditPush('${counter}', units, `);
      source = source.slice(0, start) + section + source.slice(end);
    }
  }
  if (memoryProbe) {
    for (const name of ['collectAiChatCitationGroupUnits', 'collectAiChatReferenceWrapperUnits']) {
      source = source.replace(`${name}(block, units);`, `${name}(block, units); auditHeapProbe();`);
    }
  }
  source = source.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g, (_, a, path, b) =>
    a + (browser ? new URL(path, new URL(file, 'http://fixture.invalid/')).pathname : new URL(path, new URL(file, rootUrl)).href) + b);
  return source + `\nexport const auditMetrics = { groupUnits: 0, wrapperUnits: 0 };
function auditPush(key, units, value) { auditMetrics[key]++; return units.push(value); }
export const auditHeapSamples = [];
function auditHeapProbe() { globalThis.gc(); auditHeapSamples.push(process.memoryUsage().heapUsed); }
export { collapseAiChatInlineCitationGroupsInBlock as group, stripAiChatTrailingReferenceParentheses as wrapper };
`;
}
export async function makeAiModule(mode = 'current', options = {}) {
  return import('data:text/javascript;base64,' + Buffer.from(aiModuleSource(mode, options)).toString('base64'));
}
export function makeTreeValidator(mode = 'current', { instrument = false } = {}) {
  let source = stripTypeScriptTypes(sourceFor('src/lib/structured-metadata-integrity.ts', mode));
  source = source.replace(/^import[\s\S]*?;\r?$/gm, '').replace(/^export /gm, '');
  const metrics = { mapGets: 0, setConstructions: 0, setAdds: 0 };
  class CountingMap extends Map { get(key) { metrics.mapGets++; return super.get(key); } }
  class CountingSet extends Set {
    constructor(values) { super(values); metrics.setConstructions++; }
    add(value) { metrics.setAdds++; return super.add(value); }
  }
  const outsideScope = () => { throw new Error('This harness only exercises the TREEVIEW integrity boundary'); };
  const validate = new Function('Map', 'Set', 'getAiChatAnswerMaxLength', 'metadataSchema',
    'assertLosslessAttachmentMetadata', 'AttachmentMetadataIntegrityError', 'normalizeCodeLanguage',
    'isPrivateOrLocalHostname', 'isValidIconValue', source + '\nreturn metadata => assertStructuredBlockMetadataIntegrity("TREEVIEW", metadata);')(
      instrument ? CountingMap : Map, instrument ? CountingSet : Set, () => 50_000,
      { safeParse: outsideScope }, outsideScope, class extends Error {}, outsideScope, outsideScope, outsideScope);
  for (const key of Object.keys(metrics)) metrics[key] = 0;
  return { validate, metrics };
}
export function text(value) { return { nodeType: 3, nodeValue: String(value), parentNode: null }; }
export function element(tagName, children = [], attributes = {}) {
  const attrs = { ...attributes };
  const node = {
    nodeType: 1, tagName: tagName.toUpperCase(), childNodes: [], parentNode: null, dataset: {},
    get children() { return this.childNodes.filter(child => child.nodeType === 1); },
    get parentElement() { return this.parentNode; },
    get textContent() { return this.childNodes.map(child => child.nodeType === 3 ? child.nodeValue : child.textContent).join(''); },
    get href() { return attrs.href; },
    getAttribute(name) { return attrs[name] ?? null; },
    setAttribute(name, value) { attrs[name] = String(value); },
    classList: { contains(name) { return String(attrs.class ?? '').split(/\s+/).includes(name); } },
    remove() {
      if (!this.parentNode) return;
      const list = this.parentNode.childNodes; list.splice(list.indexOf(this), 1); this.parentNode = null;
    },
    auditAttributes: attrs
  };
  for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) {
    node.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
  }
  for (const child of children) { node.childNodes.push(child); child.parentNode = node; }
  return node;
}
export function link(label = '1', attributes = {}) {
  return element('a', [text(label)], { href: `https://example.invalid/source/${label}`, ...attributes });
}
export function snapshot(node) {
  if (node.nodeType === 3) return { text: node.nodeValue };
  return { tag: node.tagName, attributes: node.auditAttributes, sources: node.aiChatCitationSources ?? null,
    children: node.childNodes.map(snapshot) };
}
export function treeFixture(count = 300, shape = 'chain') {
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `node-${i}`, parentId: i && shape !== 'flat' ? `node-${shape === 'balanced' ? Math.floor((i - 1) / 2) : i - 1}` : null,
    title: `항목 ${i} 😀`, note: 'unchanged memo', expanded: true
  }));
  if (shape === 'reverse') nodes.reverse();
  return { treeView: { title: '검증', nodes } };
}
export function randomGenerator(seed = 0x571b9) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
}
export function outcome(validate, input) {
  try { return { accepted: true, value: validate(input) }; }
  catch (error) { return { accepted: false, name: error.name, message: error.message, path: error.path, reason: error.reason }; }
}
