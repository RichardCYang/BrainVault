// Dependency-free component harness. Production functions are loaded verbatim;
// only DOM/network/auth surroundings are explicit test doubles. This is not E2E.
import { readFileSync } from 'node:fs';
export const baseline = JSON.parse(readFileSync(new URL('../fixtures/editor-batch-resource-baseline.json', import.meta.url), 'utf8'));
export const currentApp = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
export const currentCaret = readFileSync(new URL('../../public/collaboration-caret.js', import.meta.url), 'utf8');

export function extractFunction(source, name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'));
  if (!match) throw new Error(`Missing production function: ${name}`);
  return match[0];
}

export function makeApp(mode = 'current', { instrument = false, capturePayloads = false } = {}) {
  const parts = mode === 'baseline' ? baseline.app : Object.fromEntries(
    Object.keys(baseline.app).map(name => [name, extractFunction(currentApp, name)]));
  const metrics = { idReads: 0, mapConstructions: 0, mapSets: 0 };
  class CountedMap extends Map {
    constructor(...args) { super(...args); metrics.mapConstructions++; }
    set(key, value) { metrics.mapSets++; return super.set(key, value); }
  }
  const state = { selectedPage: { id: 'page-a', version: 8, blocks: [] }, user: { id: 'user-a' }, collaborationSession: null };
  const gate = { auth: 1, navigation: 1, writable: true, collaborative: true, dispatchError: null, definitive: false };
  const elements = { pageTitle: { value: '한글 title 😀' } };
  const events = [], payloads = [];
  const skippedApiRequest = Symbol('skipped-api-request');
  const context = {
    state, elements, events, gate, skippedApiRequest,
    captureAuthenticatedSessionScope: () => ({ generation: gate.auth, targetKey: state.user?.id }),
    isCurrentAuthenticatedSessionScope: scope => scope?.generation === gate.auth && scope?.targetKey === state.user?.id,
    assertCurrentAuthenticatedSessionScope: scope => {
      if (scope?.generation !== gate.auth || scope?.targetKey !== state.user?.id) throw Error('STALE_AUTH');
    },
    isCurrentWorkspaceNavigation: generation => generation === gate.navigation,
    canPersistSelectedPage: () => gate.writable,
    requireWritablePage: () => gate.writable,
    isCollaborativePage: () => gate.collaborative,
    createMutationId: () => 'deterministic-mutation-id',
    persistBlockOrderDraft: task => events.push(['persist', task]),
    syncPageModeUi: () => events.push(['mode']),
    syncBeforeUnloadProtection: () => events.push(['unload']),
    submitBlockOrderTaskWithReplay: async task => {
      events.push(['dispatch', task]);
      if (gate.dispatchError) throw gate.dispatchError;
      return { saved: true, items: task.items };
    },
    acknowledgeBlockOrderDraft: task => events.push(['acknowledge', task]),
    isDefinitiveApiError: () => gate.definitive,
    t: key => key
  };
  const factory = new Function('context', 'Map', 'JSON', `
    const {${Object.keys(context).join(',')}} = context;
    const pageDraftSourceId = 'tab-a';
    let pageTitleDraftExpectedVersion = null;
    let workspaceNavigationGeneration = 1;
    let pendingBlockOrderTask = null, blockOrderSaving = false;
    ${Object.values(baseline.constants).join('\n')}
    ${Object.values(parts).join('\n')}
    return {
      task: createBlockOrderTask, persist: persistBlockOrder, bytes: getPendingSavePayloadBytes,
      payload: buildBlockPayload, lookup: createBlockLookup,
      setTitleVersion(value) { pageTitleDraftExpectedVersion = value; },
      setNavigation(value) { workspaceNavigationGeneration = value; },
      getQueueState() { return {pendingBlockOrderTask, blockOrderSaving}; }
    };
  `);
  const json = capturePayloads ? { stringify: value => { payloads.push(value); return JSON.stringify(value); } } : JSON;
  const api = factory(context, instrument ? CountedMap : Map, json);
  return { ...api, state, elements, metrics, events, gate, payloads, skippedApiRequest,
    resetMetrics() { for (const key of Object.keys(metrics)) metrics[key] = 0; }
  };
}

export function makeBlocks(count, { nested = false, metrics = null } = {}) {
  const roots = [], flat = [];
  for (let i = 0; i < count; i++) {
    const parent = nested && i % 8 ? flat[i - i % 8] : null;
    const id = `block-${i}`;
    const block = { id, type: 'MARKDOWN', version: i + 1, markdown: `原文 ${i} 😀`, checked: false,
      metadata: { custom: `m${i}`, nested: { text: '<script>not executable</script>' } },
      parentBlockId: parent?.id ?? null, sortOrder: parent ? parent.children.length : roots.length, children: [] };
    if (metrics) Object.defineProperty(block, 'id', { enumerable: true, configurable: true,
      get() { metrics.idReads++; return id; } });
    (parent ? parent.children : roots).push(block); flat.push(block);
  }
  return { roots, flat, ids: flat.map(block => block.id) };
}

export function makeRow(id, { type = 'MARKDOWN', text = '편집 😀', checked = false, ...dataset } = {}) {
  const controls = { 'textarea[name="markdown"]': { value: text }, 'input[name="checked"]': { checked } };
  return { dataset: { blockId: id, blockType: type, ...dataset }, controls,
    querySelector(selector) { return controls[selector] ?? null; } };
}

export function makeCaret(mode = 'current') {
  const source = mode === 'baseline' ? baseline.caret : currentCaret;
  return new Function(source.replace(/^export /gm, '') + '\nreturn { key: getTextSelectionControlKey, byKey: getTextSelectionControlByKey, all: getRowTextSelectionControls };')();
}

export function makeControls(count, { metrics = null } = {}) {
  const controls = Array.from({ length: count }, (_, i) => {
    const control = { value: `값 ${i} 😀`, selectionEnd: 2 };
    Object.defineProperty(control, 'selectionStart', { configurable: true, get() {
      if (metrics) metrics.selectionReads++;
      return 1;
    }});
    return control;
  });
  const row = { querySelectorAll(selector) {
    if (selector !== 'input, textarea') throw Error('Unexpected selector');
    if (metrics) metrics.queries++;
    return controls;
  }};
  return { controls, row };
}

export function randomGenerator(seed = 0x17b47c26) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 2 ** 32; };
}
