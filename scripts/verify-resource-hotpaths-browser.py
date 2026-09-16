#!/usr/bin/env python3
"""Real Chromium regression against the exact uploaded database module.
Requires Python Playwright, Chromium, and a project-supported Node runtime.
Run: python scripts/verify-resource-hotpaths-browser.py --output result.json
Native Blob ESM is used because no application services are needed. This is not
HTTP/CSP/authentication/database E2E. No package, README, docs, or .git writes.
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
JS = r'''async ({sources, fixture, locale}) => {
 const urls = {baseline:{},current:{}}, results = [];
 const check = (ok, msg='assertion failed') => { if (!ok) throw Error(msg); };
 const equal = (a,b) => check(JSON.stringify(a)===JSON.stringify(b),'original/current mismatch');
 const test = async (name, run) => {try {await run();results.push({name,passed:true});} catch(e) {results.push({name,passed:false,error:String(e),stack:e.stack});}};
 function url(mode, name) {
   if(urls[mode][name]) return urls[mode][name];
   const source=sources[mode][name];check(source!==undefined,'missing dependency '+name);
   const rewritten=source.replace(/^(import[^\n]*from ["'])\.\/([^"']+)(["'];)/gm,(_,a,d,b)=>a+url(mode,d)+b);
   return urls[mode][name]=URL.createObjectURL(new Blob([rewritten],{type:'text/javascript'}));
 }
 const modules={}, languages={};
 for(const mode of ['baseline','current']) {
   modules[mode]=await import(url(mode,'database-block.js'));
   languages[mode]=await import(url(mode,'i18n.js'));
   languages[mode].setLanguage(locale.split('-')[0],{persist:false});
 }
 function count(run) {
   let calls=0,units=0;const original=String.prototype.toLocaleLowerCase;
   String.prototype.toLocaleLowerCase=function(...args){calls++;units+=String(this).length;return Reflect.apply(original,this,args);};
   try{return {value:run(),calls,units};}finally{String.prototype.toLocaleLowerCase=original;}
 }
 await test('native browser text filtering: 3200 -> 1608 normalizations; exact rows, immutable input',()=>{
   const bytes=JSON.stringify(fixture),a=count(()=>modules.baseline.applyDatabaseView(fixture)),b=count(()=>modules.current.applyDatabaseView(fixture));
   equal(a.value,b.value);check(a.calls===3200&&b.calls===1608,`${a.calls} / ${b.calls}`);
   check(a.units-b.units===796000);check(JSON.stringify(fixture)===bytes);
   b.value.forEach((r,i)=>check(r===fixture.rows[i],'row identity changed'));
 });
 await test('empty filter text and subsequent in-place edits never reuse stale values',()=>{
   const data=structuredClone(fixture);data.views[0].filters=data.views[0].filters.slice(0,1);
   for(const value of ['', 'I', 'İ', 'ı', '한글😀', '<script>', null, 0, 'AB가😀'.repeat(100)]) {
     data.views[0].filters[0].value=value;data.rows[0].values.text_0=String(value??'');
     equal(modules.baseline.applyDatabaseView(data),modules.current.applyDatabaseView(data));
   }
 });
 await test('short-circuited and empty-row views never normalize unreachable filter text',()=>{
   const data=structuredClone(fixture);data.views[0].filters.unshift({id:'empty_gate',propertyId:'title',operator:'is_empty',value:''});
   check(count(()=>modules.current.applyDatabaseView(data)).calls===0);
   data.rows=[];check(count(()=>modules.current.applyDatabaseView(data)).calls===0);
 });
 const frames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 function uiFixture() {
   const data=structuredClone(fixture);data.rows=data.rows.slice(0,12);data.properties=data.properties.slice(0,3);
   data.rows.forEach(row=>{for(const key of Object.keys(row.values))if(!data.properties.some(p=>p.id===key))delete row.values[key];});
   data.views[0].filters=data.views[0].filters.slice(0,2);
   data.views=['table','list','board'].map(type=>({...structuredClone(data.views[0]),id:type,name:type,type,
     filters:data.views[0].filters.map(f=>({...f,id:type+'_'+f.id}))}));
   data.activeViewId='table';return data;
 }
 async function trace(mode, scenario) {
   const m=modules[mode],row=document.createElement('section');row.className='editor-block-row';
   const host=document.createElement('div');host.className='block-editor-host';row.append(host);document.body.append(row);
   let dirty=0;host.append(m.createDatabaseEditor(row,uiFixture(),{onDirty:()=>dirty++}));
   const state=()=>({data:m.extractDatabaseData(row),dirty,markup:host.innerHTML,
     fields:[...row.querySelectorAll('input,textarea,select')].map(f=>({value:f.value,checked:f.checked,disabled:f.disabled})),
     rowIds:[...row.querySelectorAll('[data-database-row-id]')].map(e=>e.dataset.databaseRowId)});
   try {
     await frames();const states=[state()];
     if(scenario==='views') {
       for(const id of ['list','board','table','list','table']) {row.querySelector(`[data-action="database-select-view"][data-view-id="${id}"]`).click();await frames();states.push(state());}
     } else if(scenario==='remove-filter') {
       for(let i=0;i<2;i++){row.querySelector('[data-action="database-remove-filter"]').click();await frames();states.push(state());}
       check(m.extractDatabaseData(row).views[0].filters.length===0);check(dirty===2);
     } else if(scenario==='search') {
       for(const q of ['Row 1','no-such-row','', '<script>']) {const f=row.querySelector('.database-search-input');f.value=q;f.dispatchEvent(new Event('input',{bubbles:true}));await frames();states.push(state());}
       check(dirty===0,'search must not mutate stored data');
     } else if(scenario==='edit') {
       const title=row.querySelector('.database-title-input');title.focus();title.value='한글 <img src=x onerror="globalThis.auditPwned=1">';title.setSelectionRange(2,4);title.dispatchEvent(new Event('input',{bubbles:true}));
       check(document.activeElement===title&&title.selectionStart===2&&title.selectionEnd===4,'title focus/caret moved');states.push(state());
       const field=row.querySelector('.database-value-input');check(field,'missing cell');field.focus();field.value='수정 <script>globalThis.auditPwned=1</script> 😀';field.setSelectionRange(1,3);field.dispatchEvent(new Event('input',{bubbles:true}));
       check(document.activeElement===field&&field.selectionStart===1&&field.selectionEnd===3,'cell focus/caret moved');
       check(dirty===2);await frames();states.push(state());
       const stored=m.extractDatabaseData(row);check(stored.title.startsWith('한글'));check(JSON.stringify(stored).includes('수정'));
     }
     check(globalThis.auditPwned===undefined,'literal HTML executed');return states;
   } finally {row.remove();await frames();}
 }
 for(const scenario of ['initial','views','remove-filter','search','edit']) await test('real DOM/original parity: '+scenario,async()=>equal(await trace('baseline',scenario),await trace('current',scenario)));
 const servedModules=Object.fromEntries(Object.entries(urls).map(([mode,cache])=>[mode,Object.keys(cache)]));
 for(const cache of Object.values(urls))for(const value of Object.values(cache))URL.revokeObjectURL(value);
 return {locale,resolvedLocale:Intl.DateTimeFormat().resolvedOptions().locale,servedModules,results,
   passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length};
}'''


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--browser', default=shutil.which('chromium') or shutil.which('google-chrome'))
    args = parser.parse_args()
    if not args.browser:
        parser.error('Chromium executable not found; use --browser /path/to/chromium')
    baseline = json.loads((ROOT / 'tests/fixtures/resource-hotpaths-baseline.json').read_text())
    sources = {}
    for mode in ['baseline', 'current']:
        sources[mode] = {}
        def collect(name: str) -> None:
            if name in sources[mode]:
                return
            record = baseline['files'].get('public/' + name) if mode == 'baseline' else None
            if record:
                source = record['source']
                if hashlib.sha256(source.encode()).hexdigest() != record['sha256']:
                    raise ValueError('Original source checksum mismatch: ' + name)
            else:
                source = (ROOT / 'public' / name).read_text()
            sources[mode][name] = source
            for dep in re.findall(r'^import[^\n]*from ["\']\./([^"\']+)["\'];', source, re.M):
                collect(dep)
        collect('database-block.js')
    fixture = json.loads(subprocess.check_output(['node', '--experimental-strip-types', '--input-type=module', '-e',
        "import {filterFixture} from './tests/helpers/resource-hotpaths-harness.mjs';console.log(JSON.stringify(filterFixture()));"], cwd=ROOT, text=True))
    report = {'scope': 'Exact uploaded/current source, real Chromium DOM, native Blob ESM; only import URLs rewritten. No authenticated API, HTTP/CSP, localStorage origin, or live database E2E.',
        'runs': [], 'pageErrors': []}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox','--disable-dev-shm-usage'])
        try:
            report['browserVersion'] = browser.version
            for locale in ['en-US','ko-KR','ja-JP','de-DE','sv-SE','tr-TR']:
                context = browser.new_context(locale=locale)
                try:
                    context.route('**/*', lambda route: route.abort())
                    page = context.new_page()
                    page.on('pageerror', lambda error, lang=locale: report['pageErrors'].append({'locale':lang,'error':str(error)}))
                    page.set_content('<!doctype html><meta charset="utf-8"><title>Hot-path regression</title><body></body>')
                    report['runs'].append(page.evaluate(JS, {'sources':sources,'fixture':fixture,'locale':locale}))
                finally:
                    context.close()
        finally:
            browser.close()
    report['passed'] = sum(run['passed'] for run in report['runs'])
    report['failed'] = sum(run['failed'] for run in report['runs'])
    text = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.write_text(text)
    print(text)
    return 1 if report['failed'] or report['pageErrors'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
