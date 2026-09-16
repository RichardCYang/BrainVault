// Test-only whole-module loader. Production functions are not rewritten; native
// Map/Set subclasses count their operations. Imports and UUIDs are explicit.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { formatNumber, t } from '../../public/i18n.js';
import { BLOCK_MARKDOWN_MAX_LENGTH } from '../../public/editor-content-limits.js';

export const baseline = JSON.parse(readFileSync(new URL('../fixtures/cpu-memory-regression-baseline.json', import.meta.url), 'utf8'));
export function sourceFor(path, mode = 'current') {
  return mode === 'baseline' ? baseline.files[path].source
    : readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}
export function makeTreeModule(mode = 'current', { side = 'client', instrument = false } = {}) {
  const path = side === 'server' ? 'src/lib/treeview.ts' : 'public/treeview-block.js';
  let source = sourceFor(path, mode);
  if (side === 'server') source = stripTypeScriptTypes(source);
  source = source.replace(/^import[^\n]*;\r?$/gm, '').replace(/^export /gm, '');
  const metrics = { parentMapGets: 0, setAllocations: 0, setInsertions: 0, pathIndexReads: 0 };
  class CountedMap extends Map {
    get(key) { metrics.parentMapGets++; return super.get(key); }
  }
  class CountedSet extends Set {
    constructor(values) { super(values); metrics.setAllocations++; }
    add(value) { metrics.setInsertions++; return super.add(value); }
  }
  let ids = 0;
  const context = { crypto: { randomUUID: () => `cpu-memory-fixture-${++ids}` } };
  const api = new Function('t', 'formatNumber', 'globalThis', 'Map', 'Set', source + `\nreturn {
    normalize: normalizeTreeViewData, summarize: summarizeTreeViewData,
    ${side === 'server' ? 'render: renderTreeViewHtml, get: getTreeViewData' : 'path: getNodePath, visible: getVisibleNodeIds'}
  };`)(t, formatNumber, context, instrument ? CountedMap : Map, instrument ? CountedSet : Set);
  return { ...api, metrics };
}
export function treeFixture(count = 300, { reverse = false, notes = false } = {}) {
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `node-${i}`, parentId: i ? `node-${i - 1}` : null,
    title: `항목 ${i} <&> 😀`, note: notes ? `memo ${i}\n<script>not executable</script>` : '', expanded: true
  }));
  return { title: 'Deep outline', nodes: reverse ? nodes.reverse() : nodes };
}
export function countPathReads(data, metrics) {
  return { ...data, nodes: new Proxy(data.nodes, {
    get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) metrics.pathIndexReads++;
      return Reflect.get(target, key, receiver);
    }
  }) };
}
export function randomGenerator(seed = 0x9162026) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

// Minimal event/DOM double for the loader lifecycle only. The separate Chromium
// script exercises renderMermaidPreview, real scripts, native ESM and sandboxing.
export function makeMermaidLoader(mode = 'current') {
  const scripts = [], createdScripts = [];
  const context = {};
  class Script {
    dataset = {};
    listeners = new Map();
    addEventListener(type, callback, options = {}) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push({ callback, once: options.once });
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, callback) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry.callback !== callback));
    }
    dispatch(type) {
      for (const { callback, once } of [...(this.listeners.get(type) ?? [])]) {
        if (once) this.removeEventListener(type, callback);
        callback({ type, target: this });
      }
    }
    remove() { const index = scripts.indexOf(this); if (index >= 0) scripts.splice(index, 1); }
    get listenerCount() { return [...this.listeners.values()].reduce((count, list) => count + list.length, 0); }
  }
  const document = {
    head: { append(script) { scripts.push(script); } },
    createElement(tag) {
      if (tag !== 'script') throw new Error(`Unexpected loader element: ${tag}`);
      const script = new Script(); createdScripts.push(script); return script;
    }
  };
  const source = sourceFor('public/mermaid-block.js', mode)
    .replace(/^import[^\n]*;\r?$/gm, '').replace(/^export /gm, '');
  const api = new Function('globalThis', 'document', 'BLOCK_MARKDOWN_MAX_LENGTH', source + '\nreturn {load: loadMermaid};')(
    context, document, BLOCK_MARKDOWN_MAX_LENGTH
  );
  return { ...api, scripts, createdScripts, context };
}
