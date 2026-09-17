#!/usr/bin/env python3
"""Native Chromium component regression for database normalization/editor and menu closure.
Uses complete original/current ESM modules and exact application menu functions/listeners.
All network requests are blocked. This is not authenticated API/CSP/MariaDB end-to-end testing.
Requires Python Playwright and Chromium; no npm install is required.
Run: python scripts/verify-normalization-idle-resources-browser.py --output result.json
--unchanged runs the resource gates against the unmodified source to reproduce the failure.
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
JS = r'''async ({sources, helpers, handlers, fixture, large, locale, stylesheet}) => {
  const results = [], metrics = [], urls = [];
  const check = (ok, message = 'assertion failed') => { if (!ok) throw Error(message); };
  const equal = (a, b, message = 'original/current mismatch') => check(JSON.stringify(a) === JSON.stringify(b), message);
  async function test(name, run) {
    try { await run(); results.push({name, passed: true}); }
    catch (error) { results.push({name, passed: false, error: String(error), stack: error.stack}); }
  }
  function url(source) { const value = URL.createObjectURL(new Blob([source], {type: 'text/javascript'})); urls.push(value); return value; }
  const i18nUrl = url(helpers.i18n), summaryUrl = url(helpers.summary);
  const i18n = await import(i18nUrl); i18n.setLanguage(locale.split('-')[0], {persist: false});
  const modules = {};
  for (const mode of ['baseline', 'current']) {
    modules[mode] = await import(url(sources[mode].database.replaceAll('"./i18n.js"', JSON.stringify(i18nUrl)).replaceAll('"./summary-prefix.js"', JSON.stringify(summaryUrl))));
  }
  const style = document.createElement('style'); style.textContent = stylesheet; document.head.append(style);
  await test('native ESM: maximum-size normalization and repeated extraction preserve exact data', () => {
    const bytes = JSON.stringify(large);
    equal(modules.current.normalizeDatabaseData(large), modules.baseline.normalizeDatabaseData(large));
    for (let i = 0; i < 30; i++) equal(modules.current.normalizeDatabaseData(fixture), modules.baseline.normalizeDatabaseData(fixture));
    check(JSON.stringify(large) === bytes, 'input mutated');
  });
  function editor(mode, input = fixture) {
    const row = document.createElement('article'); row.className = 'editor-block-row'; row.dataset.blockId = 'database-block';
    const host = document.createElement('div'); host.className = 'block-editor-host'; row.append(host); document.body.append(row);
    let dirty = 0;
    host.append(modules[mode].createDatabaseEditor(row, structuredClone(input), {onDirty: () => dirty++}));
    return {row, host, data: () => modules[mode].extractDatabaseData(row), get dirty() {return dirty;}};
  }
  for (const view of ['table', 'board', 'list']) {
    await test(`native DOM: ${view} view markup, labels, limits, filters and extraction`, () => {
      const input = structuredClone(fixture); input.views[0].type = view;
      input.views[0].groupPropertyId = view === 'board' ? 'status' : null;
      input.views[0].sorts = [{id: 'sort', propertyId: 'number', direction: 'descending'}];
      const a = editor('baseline', input), b = editor('current', input);
      try { equal(a.data(), b.data()); check(a.host.innerHTML === b.host.innerHTML, 'view markup differs'); }
      finally {a.row.remove(); b.row.remove();}
    });
  }
  const a = editor('baseline'), b = editor('current');
  const field = (h, id) => h.host.querySelector(`.database-value-input[data-row-id="r0"][data-property-id="${id}"]`);
  function edit(h, id, value, kind = 'input') {
    const input = field(h, id); check(input, 'missing editor ' + id);
    if (id === 'check') input.checked = value; else input.value = value;
    input.dispatchEvent(new Event(kind, {bubbles: true}));
  }
  function pairAction(action) {
    action(a); action(b); equal(a.data(), b.data()); check(a.dirty === b.dirty, 'autosave/dirty callback mismatch');
  }
  await test('input/change: text, number, selection, multiselection, checkbox, date and URL edits', () => {
    for (const [id, value, event] of [['title','한국어 😀 edited','input'], ['number','17.25','input'], ['status','todo','change'],
      ['tags','Tag 1, Tag 0, Tag 1','input'], ['check',true,'change'], ['date','2026-09-17','change'], ['url','https://example.org/changed','input']]) {
      pairAction(h => edit(h, id, value, event));
    }
    check(b.data().rows[0].values.number === 17.25 && b.data().rows[0].values.status === 'todo');
    equal(b.data().rows[0].values.tags, ['tag0','tag1']);
  });
  await test('option rename keeps referenced IDs; ambiguous destructive edit stays rejected without autosave', () => {
    const options = h => h.host.querySelector('.database-property-item[data-property-id="status"] .database-property-options');
    pairAction(h => { const control = options(h); control.value = 'Renamed, Done'; control.dispatchEvent(new Event('change', {bubbles:true})); });
    check(b.data().properties.find(p => p.id === 'status').options[0].id === 'todo');
    check(b.data().rows[0].values.status === 'todo');
    const bytes = JSON.stringify(b.data()), count = b.dirty;
    pairAction(h => { const control = options(h); control.value = 'Done'; control.dispatchEvent(new Event('change', {bubbles:true})); check(!control.validity.valid); });
    check(JSON.stringify(b.data()) === bytes && b.dirty === count, 'rejected edit changed persisted model');
  });
  await test('property type edits re-normalize all rows without stale option indexes', () => {
    for (const type of ['text','number','select','multi_select','text']) {
      pairAction(h => {
        const control = h.host.querySelector('.database-property-item[data-property-id="tags"] .database-property-type');
        control.value = type; control.dispatchEvent(new Event('change', {bubbles:true}));
      });
      check(b.data().properties.find(p => p.id === 'tags').type === type);
    }
  });
  await test('row addition, deletion and view switching preserve models and callback counts', () => {
    const nativeConfirm = window.confirm, uuidDescriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    window.confirm = () => true;
    const deterministic = action => h => {
      let sequence = 0;
      Object.defineProperty(crypto, 'randomUUID', {configurable:true, value: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`});
      action(h);
    };
    try {
      pairAction(deterministic(h => h.host.querySelector('[data-action="database-add-row"]').click()));
      check(b.data().rows.length === fixture.rows.length + 1);
      pairAction(h => h.host.querySelector('[data-action="database-delete-row"][data-row-id="r0"]').click());
      check(b.data().rows.length === fixture.rows.length);
      for (const type of ['board','list']) pairAction(deterministic(h => {
        const select = h.host.querySelector('.database-add-view-select'); select.value = type; select.dispatchEvent(new Event('change', {bubbles:true}));
      }));
    } finally {
      window.confirm = nativeConfirm;
      if (uuidDescriptor) Object.defineProperty(crypto, 'randomUUID', uuidDescriptor); else delete crypto.randomUUID;
    }
  });
  await test('untrusted labels stay inert; script URLs cannot become preview hyperlinks', () => {
    const input = structuredClone(fixture); input.title = '<img src=x onerror="globalThis.__injected=1">';
    input.properties[0].name = '<svg/onload="globalThis.__injected=1">';
    input.rows[0].values.url = 'javascript:globalThis.__injected=1';
    const x = editor('baseline',input), y = editor('current',input); globalThis.__injected = 0;
    try {
      equal(x.data(),y.data()); check(x.host.innerHTML === y.host.innerHTML);
      check(!y.host.querySelector('img,svg,script'));
      check(!y.host.querySelector('.database-url-preview[href^="javascript:"]'));
      check(globalThis.__injected === 0);
    } finally {x.row.remove();y.row.remove();}
  });
  a.row.remove(); b.row.remove();
  function menus(mode) {
    const host = document.createElement('section'); document.body.append(host);
    const elements = {};
    for (const name of ['pageActionsMenu','navigationContextMenu','blockContextMenu']) {
      const el = document.createElement('div'); el.className = 'hidden'; el.dataset.testMenu = name; host.append(el); elements[name] = el;
    }
    elements.pageActionsButton = document.createElement('button'); elements.pageActionsButton.setAttribute('aria-expanded','false'); host.append(elements.pageActionsButton);
    const navigationRow = document.createElement('div'); navigationRow.className = 'document-item-row';
    const navigationTrigger = document.createElement('button'); navigationTrigger.setAttribute('aria-expanded','false'); navigationRow.append(navigationTrigger); host.append(navigationRow);
    const blockRow = document.createElement('article'); blockRow.className = 'editor-block-row';
    const handle = document.createElement('button'); handle.setAttribute('aria-expanded','false'); blockRow.append(handle); host.append(blockRow);
    const input = document.createElement('input'); input.value = 'typing 한국어 😀'; host.append(input);
    elements.blockList = blockRow;
    const state = {activeNavigationMenuTrigger:null,activeNavigationMenuTarget:null,activeBlockMenuHandle:null,activeBlockMenuId:null};
    const getBlockRow = target => target?.closest('.editor-block-row') ?? null;
    const calls = new Function('state','elements','getBlockRow',sources[mode].menus + '\nreturn {closePageActionsMenu,closeNavigationContextMenu,closeBlockContextMenu};')(state,elements,getBlockRow);
    let bindings = [];
    function attach() {
      const facade = target => ({addEventListener(type,fn,options) {target.addEventListener(type,fn,options);bindings.push([target,type,fn,options]);}});
      new Function('window','document','elements',...Object.keys(calls),helpers.closeKanban + '\n' + handlers)(facade(window),facade(document),elements,...Object.values(calls));
    }
    function detach() {for (const [target,type,fn,options] of bindings) target.removeEventListener(type,fn,options);bindings=[];}
    function open() {
      for (const key of ['pageActionsMenu','navigationContextMenu','blockContextMenu']) {
        elements[key].classList.remove('hidden'); elements[key].style.cssText = 'left:42px;top:18px;visibility:visible';
      }
      for (const button of [elements.pageActionsButton,navigationTrigger,handle]) button.setAttribute('aria-expanded','true');
      navigationRow.classList.add('is-menu-open'); blockRow.classList.add('is-menu-open');
      state.activeNavigationMenuTrigger=navigationTrigger;state.activeNavigationMenuTarget={id:'n0'};
      state.activeBlockMenuHandle=handle;state.activeBlockMenuId='b0';
    }
    function measure(target, count) {
      const observer = new MutationObserver(() => {}); observer.observe(host,{subtree:true,attributes:true,childList:true}); attach();
      const start = performance.now();
      try {for (let i=0;i<count;i++) (target === 'window' ? window : blockRow).dispatchEvent(new Event('scroll'));}
      finally {detach();}
      const elapsedMs = performance.now()-start, records=observer.takeRecords(); observer.disconnect();
      return {dispatches:count,mutations:records.length,elapsedMs};
    }
    return {host,elements,state,calls,navigationTrigger,handle,navigationRow,blockRow,input,open,measure,detach};
  }
  const oldMenus=menus('baseline'),newMenus=menus('current');
  for (const target of ['window','nested']) await test(`native ${target} scroll: 1,000 closed-menu events create no redundant mutation records`, () => {
    const before=oldMenus.measure(target,1000),after=newMenus.measure(target,1000);
    metrics.push({target,baseline:before,current:after});
    check(before.mutations >= 3000, 'baseline did not reproduce redundant native mutations');
    check(after.mutations === 0, 'closed menus still produce native mutations');
    check(oldMenus.host.innerHTML === newMenus.host.innerHTML);
  });
  await test('closing visible menus preserves cleanup, focus restoration, ARIA and selection state', () => {
    for (const h of [oldMenus,newMenus]) {
      h.open(); h.calls.closeNavigationContextMenu({restoreFocus:true}); check(document.activeElement === h.navigationTrigger);
      h.calls.closeBlockContextMenu({restoreFocus:true}); check(document.activeElement === h.handle);
      h.calls.closePageActionsMenu({restoreFocus:true}); check(document.activeElement === h.elements.pageActionsButton);
      check(h.state.activeNavigationMenuTrigger === null && h.state.activeBlockMenuHandle === null);
      for (const key of ['pageActionsMenu','navigationContextMenu','blockContextMenu']) {
        check(h.elements[key].classList.contains('hidden')); check(!h.elements[key].style.left && !h.elements[key].style.top && !h.elements[key].style.visibility);
      }
    }
    check(oldMenus.host.innerHTML === newMenus.host.innerHTML);
  });
  await test('already-hidden menus still remove stale geometry and repair inconsistent ARIA', () => {
    for (const h of [oldMenus,newMenus]) {
      h.elements.pageActionsMenu.style.cssText='left:1px;top:2px;visibility:visible';
      h.elements.pageActionsButton.setAttribute('aria-expanded','true');h.calls.closePageActionsMenu({restoreFocus:true});
      check(!h.elements.pageActionsMenu.style.left && !h.elements.pageActionsMenu.style.visibility);
      check(h.elements.pageActionsButton.getAttribute('aria-expanded')==='false');check(document.activeElement===h.elements.pageActionsButton);
    }
    check(oldMenus.host.innerHTML===newMenus.host.innerHTML);
  });
  await test('scroll does not steal editor focus, change selection or retain stale menu handles', () => {
    for (const h of [oldMenus,newMenus]) {
      h.input.focus();h.input.setSelectionRange(2,5);h.measure('nested',200);
      check(document.activeElement===h.input && h.input.selectionStart===2 && h.input.selectionEnd===5);
      check(h.input.value==='typing 한국어 😀');
      h.open();h.handle.remove();h.navigationTrigger.remove();
      h.calls.closeBlockContextMenu({restoreFocus:true});h.calls.closeNavigationContextMenu({restoreFocus:true});
      check(h.state.activeBlockMenuHandle===null && h.state.activeNavigationMenuTrigger===null);
    }
  });
  oldMenus.detach();newMenus.detach();oldMenus.host.remove();newMenus.host.remove();
  // Let native toggle/focus callbacks finish before closing the context.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  urls.forEach(value => URL.revokeObjectURL(value));style.remove();
  return {locale,results,metrics,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length};
}'''


def function_source(app, name):
    match = re.search(r'^function ' + re.escape(name) + r'\([^\n]*\) \{[\s\S]*?^\}', app, re.M)
    if not match:
        raise ValueError('Missing function: ' + name)
    return match.group()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--browser', default=shutil.which('chromium') or shutil.which('google-chrome'))
    parser.add_argument('--unchanged', action='store_true')
    args = parser.parse_args()
    if not args.browser:
        parser.error('Chromium not found; use --browser')
    baseline = json.loads((ROOT / 'tests/fixtures/normalization-idle-resource-baseline.json').read_text())
    for name, record in {**baseline['files'], **baseline['menuFunctions']}.items():
        if hashlib.sha256(record['source'].encode()).hexdigest() != record['sha256']:
            raise ValueError('Invalid original fixture ' + name)
    app = (ROOT / 'public/app.js').read_text()
    sources = {
        'baseline': {'database': baseline['files']['public/database-block.js']['source'], 'menus': '\n'.join(x['source'] for x in baseline['menuFunctions'].values())},
        'current': {'database': (ROOT / 'public/database-block.js').read_text(), 'menus': '\n'.join(function_source(app, name) for name in baseline['menuFunctions'])}}
    if args.unchanged:
        sources['current'] = sources['baseline']
    handlers = '\n'.join(re.findall(r'(?:document|window)\.addEventListener\("scroll", \(\) => \{\n  close(?:Navigation|Block)ContextMenu\(\);[\s\S]*?^\}, \{[^\n]*\}\);', app, re.M))
    if handlers.count('addEventListener') != 2:
        raise ValueError('Expected two exact production menu scroll listeners')
    large = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {databaseFixture} from './tests/helpers/normalization-idle-resource-harness.mjs'; console.log(JSON.stringify(databaseFixture()));"], cwd=ROOT, text=True))
    properties = [
        {'id': 'title', 'name': 'Name', 'type': 'title', 'options': []},
        {'id': 'status', 'name': 'Status', 'type': 'select', 'options': [{'id': 'todo', 'name': 'Todo', 'color': 'blue'}, {'id': 'done', 'name': 'Done', 'color': 'green'}]},
        {'id': 'tags', 'name': 'Tags', 'type': 'multi_select', 'options': [{'id': 'tag0', 'name': 'Tag 0', 'color': 'gray'}, {'id': 'tag1', 'name': 'Tag 1', 'color': 'blue'}]},
        *[{'id': key, 'name': key, 'type': kind, 'options': []} for key, kind in [('number', 'number'), ('check', 'checkbox'), ('date', 'date'), ('url', 'url')]]
    ]
    fixture = {'title': 'Notes 표 😀', 'properties': properties, 'rows': [{'id': f'r{i}', 'values': {'title': f'Row {i}', 'status': 'done', 'tags': ['tag0'], 'number': i, 'check': False, 'date': '2026-09-10', 'url': 'https://example.org/'}} for i in range(8)], 'views': [{'id': 'table', 'name': 'Table', 'type': 'table', 'filters': [], 'sorts': [], 'groupPropertyId': None, 'hiddenPropertyIds': []}], 'activeViewId': 'table'}
    report = {'scope': __doc__, 'unchanged': args.unchanged, 'sourceArchiveSha256': baseline['sourceArchiveSha256'], 'runs': [], 'pageErrors': []}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        report['browserVersion'] = browser.version
        try:
            for locale in ['en-US', 'ko-KR', 'de-DE']:
                context = browser.new_context(locale=locale)
                try:
                    context.route('**/*', lambda route: route.abort())
                    page = context.new_page()
                    page.on('pageerror', lambda error, lang=locale: report['pageErrors'].append({'locale': lang, 'error': str(error)}))
                    page.set_content('<!doctype html><meta charset="utf-8"><title>Native resource regression</title><body></body>')
                    report['runs'].append(page.evaluate(JS, {'sources': sources, 'helpers': {'i18n': (ROOT / 'public/i18n.js').read_text(), 'summary': (ROOT / 'public/summary-prefix.js').read_text(), 'closeKanban': function_source(app, 'closeKanbanCardStyleMenus')}, 'handlers': handlers, 'fixture': fixture, 'large': large, 'locale': locale, 'stylesheet': (ROOT / 'public/styles.css').read_text()}))
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
