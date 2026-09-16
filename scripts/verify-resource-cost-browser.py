#!/usr/bin/env python3
"""Compare complete original/current browser ESM modules in real Chromium.

Run: python scripts/verify-resource-cost-browser.py --output /tmp/browser.json
Requires Python Playwright, Chromium, and Node with native TypeScript stripping.
Serves only an explicit in-memory module allowlist on a private loopback port.
Use --offline-document when browser policy prohibits loopback navigation; this
uses native Blob ESM and explicitly skips native localStorage-origin checks.
No credentials, external network, npm install, .git writes, or application API are
used. This is a component regression, not an authenticated/MariaDB end-to-end test.
"""
from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import subprocess
import sys
import threading
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
JS = r'''async ({fixture, locale, sources}) => {
  const results = [];
  const check = (ok, message='assertion failed') => { if (!ok) throw Error(message); };
  const equal = (a,b,message='outputs differ') => check(JSON.stringify(a)===JSON.stringify(b),message);
  const test = async (name,run,requiresStorage=false) => {
    if (requiresStorage && !storageAvailable) {results.push({name,passed:false,skipped:true,reason:'Browser policy prevents a storage-enabled origin; not a native localStorage test.'});return;}
    console.debug('resource-cost test:',locale,name);
    try { await run(); results.push({name,passed:true}); }
    catch(error) { results.push({name,passed:false,error:String(error),stack:error.stack}); }
  };
  const frames = () => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  let storageAvailable=false;
  try {localStorage.setItem('__resource_probe','1');localStorage.removeItem('__resource_probe');storageAvailable=true;} catch {}
  const urls={baseline:{},current:{}};
  function moduleUrl(mode,name) {
    if (!sources) return `/${mode}/${name}`;
    if (urls[mode][name]) return urls[mode][name];
    const source=sources[`/${mode}/${name}`];check(typeof source==='string','module not in allowlist: '+name);
    const rewritten=source.replace(/^(import[^\n]*from ["'])\.\/([^"']+)(["'];)/gm,(_,before,dep,after)=>before+moduleUrl(mode,dep)+after);
    return urls[mode][name]=URL.createObjectURL(new Blob([rewritten],{type:'text/javascript'}));
  }
  const modules = {};
  for (const mode of ['baseline','current']) {
    modules[mode] = {
      database: await import(moduleUrl(mode,'database-block.js')),
      storage: await import(moduleUrl(mode,'storage-snapshot.js'))
    };
    const {setLanguage} = await import(moduleUrl(mode,'i18n.js'));
    setLanguage(['en','ko','ja','de'].includes(locale.split('-')[0]) ? locale.split('-')[0] : 'en', {persist:false});
  }
  await test('native ESM loads with the requested Intl default locale', () => {
    check(new Intl.Collator().resolvedOptions().locale.split('-')[0] === locale.split('-')[0], 'wrong default collator locale');
  });
  for (const property of fixture.properties) {
    await test(`sort/filter parity and input immutability: ${property.type}`, () => {
      for (const direction of ['ascending','descending']) for (const operator of [null,'contains','is_empty','is_not_empty']) {
        const data=structuredClone(fixture), view=data.views[0];
        view.sorts=[{id:'primary',propertyId:property.id,direction},{id:'secondary',propertyId:'number',direction:'ascending'}];
        view.filters=operator?[{id:'filter',propertyId:property.id,operator,value:'a'}]:[];
        const original=JSON.stringify(data), rowReferences=data.rows.slice();
        const before=modules.baseline.database.applyDatabaseView(data,view);
        const after=modules.current.database.applyDatabaseView(data,view);
        equal(after,before); check(JSON.stringify(data)===original,'input was changed');
        after.forEach(row=>check(rowReferences.includes(row),'row identity changed'));
      }
    });
  }
  await test('one lazy collator per text sort, none for numeric/no-sort paths', () => {
    const Original=Intl.Collator; let calls=0;
    Intl.Collator=new Proxy(Original,{construct(target,args){calls++;return Reflect.construct(target,args);}});
    try {
      const data=structuredClone(fixture);
      modules.current.database.applyDatabaseView(data); check(calls===1,'text collator was not reused');
      calls=0;data.views[0].sorts=[{propertyId:'number',direction:'ascending'}];
      modules.current.database.applyDatabaseView(data);check(calls===0,'numeric sort allocated a collator');
      data.views[0].sorts=[];modules.current.database.applyDatabaseView(data);check(calls===0,'unsorted path allocated a collator');
    } finally {Intl.Collator=Original;}
  });
  async function trace(mode,type,action) {
    const api=modules[mode].database;
    const data=structuredClone(fixture);
    // DOM interaction uses 30 rows; sort/filter parity above uses the full 200-row limit.
    data.rows=data.rows.slice(0,30);
    data.views=['table','board','list'].map(viewType=>({...structuredClone(data.views[0]),id:viewType,type:viewType,name:viewType,groupPropertyId:viewType==='board'?'select':null}));
    data.activeViewId=type;
    const row=document.createElement('section'),host=document.createElement('div');
    host.className='block-editor-host';row.append(host);document.body.append(row);
    let dirty=0;
    host.append(api.createDatabaseEditor(row,data,{onDirty:()=>dirty++}));
    const field=(rowId,propertyId)=>row.querySelector(`.database-value-input[data-row-id="${rowId}"][data-property-id="${propertyId}"]`);
    try {
      await action({row,field,dirty:()=>dirty});await frames();
      const result={
        data:api.extractDatabaseData(row),dirty,
        rowIds:[...row.querySelectorAll('[data-database-row-id]')].map(node=>node.dataset.databaseRowId),
        controls:[...row.querySelectorAll('input,textarea,select')].map(node=>({value:node.value,checked:node.checked,disabled:node.disabled,aria:node.getAttribute('aria-label')})),
        markup:row.innerHTML,
        focus:row.contains(document.activeElement)?document.activeElement.className:null
      };
      check(!row.querySelector('script,iframe,img[onerror],svg[onload]'),'untrusted values became executable markup');
      check(!globalThis.__resourceCostXss,'untrusted value executed');
      return result;
    } finally {row.remove();await frames();}
  }
  const compare=async(type,action)=>{
    const before=await trace('baseline',type,action),after=await trace('current',type,action);
    equal(after,before);return after;
  };
  for (const type of ['table','board','list']) {
    await test(`native ${type} DOM, ARIA, controls, and initial metadata parity`,()=>compare(type,()=>{}));
    await test(`native ${type} sorted title edit, search, view switch, and inert markup`,async()=>{
      const result=await compare(type,async({row,field,dirty})=>{
        const title=field('r0','title');check(title,'title field missing');
        title.focus();title.value='<img src=x onerror=globalThis.__resourceCostXss=1> 한글 😀';
        title.dispatchEvent(new Event('input',{bubbles:true}));
        title.dispatchEvent(new Event('change',{bubbles:true}));await frames();
        const count=dirty(),search=row.querySelector('.database-search-input');
        search.value='__resourceCostXss';search.dispatchEvent(new Event('input',{bubbles:true}));
        equal([...row.querySelectorAll('[data-database-row-id]')].map(node=>node.dataset.databaseRowId),['r0']);
        check(dirty()===count,'search unexpectedly marked saved metadata dirty');
        search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));
        row.querySelector('[data-action="database-select-view"][data-view-id="list"]').click();await frames();
      });
      check(result.data.rows.find(row=>row.id==='r0').values.title.includes('__resourceCostXss'));
    });
  }
  const canonical = result => ({keys:result.keys,reliable:result.reliable,error:result.error?String(result.error):null});
  const compareStorage = storage => {
    const before=canonical(modules.baseline.storage.inspectStorageKeys(storage));
    const after=canonical(modules.current.storage.inspectStorageKeys(storage));equal(after,before);return after;
  };
  await test('real localStorage: 5,000 long keys, exact values and reliable enumeration',()=>{
    localStorage.clear();
    for(let index=0;index<5000;index++)localStorage.setItem(`resource:${index}:`+'x'.repeat(120),`value-${index}`);
    const result=compareStorage(localStorage);check(result.reliable);check(result.keys.length===5000);
    result.keys.forEach(key=>check(localStorage.getItem(key)!==null,'value was removed'));
    localStorage.clear();
  },true);
  await test('real localStorage: embedded NUL, combining Unicode, deletion, and empty storage',()=>{
    for(const key of ['a\0b','a','b\0c','😀','e\u0301','é'])localStorage.setItem(key,'unchanged');
    let result=compareStorage(localStorage);check(result.reliable);check(result.keys.length===6);
    localStorage.removeItem('a\0b');result=compareStorage(localStorage);check(result.keys.length===5);
    localStorage.clear();result=compareStorage(localStorage);check(result.reliable&&result.keys.length===0);
  },true);
  await test('storage unavailable and throwing SecurityError preserve fail-closed behavior',()=>{
    check(!compareStorage(null).reliable);
    check(!compareStorage({get length(){throw new DOMException('denied','SecurityError');}}).reliable);
  });
  for (const mode of Object.values(urls)) for (const url of Object.values(mode)) URL.revokeObjectURL(url);
  return {locale,storageAvailable,resolvedLocale:new Intl.Collator().resolvedOptions().locale,results,
    passed:results.filter(result=>result.passed).length,failed:results.filter(result=>!result.passed&&!result.skipped).length,skipped:results.filter(result=>result.skipped).length};
}'''


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--verbose', action='store_true')
    parser.add_argument('--offline-document', action='store_true', help='Use about:blank plus native Blob ESM; explicitly skip real localStorage tests.')
    parser.add_argument('--browser', default=shutil.which('chromium') or shutil.which('google-chrome'))
    args = parser.parse_args()
    if not args.browser:
        parser.error('Chromium is required; provide --browser /path/to/chromium')
    original = json.loads((ROOT/'tests/fixtures/resource-cost-baseline.json').read_text())
    sources = {}
    for mode in ['baseline', 'current']:
        for name in ['database-block.js', 'storage-snapshot.js', 'i18n.js', 'summary-prefix.js']:
            record = original['files'].get('public/'+name) if mode == 'baseline' else None
            body = record['source'].encode() if record else (ROOT/'public'/name).read_bytes()
            if record and hashlib.sha256(body).hexdigest() != record['sha256']:
                raise ValueError('Baseline checksum mismatch: '+name)
            sources[f'/{mode}/{name}'] = body
    fixture = json.loads(subprocess.check_output([
        'node', '--input-type=module', '-e',
        "import {databaseFixture} from './tests/helpers/resource-cost-harness.mjs';console.log(JSON.stringify(databaseFixture()));"
    ], cwd=ROOT, text=True))

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path == '/':
                body = b'<!doctype html><meta charset="utf-8"><title>Isolated resource regression</title><body></body>'
                content_type = 'text/html; charset=utf-8'
            elif path in sources:
                body, content_type = sources[path], 'text/javascript; charset=utf-8'
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{server.server_port}'
    report = {'scope': 'Complete original/current native ESM and real Chromium DOM; native localStorage checks only when a storage-enabled origin is available. Not authenticated API/database E2E.', 'runs': [], 'pageErrors': []}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox'])
            report['browserVersion'] = browser.version
            for locale in ['en-US', 'ko-KR', 'ja-JP', 'de-DE', 'sv-SE', 'tr-TR']:
                context = browser.new_context(locale=locale)
                context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin+'/') else route.abort())
                page = context.new_page()
                if args.verbose:
                    page.on('console', lambda message: print(message.text, flush=True))
                page.on('pageerror', lambda error, current=locale: report['pageErrors'].append({'locale': current, 'error': str(error)}))
                if args.offline_document:
                    page.set_content('<!doctype html><meta charset="utf-8"><body></body>')
                else:
                    page.goto(origin)
                payload = {'fixture': fixture, 'locale': locale, 'sources': {key: body.decode() for key, body in sources.items()} if args.offline_document else None}
                report['runs'].append(page.evaluate(JS, payload))
                context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    report['passed'] = sum(run['passed'] for run in report['runs'])
    report['failed'] = sum(run['failed'] for run in report['runs'])
    report['skipped'] = sum(run['skipped'] for run in report['runs'])
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text+'\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'runs'}, indent=2))
    return 1 if report['failed'] or report['pageErrors'] else 0


if __name__ == '__main__':
    sys.exit(main())
