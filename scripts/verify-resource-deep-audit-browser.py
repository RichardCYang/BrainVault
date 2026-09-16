#!/usr/bin/env python3
"""Actual Chromium/native-ESM component regression against this audit's original.
Run: python scripts/verify-resource-deep-audit-browser.py --output result.json
Requires Python Playwright, Chromium, Node with --experimental-strip-types.
Modules load as native ESM Blob URLs with only import specifiers rewritten; no external network,
credentials, database, npm installation, or .git access is used.
This is NOT a logged-in application/API/database end-to-end security test.
"""
import argparse, json, shutil, subprocess
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path)
parser.add_argument('--browser', default=shutil.which('chromium') or shutil.which('google-chrome'))
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
baseline=json.loads((root/'tests/fixtures/resource-deep-audit-baseline.json').read_text())
generate="""import {kinds,fixture} from './tests/helpers/resource-deep-audit-harness.mjs';
console.log(JSON.stringify(Object.fromEntries(kinds.map(k=>[k,{normal:fixture(k),large:fixture(k,{large:true}),tail:fixture(k,{large:true,count:k==='ai-chat'?2:k==='accordion'||k==='treeview'?4:2})}]))));"""
payload=json.loads(subprocess.check_output(['node','--experimental-strip-types','--input-type=module','-e',generate],cwd=root,text=True))
sources={}
for mode in ['baseline','current']:
    sources[mode]={}
    def collect(name):
        if name in sources[mode]:return
        record=baseline['files'].get('public/'+name) if mode=='baseline' else None
        source=record['source'] if record else (root/'public'/name).read_text()
        sources[mode][name]=source
        for dep in re.findall(r'^import[^\n]*from [\"\']\./([^\"\']+)[\"\'];',source,re.M):collect(dep)
    for kind in payload:collect(kind+'-block.js')
