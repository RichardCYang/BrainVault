#!/usr/bin/env python3
"""Compare exact original/current hot paths in real Chromium without an API server.
Requires Python Playwright, Chromium and Node. Run from any working directory:
  python scripts/verify-resource-audit-2026-09-17-browser.py --output result.json
Uses actual insertion/caret/i18n modules via Blob ESM, exact app function slices,
and real DOM. Only requestAnimationFrame scheduling is replaced with a call spy.
This is component regression, not authenticated HTTP/CSP/database E2E.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
JS = r'''async ({sources, fixtures, helpers, caretSource, i18nSource, locale}) => {
  const results = [], metrics = [], urls = [];
  function check(ok, message = 'assertion failed') { if (!ok) throw Error(message); }
  function equal(left, right, message = 'original/current mismatch') {
    check(JSON.stringify(left) === JSON.stringify(right), message);
  }
  async function test(name, run) {
    try { await run(); results.push({name, passed: true}); }
    catch (error) { results.push({name, passed: false, error: String(error), stack: error.stack}); }
  }
  async function module(source) {
    const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
    urls.push(url); return import(url);
  }
  const caret = await module(caretSource), i18n = await module(i18nSource);
  i18n.setLanguage(locale.split('-')[0], {persist: false});
  const insertions = {}, trees = {};
  for (const mode of ['baseline', 'current']) {
    insertions[mode] = (await module(sources[mode].insertion)).planConfirmedBlockInsertion;
    const state = {selectedPage: {blocks: []}};
    trees[mode] = new Function('state', sources[mode].tree + '\nreturn buildCollaborationBlockTree;')(state);
  }
  await test('native ESM: insertion and authoritative/version/page rejection parity', () => {
    for (const original of fixtures.insertions) {
      const changes = [input => {}, input => input.currentContentVersion++,
        input => input.createResult.pageContentVersionAuthoritative = false,
        input => input.createResult.block.pageId = 'other-account',
        input => input.orderedIds.push(input.orderedIds[0])];
      for (const change of changes) {
        const input = structuredClone(original); change(input);
        const bytes = JSON.stringify(input);
        equal(insertions.current(input), insertions.baseline(input));
        check(JSON.stringify(input) === bytes, 'insertion mutated input');
      }
    }
  });
  await test('Chromium: 2,000-node tree, root/leaf order and cycle/orphan parity', () => {
    for (const original of fixtures.trees) {
      for (const mode of ['normal', 'cycle', 'missing']) {
        const input = structuredClone(original);
        if (mode === 'cycle') input[0].parentBlockId = input.at(-1).id;
        if (mode === 'missing') input[1].parentBlockId = 'missing';
        const bytes = JSON.stringify(input);
        equal(trees.current(input), trees.baseline(input));
        check(JSON.stringify(input) === bytes, 'tree mutated input');
      }
    }
  });
  function harness(mode) {
    const host = document.createElement('section');
    const elements = {collaborationPresence: document.createElement('div'), blockList: document.createElement('div')};
    host.append(elements.collaborationPresence, elements.blockList); document.body.append(host);
    const state = {user: {id: 'self'}, collaborationPresence: []};
    let scheduled = 0;
    const values = {state, elements, t: i18n.t,
      assignRemoteCaretColors: caret.assignRemoteCaretColors,
      getRemoteCaretClientKey: caret.getRemoteCaretClientKey,
      scheduleRemoteCollaborationCaretRender: () => { scheduled++; }};
    const render = new Function(...Object.keys(values), helpers + '\n' + sources[mode].presence + '\nreturn renderCollaborationPresence;')(...Object.values(values));
    function replaceRows(count = 2000, prefix = 'b', noTopline = -1) {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < count; index++) {
        const row = document.createElement('article'); row.className = 'editor-block-row'; row.dataset.blockId = prefix + index;
        if (index !== noTopline) {const line = document.createElement('div');line.className = 'block-row-topline';row.append(line);}
        const editor = document.createElement('textarea'); editor.name = 'markdown'; editor.value = '한국어 😀 ' + index; row.append(editor);
        fragment.append(row);
      }
      elements.blockList.replaceChildren(fragment);
    }
    replaceRows();
    function renderCount(presence) {
      state.collaborationPresence = presence;
      let labelQueries = 0, cleanupRows = 0;
      const nativeQuery = Element.prototype.querySelectorAll;
      Element.prototype.querySelectorAll = function (selector) {
        const found = Reflect.apply(nativeQuery, this, [selector]);
        if (selector === '.remote-editor-label') labelQueries++;
        if (this === elements.blockList && ['.editor-block-row', '.editor-block-row.has-remote-editor'].includes(selector)) cleanupRows += found.length;
        return found;
      };
      const observer = new MutationObserver(() => {});
      observer.observe(elements.blockList, {subtree: true, attributes: true, childList: true});
      const start = performance.now();
      try { render(); }
      finally { Element.prototype.querySelectorAll = nativeQuery; }
      const elapsedMs = performance.now() - start;
      const mutations = observer.takeRecords(); observer.disconnect();
      return {labelQueries, cleanupRows, mutations: mutations.length,
        classMutations: mutations.filter(record => record.attributeName === 'class').length,
        styleMutations: mutations.filter(record => record.attributeName === 'style').length, elapsedMs};
    }
    return {host, elements, state, replaceRows, renderCount, get scheduled() {return scheduled;}};
  }
  const clients = (count = 1, blockId = 'b1000') => Array.from({length: count}, (_, index) => ({
    connectionId: 'connection-' + index, user: {id: 'remote-' + index, username: 'user-' + index, name: index % 2 ? '김 사용자 😀' : 'Alex Example'},
    state: {blockId, field: 'markdown', selection: {anchor: index, head: index + 1}}
  }));
  const before = harness('baseline'), after = harness('current');
  function renderBoth(presence, name, expectedMarked) {
    const a = before.renderCount(structuredClone(presence)), b = after.renderCount(structuredClone(presence));
    equal(after.host.innerHTML, before.host.innerHTML, name + ': markup mismatch');
    check(after.scheduled === before.scheduled, name + ': scheduler calls');
    if (expectedMarked !== undefined) check(after.elements.blockList.querySelectorAll('.has-remote-editor').length === expectedMarked, name + ': decorated rows');
    metrics.push({name, baseline: a, current: b}); return {a, b};
  }
  await test('empty 2,000-row document: no irrelevant row cleanup or DOM mutation', () => {
    const {a, b} = renderBoth([], 'empty', 0);
    check(a.cleanupRows === 2000 && b.cleanupRows === 0);
    check(a.labelQueries === 2000 && b.labelQueries === 0);
    check(b.mutations === 0, 'unannotated DOM changed');
  });
  await test('remote editor joins: identical avatar, ARIA, color and row label', () => {
    const {a, b} = renderBoth(clients(), 'join', 1);
    check(a.cleanupRows === 2000 && b.cleanupRows === 0);
    check(after.elements.blockList.querySelector('.remote-editor-label').textContent === 'Alex Example');
    check(after.elements.collaborationPresence.getAttribute('aria-label') === i18n.t('sharing.activeEditors', {count: 1}));
  });
  await test('remote editor changes blocks: cleanup visits one row instead of 2,000', () => {
    const input = clients(1, 'b1999');
    const {a, b} = renderBoth(input, 'block-switch', 1);
    check(a.cleanupRows === 2000 && b.cleanupRows === 1);
    check(a.labelQueries === 2000 && b.labelQueries === 1);
    check(!after.elements.blockList.querySelector('[data-block-id="b1000"]').classList.contains('has-remote-editor'));
    check(a.mutations > b.mutations, 'expected fewer native mutations');
  });
  await test('multiple connections, same-block editors and five-avatar limit', () => {
    const input = clients(8); input[6].state.blockId = 'b50'; input[7].state.blockId = 'b1999';
    renderBoth(input, 'many-editors', 3);
    check(after.elements.collaborationPresence.children.length === 5);
    check(after.elements.blockList.querySelectorAll('.remote-editor-label').length === 8);
  });
  await test('self presence excluded and absent/title targets do not create row labels', () => {
    const input = clients(3); input[0].user.id = 'self'; input[1].state.blockId = 'absent'; input[2].state.blockId = null;
    renderBoth(input, 'self-and-missing', 0);
    check(after.elements.collaborationPresence.children.length === 2);
  });
  await test('untrusted display name remains inert text, including localized titles', () => {
    globalThis.__resourceAuditInjected = 0;
    const input = clients(); input[0].user.name = '<img src=x onerror="globalThis.__resourceAuditInjected=1">';
    renderBoth(input, 'name-text-security', 1);
    const label = after.elements.blockList.querySelector('.remote-editor-label');
    check(label.textContent === input[0].user.name);
    check(label.querySelector('img') === null && globalThis.__resourceAuditInjected === 0);
    check(label.title === i18n.t('sharing.remoteEditing', {name: input[0].user.name}));
  });
  await test('leaving collaboration removes old labels/colors and changes only annotated rows', () => {
    const {b} = renderBoth([], 'leave', 0);
    check(b.cleanupRows === 1 && b.labelQueries === 1);
    check(after.elements.blockList.querySelectorAll('.remote-editor-label').length === 0);
    check([...after.elements.blockList.children].every(row => !row.style.getPropertyValue('--remote-caret-color')));
  });
  await test('page replacement and user switch do not retain or decorate stale rows', () => {
    renderBoth(clients(), 'before-navigation', 1);
    const staleBefore = before.elements.blockList.children[1000], staleAfter = after.elements.blockList.children[1000];
    before.replaceRows(2000, 'next-'); after.replaceRows(2000, 'next-');
    renderBoth(clients(), 'old-page-target', 0);
    equal(staleBefore.outerHTML, staleAfter.outerHTML);
    check(!staleAfter.isConnected);
    before.state.user = after.state.user = {id: 'remote-0'};
    renderBoth(clients(1, 'next-5'), 'account-switch', 0);
    before.state.user = after.state.user = {id: 'self'};
    renderBoth(clients(1, 'next-5'), 'new-page-target', 1);
  });
  await test('row reconstruction, missing top line and repeated updates preserve editor focus/value', () => {
    before.replaceRows(50, 'b', 7); after.replaceRows(50, 'b', 7);
    for (let index = 0; index < 80; index++) {
      const input = clients(1, 'b' + (index % 50));
      const editor = after.elements.blockList.children[9].querySelector('textarea');
      editor.focus(); editor.setSelectionRange(2, 4);
      renderBoth(input, 'repeat-' + index, 1);
      check(document.activeElement === editor && editor.selectionStart === 2 && editor.selectionEnd === 4);
      check(editor.value === '한국어 😀 9');
    }
    renderBoth([], 'final-clear', 0);
    check(after.elements.blockList.querySelectorAll('.remote-editor-label').length === 0);
  });
  await test('caret-only movement remains outside the decoration-render path', () => {
    const a = clients(), b = structuredClone(a); b[0].state.selection.head = 100;
    check(caret.hasRemotePresenceDecorationChanges(a, b) === false);
    b[0].state.blockId = 'b1'; check(caret.hasRemotePresenceDecorationChanges(a, b) === true);
  });
  before.host.remove(); after.host.remove(); urls.forEach(url => URL.revokeObjectURL(url));
  return {locale, passed: results.filter(result => result.passed).length,
    failed: results.filter(result => !result.passed).length, results, metrics};
}'''


def function_source(source: str, name: str) -> str:
    start = source.index('function ' + name + '(')
    end = re.search(r'\n(?:async )?function ', source[start + 1:])
    if end is None:
        raise ValueError('Missing function boundary: ' + name)
    return source[start:start + 1 + end.start()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--browser', default=shutil.which('chromium') or shutil.which('google-chrome'))
    args = parser.parse_args()
    if not args.browser:
        parser.error('Chromium not found; use --browser /path/to/chromium')
    fixture = json.loads((ROOT / 'tests/fixtures/resource-audit-2026-09-17-baseline.json').read_text())
    sources = {'baseline': {}, 'current': {}}
    app = (ROOT / 'public/app.js').read_bytes().decode('utf-8')
    for name, record in fixture['records'].items():
        if hashlib.sha256(record['source'].encode()).hexdigest() != record['sha256']:
            raise ValueError('Original fixture checksum mismatch: ' + name)
        sources['baseline'][name] = record['source']
        current = (ROOT / record['path']).read_bytes().decode('utf-8')
        if record.get('start'):
            start = current.index('function ' + record['start'] + '(')
            end = current.index('function ' + record['end'] + '(', start + 1)
            current = current[start:end]
        sources['current'][name] = current
    helpers = '\n'.join(function_source(app, name) for name in [
        'getPresenceDisplayName', 'getRemoteCollaborationPresence', 'setRemoteCaretColor',
        'getUserInitials', 'findRenderedBlockRow'])
    fixtures = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        "import {insertionFixture,collaborationTreeFixture} from './tests/helpers/resource-audit-2026-09-17-harness.mjs';"
        "console.log(JSON.stringify({insertions:[insertionFixture(2000,false),insertionFixture(2000,true)],"
        "trees:[collaborationTreeFixture(2000,128,false),collaborationTreeFixture(2000,128,true)]}));"], cwd=ROOT, text=True))
    report = {'scope': __doc__, 'runs': [], 'pageErrors': []}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            report['browserVersion'] = browser.version
            for locale in ['en-US', 'ko-KR', 'ja-JP', 'de-DE', 'sv-SE', 'tr-TR']:
                context = browser.new_context(locale=locale)
                try:
                    context.route('**/*', lambda route: route.abort())
                    page = context.new_page()
                    page.on('pageerror', lambda error, lang=locale: report['pageErrors'].append({'locale': lang, 'error': str(error)}))
                    page.set_content('<!doctype html><meta charset="utf-8"><title>Resource regression</title><body></body>')
                    report['runs'].append(page.evaluate(JS, {
                        'sources': sources, 'fixtures': fixtures, 'helpers': helpers, 'locale': locale,
                        'caretSource': (ROOT / 'public/collaboration-caret.js').read_text(),
                        'i18nSource': (ROOT / 'public/i18n.js').read_text()}))
                finally:
                    context.close()
        finally:
            browser.close()
    report['passed'] = sum(run['passed'] for run in report['runs'])
    report['failed'] = sum(run['failed'] for run in report['runs'])
    text = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.write_text(text, encoding='utf-8')
    print(text)
    return 1 if report['failed'] or report['pageErrors'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
