#!/usr/bin/env python3
"""Real Chromium chronological-sort / timetable UI regression versus uploaded code.
Run: python scripts/verify-chronological-sort-browser.py --output /tmp/sort-browser.json
Requires Python Playwright and Chromium. No application services or npm packages.
Native Blob ESM rewrites import URLs only. Test UUIDs are deterministic. This is a
component test, NOT an authenticated HTTP/CSP/database or server E2E test.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
JS = r'''async ({sources, appSources, locale, timezone}) => {
 const results=[], urls={baseline:{},current:{}};
 const check=(ok,msg='assertion failed')=>{if(!ok)throw Error(msg);};
 const equal=(a,b)=>check(JSON.stringify(a)===JSON.stringify(b),'original/current mismatch');
 const test=async(name,run)=>{try{await run();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:String(e),stack:e.stack});}};
 let uuid=0;Object.defineProperty(globalThis.crypto,'randomUUID',{configurable:true,value:()=>`browser-audit-${++uuid}`});
 function url(mode,name) {
   if(urls[mode][name])return urls[mode][name];
   const source=sources[mode][name];check(typeof source==='string','missing dependency '+name);
   const rewritten=source.replace(/^(import[^\n]*from ["'])\.\/([^"']+)(["'];)/gm,(_,a,d,b)=>a+url(mode,d)+b);
   return urls[mode][name]=URL.createObjectURL(new Blob([rewritten],{type:'text/javascript'}));
 }
 const modules={};
 for(const mode of ['baseline','current']) {modules[mode]=await import(url(mode,'timetable-block.js'));(await import(url(mode,'i18n.js'))).setLanguage(locale.split('-')[0],{persist:false});}
 const app={};
 for(const mode of ['baseline','current']) {
   let dates=0;class CountedDate extends Date{constructor(...args){super(...args);dates++;}}
   const state={navigationPageOrder:new Map()};
   app[mode]={...new Function('Date','state',appSources[mode]+'\nreturn {sortByRecent,sortByNavigationOrder,compareNavigationOrder};')(CountedDate,state),state,reset(){dates=0;},count(){return dates;}};
 }
 const pages=Array.from({length:5000},(_,i)=>({id:`page-${i}`,updatedAt:new Date(Date.UTC(2026,0,1)+((i*7919)%50001)*1000).toISOString()}));
 for(const method of ['sortByRecent','sortByNavigationOrder']) await test(method+': exact 5000-page order; date allocations reduced',()=>{
   app.baseline.reset();app.current.reset();equal(app.baseline[method](pages),app.current[method](pages));
   check(app.baseline.count()>pages.length*2,'baseline workload not reproduced');check(app.current.count()===5000,'timestamps not parsed once per item');
 });
 await test('navigation rank priority and incremental comparator, no date work',()=>{
   for(const api of Object.values(app)){api.state.navigationPageOrder=new Map(pages.map((p,i)=>[p.id,i]));api.reset();}
   equal(app.baseline.sortByNavigationOrder(pages),app.current.sortByNavigationOrder(pages));
   for(const api of Object.values(app)){check(api.count()===0);api.state.navigationPageOrder=new Map();}
   check(Object.is(app.baseline.compareNavigationOrder({id:'I',updatedAt:'invalid'},{id:'İ',updatedAt:'2026-01-01'}),app.current.compareNavigationOrder({id:'I',updatedAt:'invalid'},{id:'İ',updatedAt:'2026-01-01'})));
 });
 await test('500 seeded mixed ranks, equal/invalid dates, duplicate IDs and in-place edits',()=>{
   let seed=9172026;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
   const dates=['invalid',null,undefined,'2026-01-01','2026-01-01T09:00:00+09:00','2026-01-01T01:00:00Z'];
   const data=Array.from({length:90},(_,i)=>({id:['I','İ','ı','한글','😀',`p-${i}`][i%6],updatedAt:dates[i%dates.length]}));
   for(let i=0;i<500;i++) {
     data[Math.floor(rnd()*data.length)].updatedAt=dates[Math.floor(rnd()*dates.length)];
     const rank=new Map(data.filter(()=>rnd()<0.3).map(p=>[p.id,Math.floor(rnd()*4)]));
     for(const api of Object.values(app))api.state.navigationPageOrder=rank;
     const before=JSON.stringify(data);for(const method of ['sortByRecent','sortByNavigationOrder'])equal(app.baseline[method](data),app.current[method](data));check(before===JSON.stringify(data));
   }
 });
 const time=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
 const fixture=(n=10)=>({title:'시간표 <&> 😀',date:'2026-09-17',interval:1,entries:Array.from({length:n},(_,i)=>{const start=(i*127)%1400;return {id:`entry-${i}`,start:time(start),end:time(start+30),title:`일정 ${i}`,note:`메모 ${i}`,completed:i%3===0};})});
 function countTime(run){let calls=0;const orig=RegExp.prototype.exec;RegExp.prototype.exec=function(...a){if(this.source==='^([01]\\d|2[0-3]):([0-5]\\d)$')calls++;return Reflect.apply(orig,this,a);};try{return{value:run(),calls};}finally{RegExp.prototype.exec=orig;}}
 await test('200-entry normalization: identical data; only 400 required time parses',()=>{
   const a=countTime(()=>modules.baseline.normalizeTimetableData(fixture(200))),b=countTime(()=>modules.current.normalizeTimetableData(fixture(200)));equal(a.value,b.value);check(a.calls>400,`baseline ${a.calls}`);check(b.calls===400,`current ${b.calls}`);
 });
 await test('all 1440 minute values: exact normalization, range repair and stable ties',()=>{
   for(let minute=0;minute<1440;minute++){const data=fixture(6);for(let i=0;i<6;i++){data.entries[i].start=time(minute);data.entries[i].end=time((minute+i)%1440);}equal(modules.baseline.normalizeTimetableData(data),modules.current.normalizeTimetableData(data));}
 });
 const frames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 async function trace(mode,scenario) {
   uuid=0;const m=modules[mode],row=document.createElement('section');row.className='editor-block-row';const host=document.createElement('div');host.className='block-editor-host';row.append(host);document.body.append(row);
   const data=fixture(scenario==='cap'?200:scenario==='empty'?0:10);if(scenario==='ties')data.entries.forEach(e=>{e.start='09:00';e.end='10:00';});
   let dirty=0,confirmations=0;const originalConfirm=window.confirm;let confirmResult=true;window.confirm=()=>{confirmations++;return confirmResult;};
   host.append(m.createTimetableEditor(row,data,{onDirty:()=>dirty++}));
   const q=s=>{const el=row.querySelector(s);check(el,'missing '+s);return el;};
   const input=(selector,value,event='input')=>{const field=q(selector);field.focus();field.value=value;field.dispatchEvent(new Event(event,{bubbles:true}));return field;};
   const stored=()=>m.extractTimetableData(row);
   const state=()=>({data:stored(),dirty,confirmations,markup:host.innerHTML,fields:[...row.querySelectorAll('input')].map(e=>({value:e.value,checked:e.checked,disabled:e.disabled})),focus:row.contains(document.activeElement)?{className:document.activeElement.className,entryId:document.activeElement.dataset.entryId,field:document.activeElement.dataset.field}:null});
   try {
     await frames();const states=[state()];
     if(scenario==='time-edit') {
       for(const [field,value] of [['start','20:00'],['end','19:00'],['start','23:59'],['end',''],['start','00:00']]) {
         const before=stored(),previousDirty=dirty;input(`.timetable-time-input[data-entry-id="entry-1"][data-field="${field}"]`,value,'change');await frames();
         if(value===''){equal(stored(),before);check(dirty===previousDirty,'invalid time dirtied');}
         else{check(dirty===previousDirty+1);check(document.activeElement.dataset.entryId==='entry-1'&&document.activeElement.dataset.field===field,'focus lost after resort');}
         states.push(state());
       }
     } else if(scenario==='add-delete') {
       for(let i=0;i<3;i++){const quick=row.querySelectorAll('.timetable-quick-time');quick[0].value=i===2?'23:59':'09:00';quick[1].value=i===2?'00:00':'10:00';q('[data-action="timetable-add-entry"]').click();await frames();check(document.activeElement.classList.contains('timetable-entry-title'));states.push(state());}
       check(stored().entries.length===13);confirmResult=false;q('[data-action="timetable-delete-entry"]').click();await frames();check(stored().entries.length===13);states.push(state());
       confirmResult=true;q('[data-action="timetable-delete-entry"]').click();await frames();check(stored().entries.length===12);check(dirty===4);states.push(state());
     } else if(scenario==='text-complete') {
       for(const [selector,value] of [['.timetable-title-input','한글 <img src=x onerror="globalThis.auditPwned=1">'],['.timetable-entry-title','<script>globalThis.auditPwned=1</script>'+ '제목'.repeat(100)],['.timetable-entry-note','<svg onload="globalThis.auditPwned=1">'+'메모'.repeat(400)]]) {const field=input(selector,value);field.setSelectionRange(1,3);check(document.activeElement===field);states.push(state());}
       const box=q('.timetable-complete-input');box.checked=!box.checked;box.dispatchEvent(new Event('change',{bubbles:true}));await frames();check(dirty===4);const value=stored();check(value.entries[0].title.length<=160&&value.entries[0].note.length<=500);states.push(state());
     } else if(scenario==='dates') {
       for(const value of ['2028-02-29','','2026-12-31']){const before=stored(),n=dirty;input('.timetable-date-input',value,'change');await frames();if(!value){equal(stored(),before);check(dirty===n);}states.push(state());}
       for(const action of ['timetable-next-day','timetable-previous-day','timetable-today']){q(`[data-action="${action}"]`).click();await frames();check(document.activeElement.classList.contains('timetable-date-input'));states.push(state());}
     } else if(scenario.startsWith('readonly')) {
       if(scenario==='readonly-aria')row.setAttribute('aria-readonly','true');else row.classList.add('is-read-only');
       const before=stored();input('.timetable-title-input','blocked');input('.timetable-entry-title','blocked');input('.timetable-time-input','02:03','change');input('.timetable-date-input','2030-01-01','change');const box=q('.timetable-complete-input');box.checked=!box.checked;box.dispatchEvent(new Event('change',{bubbles:true}));
       for(const action of ['timetable-add-entry','timetable-delete-entry','timetable-next-day'])q(`[data-action="${action}"]`).dispatchEvent(new MouseEvent('click',{bubbles:true}));await frames();equal(stored(),before);check(dirty===0&&confirmations===0,'read-only mutation');states.push(state());
     } else if(scenario==='cap') {const before=stored();check(q('[data-action="timetable-add-entry"]').disabled);q('[data-action="timetable-add-entry"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));await frames();equal(stored(),before);check(dirty===0);states.push(state());}
     else if(scenario==='empty'){check(q('.timetable-empty-row'));q('[data-action="timetable-add-entry"]').click();await frames();check(stored().entries.length===1&&dirty===1);states.push(state());}
     else if(scenario==='ties')equal(stored().entries.map(e=>e.id),data.entries.map(e=>e.id));
     check(globalThis.auditPwned===undefined,'literal content executed');check(!row.querySelector('script,img,svg'),'literal content became executable markup');return states;
   } finally {window.confirm=originalConfirm;row.remove();await frames();}
 }
 for(const scenario of ['initial','time-edit','add-delete','text-complete','dates','readonly-aria','readonly-class','cap','empty','ties'])await test('real DOM, focus, dirty counts and serialization parity: '+scenario,async()=>equal(await trace('baseline',scenario),await trace('current',scenario)));
 for(const cache of Object.values(urls))for(const value of Object.values(cache))URL.revokeObjectURL(value);
 return {locale,timezone,resolvedLocale:Intl.DateTimeFormat().resolvedOptions().locale,results,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length};
}'''

def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--browser',default=shutil.which('chromium') or shutil.which('google-chrome'))
    args=parser.parse_args()
    if not args.browser: parser.error('Chromium executable not found; use --browser /path/to/chromium')
    baseline=json.loads((ROOT/'tests/fixtures/chronological-sort-resource-baseline.json').read_text())
    for path,record in baseline['files'].items():
        if hashlib.sha256(record['source'].encode()).hexdigest()!=record['sourceSha256']:raise ValueError('Original checksum mismatch: '+path)
    sources={};apps={}
    for mode in ['baseline','current']:
        sources[mode]={}
        def collect(name: str) -> None:
            if name in sources[mode]:return
            record=baseline['files'].get('public/'+name) if mode=='baseline' else None
            source=record['source'] if record else (ROOT/'public'/name).read_bytes().decode()
            sources[mode][name]=source
            for dep in re.findall(r'^import[^\n]*from ["\']\./([^"\']+)["\'];',source,re.M):collect(dep)
        collect('timetable-block.js')
        record=baseline['files']['public/app.js']
        if mode=='baseline':apps[mode]=record['source']
        else:
            source=(ROOT/'public/app.js').read_bytes().decode();start=source.index(record['startMarker']);end=source.index(record['endMarker'],start);apps[mode]=source[start:end]
    report={'scope':__doc__,'originalArchiveSha256':baseline['inputArchiveSha256'],'runs':[],'pageErrors':[]}
    configs=[('en-US','UTC'),('ko-KR','Asia/Seoul'),('ja-JP','Asia/Tokyo'),('de-DE','Europe/Berlin'),('sv-SE','America/New_York'),('tr-TR','Pacific/Auckland')]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=args.browser,headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
        try:
            report['browserVersion']=browser.version
            for locale,timezone in configs:
                context=browser.new_context(locale=locale,timezone_id=timezone)
                try:
                    context.route('**/*',lambda route:route.abort())
                    page=context.new_page();page.on('pageerror',lambda e,lang=locale:report['pageErrors'].append({'locale':lang,'error':str(e)}))
                    page.set_content('<!doctype html><meta charset="utf-8"><title>Chronological sort regression</title><body></body>')
                    report['runs'].append(page.evaluate(JS,{'sources':sources,'appSources':apps,'locale':locale,'timezone':timezone}))
                finally:context.close()
        finally:browser.close()
    report['passed']=sum(run['passed'] for run in report['runs']);report['failed']=sum(run['failed'] for run in report['runs'])
    text=json.dumps(report,ensure_ascii=False,indent=2)+'\n'
    if args.output:args.output.write_text(text)
    print(text)
    return 1 if report['failed'] or report['pageErrors'] else 0
if __name__=='__main__':raise SystemExit(main())
