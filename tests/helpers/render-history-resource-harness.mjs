import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

// These fixtures are exact uploaded sources, not reconstructed slow variants.
export const baseline = JSON.parse(readFileSync(new URL('../fixtures/render-history-resource-baseline.json', import.meta.url), 'utf8'));
export function sourceFor(path, mode = 'current') {
  return mode === 'baseline' ? baseline.files[path].source : readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
}

export function makeHistory(mode = 'current', { instrument = false, nativeClone = true } = {}) {
  const metrics = { clones: 0, clonedJsonBytes: 0 };
  const measure = value => {
    if (instrument) { metrics.clones++; metrics.clonedJsonBytes += Buffer.byteLength(JSON.stringify(value) ?? 'null'); }
    return structuredClone(value);
  };
  let source = sourceFor('public/editor-history.js', mode).replace(/^export /gm, '');
  // Count the actual fallback parse/clone boundary without substituting semantics.
  const json = nativeClone ? JSON : { ...JSON, stringify: JSON.stringify, parse: text => {
    if (instrument) { metrics.clones++; metrics.clonedJsonBytes += Buffer.byteLength(text); }
    return JSON.parse(text);
  } };
  const factory = new Function('structuredClone', 'JSON', source + '\nreturn createEditorHistory;');
  return { create: factory(nativeClone ? measure : undefined, json), metrics };
}

export function makeDiff(mode = 'current', { instrument = false } = {}) {
  const metrics = { hashCalls: 0, hashInputBytes: 0 };
  let source = stripTypeScriptTypes(sourceFor('src/lib/workspace-snapshot-diff.ts', mode))
    .replace(/^import[^\n]*;\r?$/gm, '').replace(/^export /gm, '');
  const hash = (...args) => {
    const result = createHash(...args);
    if (!instrument) return result;
    metrics.hashCalls++;
    const update = result.update;
    result.update = function(value, encoding) {
      metrics.hashInputBytes += typeof value === 'string' ? Buffer.byteLength(value, encoding) : value.byteLength;
      return update.call(this, value, encoding);
    };
    return result;
  };
  return { diff: new Function('createHash', source + '\nreturn diffWorkspaceManifests;')(hash), metrics };
}

export function manifest({ pages = 1, blocksPerPage = 1, htmlLength = 32 } = {}) {
  const ts = '2026-09-16 00:00:00.000000';
  const pageRows = Array.from({ length: pages }, (_, i) => ({
    id: 'page_' + String(i).padStart(5, '0'), title: '노트 ' + i, icon: '🧠', cover_url: null,
    cover_position_x: 50, cover_position_y: 50, is_archived: 0, is_collection: 0,
    parent_page_id: null, edit_version: 1, content_version: 1, created_at: ts, updated_at: ts
  }));
  return {
    format: 'brainvault-backup', version: 4, exportedAt: '2026-09-16T00:00:00.000Z',
    source: { userId: 'user_a', username: 'audit' },
    account: { name: 'Audit', avatar_data: null, preferred_language: 'ko', default_collection_icon: '📁', theme: 'light' },
    data: {
      pages: pageRows,
      blocks: pageRows.flatMap((page, p) => Array.from({ length: blocksPerPage }, (_, b) => ({
        id: 'block_' + String(p).padStart(5, '0') + '_' + String(b).padStart(5, '0'), page_id: page.id,
        parent_block_id: null, type: 'PARAGRAPH', markdown: '원문 ' + b, html_cache: 'a'.repeat(htmlLength),
        checked: 0, sort_order: (b + 1) * 1024, metadata: null, edit_version: 1, created_at: ts, updated_at: ts
      }))),
      tags: [], pageTags: [], pageShares: [], pageComments: [], pageVersions: [],
      navigationPageOrder: [], navigationCollapsedPageIds: []
    },
    attachments: [], pageCovers: [], retainedAttachments: [], customIcons: [], customIconLibraryRemovals: []
  };
}

export function regenerated(manifestValue) {
  const result = structuredClone(manifestValue);
  for (const block of result.data.blocks) { block.html_cache = 'b'.repeat(block.html_cache.length); block.edit_version = 20; }
  for (const page of result.data.pages) { page.edit_version = 20; page.content_version = 20; }
  return result;
}
export function randomGenerator(seed = 0xC0961601) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