payload={'fixtures':payload,'sources':sources}
js=r'''async payload => {
 const {fixtures,sources}=payload, urls={baseline:{},current:{}};
 function moduleUrl(mode,name) {
   if(urls[mode][name])return urls[mode][name];
   const source=sources[mode][name];if(source===undefined)throw Error('Missing native dependency '+mode+'/'+name);
   const rewritten=source.replace(/^(import[^\n]*from ["'])\.\/([^"']+)(["'];)/gm,(_,before,dep,after)=>before+moduleUrl(mode,dep)+after);
   return urls[mode][name]=URL.createObjectURL(new Blob([rewritten],{type:'text/javascript'}));
 }
 const results=[], modules={}, kinds=Object.keys(fixtures);
 const names={'ai-chat':'AiChat',accordion:'Accordion',database:'Database',timetable:'Timetable',gantt:'Gantt',treeview:'TreeView'};
 const check=(x,msg='assertion failed')=>{if(!x)throw Error(msg);};
 const equal=(a,b)=>check(JSON.stringify(a)===JSON.stringify(b),'different serialized data');
 const test=async(name,fn)=>{const start=performance.now();try{await fn();results.push({name,passed:true,ms:performance.now()-start});}catch(e){results.push({name,passed:false,error:String(e),stack:e.stack});}};
 const i18n={baseline:await import(moduleUrl('baseline','i18n.js')),current:await import(moduleUrl('current','i18n.js'))};
 const frames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 for(const kind of kinds){
   modules[kind]={};
   await test(kind+': native ESM and real imported dependencies load',async()=>{
     for(const mode of ['baseline','current']){
       const m=await import(moduleUrl(mode,`${kind}-block.js`)),n=names[kind];
       modules[kind][mode]={normalize:m[`normalize${n}Data`],summarize:m[`summarize${n}Data`],create:m[`create${n}Editor`],extract:m[`extract${n}Data`]};
       check(Object.values(modules[kind][mode]).every(x=>typeof x==='function'));
     }
   });
   for(const size of ['normal','large'])await test(`${kind}: ${size} summary/full metadata exact original parity`,()=>{
      const input=fixtures[kind][size],before=JSON.stringify(input),a=modules[kind].baseline,b=modules[kind].current;
      equal(a.normalize(input),b.normalize(input));check(a.summarize(input)===b.summarize(input));check(b.summarize(input).length<=20000);check(JSON.stringify(input)===before);
   });
 }
 for(const lang of ['en','ko','ja','fr','de','es','pt']){
   for(const m of Object.values(i18n))m.setLanguage(lang,{persist:false});
   for(const kind of kinds)await test(`${kind}: ${lang} browser locale parity`,()=>{
     equal(modules[kind].baseline.summarize(fixtures[kind].large),modules[kind].current.summarize(fixtures[kind].large));
   });
 }
 for(const m of Object.values(i18n))m.setLanguage('en',{persist:false});
 const titleSelectors={'ai-chat':'.ai-chat-title-input',accordion:'.accordion-title-input',database:'.database-title-input',timetable:'.timetable-title-input',gantt:'.gantt-title-input',treeview:'.treeview-title-input'};
 const fieldSelectors={'ai-chat':'.ai-chat-answer-input',accordion:'.accordion-content-input',database:'.database-value-input',timetable:'.timetable-entry-note',gantt:'.gantt-task-title',treeview:'.treeview-note-input'};
 async function trace(kind,mode,input,action='none',readOnly=false){
   const m=modules[kind][mode],row=document.createElement('section');row.className='editor-block-row';row.dataset.blockType=kind;
   if(readOnly)row.setAttribute('aria-readonly','true');let dirty=0;
   document.body.append(row);row.append(m.create(row,structuredClone(input),{onDirty:()=>dirty++}));
   try{
     await frames();
     if(action==='title'){
       const field=row.querySelector(titleSelectors[kind]);check(field,'missing title');field.value='수정 <img src=x onerror="globalThis.auditPwned=1">';field.dispatchEvent(new Event('input',{bubbles:true}));
     }
     if(action==='field'){
       if(kind==='treeview')row.querySelectorAll('[data-action="treeview-select-node"]')[input.nodes.length-1].click();
       let fields=row.querySelectorAll(fieldSelectors[kind]);
       // The accordion memo control is a textarea; keep selector discovery explicit.
       if(kind==='accordion'&&!fields.length)fields=row.querySelectorAll('textarea');
       const field=fields[fields.length-1];check(field,'missing editable memo/cell');
       field.value='후미 수정 <script>globalThis.auditPwned=1</script> & 😀';field.dispatchEvent(new Event('input',{bubbles:true}));
     }
     await frames();check(globalThis.auditPwned===undefined,'untrusted text executed');
     return {data:m.extract(row),dirty,markup:row.innerHTML,values:[...row.querySelectorAll('input,textarea,select')].map(f=>({value:f.value,checked:f.checked,disabled:f.disabled}))};
   }finally{row.remove();await frames();}
 }
 for(const kind of kinds){
   await test(`${kind}: initial DOM, ARIA, extracted editable metadata`,async()=>{
     equal(await trace(kind,'baseline',fixtures[kind].normal),await trace(kind,'current',fixtures[kind].normal));
   });
   await test(`${kind}: title edit, dirty callback, extraction, literal HTML`,async()=>{
     const a=await trace(kind,'baseline',fixtures[kind].normal,'title'),b=await trace(kind,'current',fixtures[kind].normal,'title');equal(a,b);check(b.dirty>0);check(b.data.title.startsWith('수정'));
   });
   await test(`${kind}: tail edit preserves other metadata beyond summary prefix`,async()=>{
     const input=fixtures[kind].tail;
     const a=await trace(kind,'baseline',input,'field'),b=await trace(kind,'current',input,'field');equal(a,b);check(b.dirty>0);check(JSON.stringify(b.data).includes('후미 수정'));
   });
   await test(`${kind}: stored untrusted text remains non-executable`,async()=>{
     const input=structuredClone(fixtures[kind].normal);input.title='<img src=x onerror="globalThis.auditPwned=1">';
     equal(await trace(kind,'baseline',input),await trace(kind,'current',input));check(globalThis.auditPwned===undefined);
   });
 }
 for(const kind of ['accordion','treeview','timetable','gantt'])await test(`${kind}: read-only event guards retain original behavior`,async()=>{
   const a=await trace(kind,'baseline',fixtures[kind].normal,'field',true),b=await trace(kind,'current',fixtures[kind].normal,'field',true);equal(a,b);check(b.dirty===0);
 });
 for(const kind of ['accordion','treeview','timetable','gantt'])await test(`${kind}: missing IDs preserve UUID/fallback selection; saved IDs survive`,()=>{
   const input=structuredClone(fixtures[kind].normal), key={accordion:'items',treeview:'nodes',timetable:'entries',gantt:'tasks'}[kind];input[key][1].id='';
   const data=modules[kind].current.normalize(input),ids=data[key].map(x=>x.id);
   check(ids[0]===input[key][0].id);check(ids[2]===input[key][2].id);check(new Set(ids).size===ids.length);if(typeof crypto.randomUUID==='function')check(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(ids[1]),'not Web Crypto UUID v4');else check(typeof ids[1]==='string'&&ids[1].length>10,'missing existing browser fallback');
 });
 const servedModules=Object.fromEntries(Object.entries(urls).map(([k,v])=>[k,Object.keys(v)]));for(const v of Object.values(urls))for(const url of Object.values(v))URL.revokeObjectURL(url);
 return {scope:'Real Chromium DOM and native ESM Blob imports (only import URLs rewritten). about:blank is not a secure context; existing ID fallback executes. Runtime config uses existing 50000 offline default. Not deployed CSP/static HTTP/API/auth/database E2E.',servedModules,userAgent:navigator.userAgent,secureContext:isSecureContext,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results};
}'''
errors=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=args.browser,headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    try:
        page=browser.new_page()
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content('<!doctype html><html><meta charset="utf-8"><body></body></html>')
        result=page.evaluate(js,payload)
        result.update(browserVersion=browser.version,pageErrors=errors)
    finally:
        browser.close()
encoded=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
if args.output:args.output.write_text(encoded)
print(encoded,end='')
raise SystemExit(1 if result['failed'] or errors else 0)
