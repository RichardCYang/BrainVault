import { readFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { createPageDraftStore } from '../../public/draft-store.js';

// Exact uploaded function bodies, not synthetic implementations of a slow path.
export const baseline = JSON.parse(readFileSync(new URL('../fixtures/render-draft-asset-resource-baseline.json', import.meta.url), 'utf8'));
const app = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
export function extractFunction(source, name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'));
  if (!match) throw new Error(`Missing function: ${name}`);
  return match[0];
}
export function sourceFor(name, mode = 'current') {
  return mode === 'baseline' ? baseline.functions[name].source : extractFunction(app, name);
}

export function draftRecord(count, { userId = 'user-a', pageId = 'page-a', sourceId = 'source-a', textLength = 32, offset = 0 } = {}) {
  const blocks = Object.create(null);
  for (let i = 0; i < count; i++) {
    blocks[`block-${i + offset}`] = {
      payload: { type: 'MARKDOWN', markdown: `${i}: 한글 😀 <script> & ${'x'.repeat(textLength)}`, checked: i % 2 === 0,
        metadata: { nested: { value: i }, label: '<img src=x onerror=alert(1)>' } },
      revision: i + 1, expectedVersion: i + 2, updatedAt: 1789550000000
    };
  }
  return { schemaVersion: 2, userId, pageId, sourceId, updatedAt: 1789550000000, title: null, blocks, blockOrder: null };
}
export const storageKey = (record) => `brainvault.pageDraft.v2:${encodeURIComponent(record.userId)}:${encodeURIComponent(record.pageId)}:${encodeURIComponent(record.sourceId)}`;

export function makeDraftHarness(mode = 'current', records = []) {
  const values = new Map(records.map(record => [storageKey(record), JSON.stringify(record)]));
  const metrics = { reads: 0, readBytes: 0, writes: 0, removals: 0 };
  const storage = {
    get length() { return values.size; },
    key(i) { return [...values.keys()][i] ?? null; },
    getItem(key) {
      metrics.reads++;
      const value = values.get(key) ?? null;
      if (value !== null) metrics.readBytes += Buffer.byteLength(value);
      return value;
    },
    setItem(key, value) { metrics.writes++; values.set(key, String(value)); },
    removeItem(key) { metrics.removals++; values.delete(key); }
  };
  const store = createPageDraftStore(storage, { sourceId: 'source-a' });
  const factory = new Function('pageDraftStore', `
    const state = { user: { id: 'user-a' }, selectedPage: null, workspaceView: 'page', applyingCollaborationSnapshot: false };
    const blockDraftConflictOrigins = new Map(), blockDraftRenderSources = new Map();
    const pageDraftSourceId = 'source-a';
    const events = [], rendered = [], frames = [];
    const element = () => ({ dataset: {}, value: '', textContent: '',
      classList: { toggle() {}, contains() { return false; }, add() {} }, setAttribute() {}, removeAttribute() {} });
    const elements = Object.fromEntries(['blockList','sidebarHomeShortcut','welcomeView','collectionView','pageViewHeader','pageView','pageTitle','pageKicker','pageIconButton','blockCount'].map(k => [k, element()]));
    elements.blockList.replaceChildren = () => { rendered.length = 0; };
    elements.blockList.append = row => { rendered.push(row); };
    const pageEditorHistory = { setPage: id => events.push(['history', id]) };
    let pageTitleDraftConflict = false, pageTitleEditRevision = 0, pageTitleSavedRevision = 0, pageTitleLastDurableValue = '';
    const isCollaborativePage = page => Boolean((page ?? state.selectedPage)?.collaborative);
    const isPageReadOnly = () => true;
    const normalizePageTitle = value => value.trim() || 'untitled';
    const formatDate = value => value, formatNumber = value => String(value), t = (key, args) => key + JSON.stringify(args ?? {});
    const makeEmptyMessage = value => ({ ...element(), textContent: value });
    const renderBlock = (block, draft) => ({ id: block.id, draft });
    const requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    ${['closeBlockContextMenu','closePageActionsMenu','syncWorkspaceLocation','renderSubpageIndex','syncWorkspaceNavigationSelection','renderCollaborationChrome','renderCollectionView','renderHome','renderPageHeader','renderPageCover','renderIconValue','renderPageComments','syncPageModeUi','refreshCollaborativePageDraftRecovery','hydrateMathExpressions','hydrateMermaidPreviews','hydrateHighlightedCodeBlocks','hydrateAccordionIcons','focusPendingBlock','syncVisibleBlocksToState'].map(name => `const ${name} = (...args) => { events.push('${name}'); };`).join('\n')}
    ${extractFunction(app, 'flattenBlocks')}
    ${sourceFor('getBlockRenderDraft', mode)}
    ${sourceFor('renderSelectedPage', mode)}
    return { state, elements, rendered, events, frames, sources: blockDraftRenderSources, conflicts: blockDraftConflictOrigins,
      get: getBlockRenderDraft, render: renderSelectedPage };
  `);
  const harness = factory(store);
  harness.state.selectedPage = { id: 'page-a', title: '노트', updatedAt: '2026-09-16', blocks: [] };
  for (const record of records) {
    if (record.pageId !== 'page-a' || record.userId !== 'user-a') continue;
    for (const id of Object.keys(record.blocks)) {
      if (!harness.sources.has(id)) harness.state.selectedPage.blocks.push({ id, type: 'MARKDOWN', markdown: 'server', children: [] });
      harness.sources.set(id, record.sourceId);
    }
  }
  return Object.assign(harness, { values, metrics, store, storage,
    resetMetrics() { for (const key of Object.keys(metrics)) metrics[key] = 0; },
    put(record) { values.set(storageKey(record), JSON.stringify(record)); }
  });
}

export class TestAsset extends EventTarget {
  constructor({ complete = false, loaded = false, decode } = {}) {
    super(); this.complete = complete; this.dataset = loaded ? { mermaidLoaded: 'true' } : {};
    this.attributes = new Map(); this.decode = decode;
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  get listenerCount() { return getEventListeners(this, 'load').length + getEventListeners(this, 'error').length; }
  fire(type) { this.dispatchEvent(new Event(type)); }
}
export async function drainMicrotasks() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
export function makeAssetHarness(mode = 'current', { images = [], frames = [], fonts = Promise.resolve() } = {}) {
  let now = 0, id = 0;
  const timers = new Map(), delays = [];
  const window = {
    setTimeout(callback, delay) { delays.push(delay); timers.set(++id, { callback, at: now + delay }); return id; },
    clearTimeout(timer) { timers.delete(timer); }
  };
  const pageView = { querySelectorAll(selector) { return selector === 'img' ? images : frames; } };
  const wait = new Function('elements', 'document', 'window', `${sourceFor('waitForPdfExportAssets', mode)}\nreturn waitForPdfExportAssets;`)(
    { pageView }, { fonts: fonts === undefined ? undefined : { ready: fonts } }, window);
  return { wait, images, frames, timers, delays, pageView,
    listeners: () => [...images, ...frames].reduce((sum, asset) => sum + asset.listenerCount, 0),
    async advance(ms) {
      now += ms;
      for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback(); }
      await drainMicrotasks();
    }
  };
}
export function randomGenerator(seed = 0xC0916D12) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
