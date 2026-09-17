import { readFileSync } from 'node:fs';

export const baseline = JSON.parse(readFileSync(new URL('../fixtures/rendered-row-resource-baseline.json', import.meta.url), 'utf8'));

export function rowSources(mode = 'current') {
  const app = mode === 'baseline' ? null : readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
  return Object.fromEntries(Object.entries(baseline.records).map(([name, record]) => {
    if (!app) return [name, record.source];
    const start = app.indexOf(record.start), end = app.indexOf(record.end, start + 1);
    if (start < 0 || end < 0) throw Error(`Missing source markers: ${name}`);
    return [name, app.slice(start, end)];
  }));
}

// The factory is also executed in Chromium with real elements. Only application
// boundaries (save transport, authentication scope and preview dispatch) are spies.
// No production lookup, conflict gate or activation code is rewritten.
export function createRowHarnessFromSource(sources, options = {}) {
  const metrics = { allQueries: 0, singleQueries: 0, listedRows: 0, yieldedRows: 0, idReads: 0 };
  const events = [], timers = new Map();
  let nextTimerId = 1;
  const classList = () => {
    const values = new Set();
    return { add: (...items) => items.forEach(item => values.add(item)), contains: item => values.has(item),
      remove: (...items) => items.forEach(item => values.delete(item)), values: () => [...values] };
  };
  const row = (id, conflict = false) => {
    const dataset = { draftConflict: conflict ? 'true' : 'false' };
    Object.defineProperty(dataset, 'blockId', { enumerable: true, get() { metrics.idReads++; return id; } });
    return { _id: id, dataset, classList: classList() };
  };
  let rows = options.rows ?? Array.from({ length: options.count ?? 0 }, (_, index) => row(`b_${index}`));
  const blockList = options.blockList ?? {
    querySelectorAll(selector) {
      if (selector !== '.editor-block-row[data-block-id]') throw Error(`Unexpected selector: ${selector}`);
      metrics.allQueries++;
      const snapshot = rows.slice();
      metrics.listedRows += snapshot.length;
      return { *[Symbol.iterator]() { for (const item of snapshot) { metrics.yieldedRows++; yield item; } } };
    },
    querySelector(selector) {
      metrics.singleQueries++;
      const match = /^\.editor-block-row\[data-block-id="([A-Za-z0-9_-]+)"\]$/.exec(selector);
      if (!match) throw Error(`Unsafe selector reached native lookup: ${selector}`);
      return rows.find(item => item._id === match[1]) ?? null;
    }
  };
  const elements = { blockList, pageTitle: options.pageTitle ?? { classList: classList() } };
  const state = options.state ?? { selectedPage: { id: 'page-a', blocks: rows.map(item => ({ id: item._id, htmlCache: 'old', children: [] })) } };
  const origins = new Map(options.origins ?? []);
  const blockSaveRows = new Map(), blockSaveTimers = new Map(), blockEditAuthenticationScopes = new Map(), blockDraftRenderSources = new Map();
  const scope = { generation: options.generation ?? 1, userId: 'user-a', pageId: 'page-a' };
  const record = (name, ...args) => events.push([name, ...args]);
  const dependencies = {
    elements, state, blockDraftConflictOrigins: origins, blockSaveRows, blockSaveTimers, blockEditAuthenticationScopes, blockDraftRenderSources,
    flattenBlocks(blocks) { return blocks.flatMap(block => [block, ...dependencies.flattenBlocks(block.children ?? [])]); },
    updateRenderedBlockPreview(target, block) { record('preview', target.dataset.blockId, block.id, block.htmlCache); options.updatePreview?.(target, block); },
    pageDraftSourceId: 'current-tab',
    pageTitleEditRevision: 0, pageTitleSavedRevision: 0, pageTitleDraftExpectedVersion: null, pageTitleDraftConflict: false,
    pageTitleConflictOrigin: null, pageTitleDraftSourceId: null, pageTitleEditAuthenticationScope: null, pageTitleSaveTimer: null,
    pendingBlockOrderTask: null, blockOrderSaving: false,
    persistPageTitleDraft() { record('persist-title'); },
    persistBlockDraft(target) { record('persist-block', target.dataset.blockId, { ...target.dataset }); if (options.failPersistence) throw Error('persistence failed'); },
    captureAuthenticatedSessionScope() { record('capture-scope'); return { ...scope }; },
    assertCurrentAuthenticatedSessionScope(value) { record('assert-scope', value); if (options.invalidScope) throw Error('stale authentication scope'); },
    window: { setTimeout(callback, delay) { const id = nextTimerId++; timers.set(id, { callback, delay }); record('timer', id, delay); return id; } },
    savePageTitleNow() { record('save-title'); return Promise.resolve(); },
    saveBlockRow(target, settings) { record('save-block', target.dataset.blockId, settings); return Promise.resolve(); },
    createBlockOrderTask(parentId, orderedIds, flags, settings) { record('create-order', parentId, orderedIds, flags, settings); return { ...settings, parentId, orderedIds }; },
    persistBlockOrderDraft(task) { record('persist-order', task); },
    retryPendingBlockOrder() { record('retry-order'); return Promise.resolve(); },
    appendDraftRecoveryPanel(recovery) { record('recovery-panel', recovery.missing, recovery.orderConflicts, recovery.alternates); },
    syncBeforeUnloadProtection() { record('beforeunload'); },
    setStatus(message, failed) { record('status', message, failed); },
    t(key) { return key; }
  };
  const api = new Function(...Object.keys(dependencies), Object.values(sources).join('\n') + `
    return {
      find: findRenderedBlockRow,
      conflicts: blockSnapshotHasUnresolvedDraftConflict,
      materialize: applyMaterializedHtmlCaches,
      activate: activatePersistedPageDraft,
      batch: typeof createRenderedBlockRowLookup === 'function' ? createRenderedBlockRowLookup : () => findRenderedBlockRow,
      titleState: () => ({pageTitleEditRevision, pageTitleSavedRevision, pageTitleDraftExpectedVersion,
        pageTitleDraftConflict, pageTitleConflictOrigin, pageTitleDraftSourceId, pageTitleEditAuthenticationScope, pageTitleSaveTimer}),
      orderState: () => ({pendingBlockOrderTask, blockOrderSaving})
    };`)(...Object.values(dependencies));
  return {
    ...api, metrics, events, timers, origins, state, elements, scope, blockSaveRows, blockSaveTimers, blockEditAuthenticationScopes, blockDraftRenderSources,
    makeRow: row, get rows() { return rows; }, setRows(next) { rows = next; },
    resetMetrics() { for (const key of Object.keys(metrics)) metrics[key] = 0; },
    async fireTimers() { for (const [id, entry] of [...timers]) { timers.delete(id); entry.callback(); } await Promise.resolve(); },
    outcome() { return {events, rows: rows.map(item => ({dataset: { ...item.dataset }, classes: item.classList.values?.()})),
      origins: [...origins], renderSources: [...blockDraftRenderSources], scopes: [...blockEditAuthenticationScopes],
      saveRows: [...blockSaveRows.keys()], saveTimers: [...blockSaveTimers], title: api.titleState(), order: api.orderState() }; }
  };
}

export const makeHarness = (mode = 'current', options = {}) => createRowHarnessFromSource(rowSources(mode), options);
export const recoveryFixture = (count = 0, conflict = true) => ({
  scope: { userId: 'user-a', pageId: 'page-a' }, title: null, blockOrder: null,
  blocks: Array.from({ length: count }, (_, index) => ({ blockId: `b_${index}`, sourceId: 'origin-tab', conflict,
    draft: { revision: 2, expectedVersion: 7, payload: { type: 'MARKDOWN', markdown: `한글 😀 ${index}`, metadata: null } } })),
  missing: [], orderConflicts: [], alternates: [], conflictCount: conflict ? count : 0
});
