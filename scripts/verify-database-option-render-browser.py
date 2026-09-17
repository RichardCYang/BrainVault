#!/usr/bin/env python3
"""Offline Chromium differential tests of exact uploaded/current database modules.
No npm dependencies or network. Requires Python Playwright and installed Chromium.
Not authenticated HTTP/MariaDB/full-application E2E testing.
Run: python scripts/verify-database-option-render-browser.py --output result.json
"""
import argparse
import json
import shutil
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
JS = r'''async ({sources, i18nSource, summarySource, fixture, large, locale}) => {
  const results=[], urls=[];
  const check=(value,message='assertion failed')=>{if(!value)throw Error(message)};
  const same=(a,b,message='original/current differs')=>check(JSON.stringify(a)===JSON.stringify(b),message);
  const test=async(name,fn)=>{try{await fn();results.push({name,passed:true})}catch(e){results.push({name,passed:false,error:String(e),stack:e.stack})}};
  const blob=source=>{const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));urls.push(url);return url};
  const i18nUrl=blob(i18nSource),summaryUrl=blob(summarySource);
  (await import(i18nUrl)).setLanguage(locale.split('-')[0],{persist:false});
  const modules={};
  for(const mode of ['before','after']) modules[mode]=await import(blob(sources[mode]
    .replaceAll('"./i18n.js"',JSON.stringify(i18nUrl)).replaceAll('"./summary-prefix.js"',JSON.stringify(summaryUrl))));
  function editor(mode,input){
    const row=document.createElement('article');row.className='editor-block-row';row.dataset.blockId='database-block';
    const host=document.createElement('div');host.className='block-editor-host';row.append(host);document.body.append(row);
    let dirty=0;host.append(modules[mode].createDatabaseEditor(row,structuredClone(input),{onDirty:()=>dirty++}));
    return {row,host,data:()=>modules[mode].extractDatabaseData(row),get dirty(){return dirty}};
  }
  const search=(h,query)=>{const control=h.host.querySelector('.database-search-input');check(control);control.value=query;control.dispatchEvent(new Event('input',{bubbles:true}))};
  const ids=h=>[...h.host.querySelectorAll('[data-database-row-id]')].map(el=>el.dataset.databaseRowId);
  for(const view of ['table','list','board']) await test(`${view}: real search input preserves visible rows, markup, model and dirty callbacks`,()=>{
    const input=structuredClone(fixture);input.views[0].type=view;
    const a=editor('before',input),b=editor('after',input);const before=JSON.stringify(b.data());
    try{for(const query of ['','한글','first','😀','<img','MISSING','row 2','İ','  ']){
      search(a,query);search(b,query);same(ids(a),ids(b));
      check(a.host.innerHTML===b.host.innerHTML,'search DOM mismatch');same(a.data(),b.data());
      check(JSON.stringify(b.data())===before && a.dirty===0 && b.dirty===0,'search changed persisted data');
    }}finally{a.row.remove();b.row.remove()}
  });
  await test('option rename immediately updates search and summaries without stale cached names',()=>{
    const a=editor('before',fixture),b=editor('after',fixture);
    try{
      for(const h of [a,b]) {
        search(h,'renamed');check(ids(h).length===0);
        const control=h.host.querySelector('.database-property-item[data-property-id="p1"] .database-property-options');
        check(control);control.value='Renamed, Second, Third';control.dispatchEvent(new Event('change',{bubbles:true}));
        search(h,'renamed');check(ids(h).length>0,'new label not searchable');
      }
      same(a.data(),b.data());same(ids(a),ids(b));check(a.dirty===b.dirty && b.dirty===1);
      check(modules.after.summarizeDatabaseData(b.data())===modules.before.summarizeDatabaseData(a.data()));
    }finally{a.row.remove();b.row.remove()}
  });
  await test('property type changes and later searches do not retain obsolete option data',()=>{
    const a=editor('before',fixture),b=editor('after',fixture);
    try{for(const type of ['text','select','multi_select','number']){
      for(const h of [a,b]){
        const control=h.host.querySelector('.database-property-item[data-property-id="p1"] .database-property-type');
        control.value=type;control.dispatchEvent(new Event('change',{bubbles:true}));search(h,'first');
      }
      same(a.data(),b.data());same(ids(a),ids(b));check(a.dirty===b.dirty);
      check(a.host.innerHTML===b.host.innerHTML);
    }}finally{a.row.remove();b.row.remove()}
  });
  await test('native Chromium maximum-size search and summary exactly match the uploaded module',()=>{
    const input=modules.after.normalizeDatabaseData(large),bytes=JSON.stringify(input);
    for(const query of ['not-a-match','항목','😀','row 100','']) same(
      modules.after.applyDatabaseSearch(input,input.rows,query),modules.before.applyDatabaseSearch(input,input.rows,query));
    check(modules.after.summarizeDatabaseData(input)===modules.before.summarizeDatabaseData(input));
    check(JSON.stringify(input)===bytes,'source data mutated');
  });
  await test('untrusted option labels remain inert DOM text after a search rerender',()=>{
    const input=structuredClone(fixture);
    input.properties[1].options[0].name='<img src=x onerror="globalThis.auditInjected=1">';
    const a=editor('before',input),b=editor('after',input);globalThis.auditInjected=0;
    try{
      search(a,'<img');search(b,'<img');check(a.host.innerHTML===b.host.innerHTML);
      check(!b.host.querySelector('img,script,svg,[onerror],[onload]'),'active injected element');
      check(globalThis.auditInjected===0);same(a.data(),b.data());
    }finally{a.row.remove();b.row.remove()}
  });
  await test('new editors with identical IDs and different labels remain isolated',()=>{
    for(let i=0;i<20;i++){
      const input=structuredClone(fixture);input.properties[1].options[0].name='Independent '+i;
      const a=editor('before',input),b=editor('after',input);
      try{search(a,'Independent '+i);search(b,'Independent '+i);same(ids(a),ids(b));check(ids(b).length>0);
        check(modules.after.summarizeDatabaseData(b.data())===modules.before.summarizeDatabaseData(a.data()));
      }finally{a.row.remove();b.row.remove()}
    }
  });
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  urls.forEach(url=>URL.revokeObjectURL(url));
  return {locale,results,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length};
}'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--browser', default=shutil.which('chromium') or shutil.which('google-chrome'))
    args = parser.parse_args()
    if not args.browser:
        parser.error('Chromium not found; specify --browser')
    payload = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', '''
      import { executableSource, fixture, baseline } from './tests/helpers/database-option-render-harness.mjs';
      const small=fixture({rows:8,properties:3,options:3});
      small.properties[1].options.forEach((o,i)=>o.name=['First','Second','Third'][i]);
      console.log(JSON.stringify({sources:{before:executableSource('client','baseline'),after:executableSource('client')},
        fixture:small,large:fixture(),originalArchiveSha256:baseline.sourceArchiveSha256}));
    '''], cwd=ROOT, text=True))
    payload['i18nSource'] = (ROOT / 'public/i18n.js').read_text()
    payload['summarySource'] = (ROOT / 'public/summary-prefix.js').read_text()
    report = {'scope': __doc__, 'originalArchiveSha256': payload.pop('originalArchiveSha256'), 'runs': [], 'pageErrors': []}
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
                    page.set_content('<!doctype html><meta charset="utf-8"><title>Database search differential regression</title><body>')
                    report['runs'].append(page.evaluate(JS, {**payload, 'locale': locale}))
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
