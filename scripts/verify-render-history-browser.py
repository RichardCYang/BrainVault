#!/usr/bin/env python3
"""Run native-ESM Chromium component regressions against byte-exact uploaded sources.
Requires Python Playwright and Chromium, not npm packages or a database.
Run: python scripts/verify-render-history-browser.py --output result.json
This does not claim logged-in API/MariaDB/WebAuthn end-to-end coverage.
"""
import argparse
import json
from pathlib import Path
import re
import shutil
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path)
parser.add_argument('--browser', default=shutil.which('chromium') or shutil.which('google-chrome'))
args = parser.parse_args()
if not args.browser:
    parser.error('Chromium was not found; specify --browser')
root = Path(__file__).resolve().parents[1]
fixture = json.loads((root / 'tests/fixtures/render-history-resource-baseline.json').read_text())
sources = {mode: {} for mode in ['baseline', 'current']}
for mode in sources:
    def collect(name):
        if name in sources[mode]:
            return
        record = fixture['files'].get('public/' + name) if mode == 'baseline' else None
        source = record['source'] if record else (root / 'public' / name).read_text()
        sources[mode][name] = source
        for dep in re.findall(r'^import[^\n]*from ["\']\./([^"\']+)["\'];', source, re.M):
            collect(dep)
    collect('gantt-block.js')
    collect('editor-history.js')

script = r'''async ({sources, full}) => {
 const results=[], urls={baseline:{},current:{}}, originalDate=Date;
 globalThis.__auditNow=Date.parse('2026-09-16T12:00:00Z');
 globalThis.Date=class extends originalDate {
   constructor(...args){super(...(args.length?args:[globalThis.__auditNow]));}
   static now(){return globalThis.__auditNow;}
 };
 window.confirm=()=>true;
 const check=(ok,message='assertion failed')=>{if(!ok)throw Error(message);};
 const equal=(a,b,message='original/current outputs differ')=>check(JSON.stringify(a)===JSON.stringify(b),message);
 const test=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:String(e),stack:e.stack});}};
 function url(mode,name,instrument=false) {
   const key=name+(instrument?'#instrumented':'');
   if(urls[mode][key])return urls[mode][key];
   let source=sources[mode][name]; check(source!==undefined,'missing dependency '+name);
   if(instrument){
     source='const auditMetrics={weekendCalls:0,todayCalls:0};\n'+source
       .replace('function isWeekend(day) {','function isWeekend(day) { auditMetrics.weekendCalls++;')
       .replace('function getTodayDay() {','function getTodayDay() { auditMetrics.todayCalls++;');
     source+='\nexport {auditMetrics};';
   }
   source=source.replace(/^(import[^\n]*from ["'])\.\/([^"']+)(["'];)/gm,(_,a,dep,b)=>a+url(mode,dep)+b);
   return urls[mode][key]=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
 }
 const modules={}, languages={};
 for(const mode of ['baseline','current']){
   modules[mode]=await import(url(mode,'gantt-block.js'));
   languages[mode]=await import(url(mode,'i18n.js'));
 }
 const frames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 const input=(n=3,scale='month',showWeekends=true,viewStart='2026-09-07')=>({
   title:'일정 <&> 😀',scale,showWeekends,viewStart,
   tasks:Array.from({length:n},(_,i)=>({id:'task-'+i,title:'작업 '+i,start:'2026-09-14',end:'2026-09-18',progress:i%101,status:['not_started','in_progress','review','done','blocked'][i%5],assignee:'담당 '+i}))
 });
 let operationMetrics=null;
 async function trace(mode,data,run=()=>{},readOnly=false) {
   const m=modules[mode],row=document.createElement('section'),host=document.createElement('div');
   row.className='editor-block-row';host.className='block-editor-host';row.append(host);
   if(readOnly)row.setAttribute('aria-readonly','true');
   let dirty=0;document.body.append(row);
   host.append(m.createGanttEditor(row,structuredClone(data),{onDirty:()=>dirty++}));
   const edit=(selector,value,type='input')=>{const f=row.querySelector(selector);check(f,'missing '+selector);if(f.type==='checkbox')f.checked=value;else f.value=value;f.dispatchEvent(new Event(type,{bubbles:true}));};
   const click=action=>{const f=row.querySelector(`[data-action="${action}"]`);check(f,'missing '+action);f.click();};
   const key=(key,shiftKey=false)=>{const b=row.querySelector('.gantt-bar');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true}));};
   try{
     await run({row,host,edit,click,key});await frames();
     check(!row.querySelector('script,img,iframe'),'untrusted text became markup');
     check(globalThis.__resourceXss===undefined,'untrusted text executed');
     const out=m.extractGanttData(row),known=new Set(data.tasks.map(t=>t.id));
     let encoded=JSON.stringify({data:out,dirty,markup:row.innerHTML,
       controls:[...row.querySelectorAll('input,select,textarea,output')].map(f=>({value:f.value,checked:f.checked,disabled:f.disabled})),
       focused:row.contains(document.activeElement)?{className:document.activeElement.className,field:document.activeElement.dataset.field,taskId:document.activeElement.dataset.taskId}:null});
     out.tasks.filter(t=>!known.has(t.id)).forEach((t,i)=>{check(t.id.startsWith('task-')&&t.id.length<=64,'invalid new ID');encoded=encoded.split(t.id).join('NEW_TASK_'+i);});
     return JSON.parse(encoded);
   }finally{row.remove();await frames();}
 }
 async function compare(name,data,run,readOnly=false,verify=()=>{}){
   await test(name,async()=>{const before=await trace('baseline',data,run,readOnly),after=await trace('current',data,run,readOnly);equal(before,after);verify(after);});
 }
 for(const scale of ['week','month','quarter']) for(const show of [true,false]){
   await compare(`DOM/ARIA/full metadata parity: ${scale}, weekends=${show}`,input(3,scale,show));
 }
 for(const n of [0,1,200]) await compare(`task count ${n}: no row duplication or data truncation`,input(n,'quarter'),undefined,false,s=>check(s.data.tasks.length===n));
 await compare('literal HTML remains text in title, assignee and task fields',input(),h=>{
   h.edit('.gantt-title-input','<img src=x onerror="globalThis.__resourceXss=1">');
   h.edit('.gantt-task-input[data-field="title"]','<script>globalThis.__resourceXss=1</script>');
   h.edit('.gantt-task-input[data-field="assignee"]','<& 한글 😀');
 });
 await compare('progress/status edits keep bar labels and serialization',input(),h=>{h.edit('.gantt-progress-input','65');h.edit('.gantt-status-select','done','change');});
 await compare('keyboard move and resize retain dirty count and date boundaries',input(),h=>{h.key('ArrowRight');h.key('ArrowLeft');h.key('ArrowRight',true);},false,s=>check(s.dirty===3));
 await compare('date edit recreates timeline decorations and restores input focus',input(),h=>h.edit('.gantt-date-input[data-field="start"]','2026-11-12','change'),false,s=>check(s.data.tasks[0].start==='2026-11-12'));
 await compare('next/previous ranges rebuild decorations rather than retaining stale offsets',input(),h=>{h.click('gantt-next');h.click('gantt-previous');h.click('gantt-next');});
 await compare('weekend toggle recalculates shades on each rebuild',input(),h=>{h.edit('.gantt-weekend-toggle input',false,'change');h.edit('.gantt-weekend-toggle input',true,'change');});
 await compare('scale transition updates day width, weekend columns and today marker',input(),h=>{h.edit('.gantt-scale-select','quarter','change');h.edit('.gantt-scale-select','week','change');});
 await compare('delete and add preserve unaffected tasks and generated references',input(),h=>{h.click('gantt-delete-task');h.click('gantt-add-task');});
 await compare('read-only blocks reject mutations but keep accessible DOM',input(),h=>{
   h.edit('.gantt-title-input','must not persist');h.edit('.gantt-progress-input','90');h.key('ArrowRight');h.click('gantt-next');h.click('gantt-add-task');
 },true,s=>check(s.dirty===0));
 await compare('read-only transition during pointer drag discards the preview',input(),h=>{
   const bar=h.row.querySelector('.gantt-bar');
   // Synthetic pointer events need a test-only capture implementation; this case
   // checks the production read-only guard, not the browser capture implementation.
   bar.setPointerCapture=()=>{};bar.hasPointerCapture=()=>false;
   bar.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,button:0,clientX:100,bubbles:true}));
   bar.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:156,bubbles:true}));
   h.row.setAttribute('aria-readonly','true');
   bar.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,clientX:156,bubbles:true}));
 },false,s=>check(s.dirty===0));
 await compare('pointer move/resize/cancel follow the original date and dirty semantics',input(),h=>{
   const bar=h.row.querySelector('.gantt-bar');bar.setPointerCapture=()=>{};bar.hasPointerCapture=()=>false;
   for(const [selector,end] of [[null,'pointerup'],['.gantt-resize-handle--end','pointerup'],['.gantt-resize-handle--start','pointercancel']]){
     (selector?bar.querySelector(selector):bar).dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,button:0,clientX:100,bubbles:true}));
     bar.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:156,bubbles:true}));
     bar.dispatchEvent(new PointerEvent(end,{pointerId:1,clientX:156,bubbles:true}));
   }
 },false,s=>check(s.dirty===2));
 await test('new renders reflect local midnight without a process-global decoration cache',async()=>{
   const clock=globalThis.__auditNow;
   for(const instant of ['2026-09-16T23:59:59Z','2026-09-17T00:00:01Z','2026-09-17T15:00:01Z']){
     globalThis.__auditNow=originalDate.parse(instant);
     equal(await trace('baseline',input()),await trace('current',input()));
   }
   globalThis.__auditNow=clock;
 });
 if(full){
   for(const language of ['en','ko','ja','fr','de','es','pt']){
     for(const m of Object.values(languages))m.setLanguage(language,{persist:false});
     await compare(`locale ${language}: date, weekday, count and accessible labels`,input());
   }
   for(const m of Object.values(languages))m.setLanguage('en',{persist:false});
   const counts={};
   await test('200-task quarter render computes weekend membership once per visible day',async()=>{
     for(const mode of ['baseline','current']){
       const m=await import(url(mode,'gantt-block.js',true)),row=document.createElement('section');document.body.append(row);
       try { row.append(m.createGanttEditor(row,input(200,'quarter'))); counts[mode]={...m.auditMetrics,shades:row.querySelectorAll('.gantt-weekend-shade').length,todayLines:row.querySelectorAll('.gantt-today-line').length}; }
       finally {row.remove();}
     }
     check(counts.baseline.weekendCalls===98*201,'original workload did not reproduce');
     check(counts.current.weekendCalls===98,'weekend calculations are still per-task');
     check(counts.current.todayCalls<counts.baseline.todayCalls,'today calculations not reduced');
     check(counts.current.shades===counts.baseline.shades&&counts.current.todayLines===counts.baseline.todayLines,'visible decorations were lost');
   });
   await test('native browser history retains private snapshots after 500 undo/redo cycles and caller mutations',async()=>{
     const states=[];
     for(const mode of ['baseline','current']){
       const m=await import(url(mode,'editor-history.js')),h=m.createEditorHistory();
       const value={markdown:'A'.repeat(100000),metadata:{items:['한글','😀']}};h.seed('p','b',value);
       const changed=structuredClone(value);changed.markdown='B'.repeat(100000);h.record({pageId:'p',key:'b',value:changed,now:1});
       value.metadata.items[0]='bad';changed.metadata.items[1]='bad';
       for(let i=0;i<500;i++){h.commit('p','undo');h.commit('p','redo');}
       const peek=h.peek('p','undo');check(peek.before.metadata.items[0]==='한글');check(peek.after.metadata.items[1]==='😀');
       peek.before.metadata.items[0]='bad';h.commit('p','undo');states.push({state:h.getState(),entry:h.peek('p','redo')});
     }
     equal(states[0],states[1]);
   });
   operationMetrics=counts;
 }
 for(const map of Object.values(urls))for(const objectUrl of Object.values(map))URL.revokeObjectURL(objectUrl);
 globalThis.Date=originalDate;
 globalThis.__auditGanttModules=modules;
 globalThis.__auditGanttInput=input;
 return {results,operationMetrics};
}'''

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox'])
    report = {'browser': browser.version, 'scope': 'Native browser components; no authenticated API/database server', 'runs': []}
    for zone in ['UTC', 'Asia/Seoul', 'America/New_York']:
        context = browser.new_context(timezone_id=zone, locale='en-US')
        page = context.new_page()
        page.set_content('<!doctype html><html><head></head><body></body></html>')
        result = page.evaluate(script, {'sources': sources, 'full': zone == 'UTC'})
        if zone == 'UTC':
            # Use the real stylesheet and Playwright mouse input, including real
            # pointer capture, in addition to the synthetic guard matrix above.
            page.set_viewport_size({'width': 1280, 'height': 900})
            page.add_style_tag(content=(root / 'public/styles.css').read_text())
            for action in ['move', 'resize-end', 'read-only-mid-drag']:
                traces = []
                try:
                    for mode in ['baseline', 'current']:
                        page.evaluate('''mode => {
                          document.body.replaceChildren();
                          const row=document.createElement('section'),host=document.createElement('div');
                          const handle=document.createElement('button'),body=document.createElement('div');
                          // Match app.js: the handle occupies the first grid column.
                          row.className='editor-block-row';row.dataset.blockType='GANTT';
                          handle.className='block-handle';body.className='block-row-body';
                          host.className='block-editor-host';body.append(host);row.append(handle,body);document.body.append(row);
                          globalThis.__pointerDirty=0;globalThis.__pointerRow=row;
                          row.addEventListener('pointerdown',e=>globalThis.__nativePointerId=e.pointerId,{capture:true});
                          host.append(__auditGanttModules[mode].createGanttEditor(row,__auditGanttInput(1),{onDirty:()=>__pointerDirty++}));
                        }''', mode)
                        selector = '.gantt-resize-handle--end' if action == 'resize-end' else '.gantt-bar'
                        page.locator(selector).hover()
                        page.locator('.editor-block-row').evaluate('async row => { await Promise.allSettled(row.getAnimations().map(a => a.finished)); }')
                        box = page.locator(selector).bounding_box()
                        if not box:
                            raise AssertionError('Task bar has no browser layout box')
                        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
                        page.mouse.move(x, y)
                        page.mouse.down()
                        captured = page.locator('.gantt-bar').evaluate('bar => bar.classList.contains("is-dragging") && bar.hasPointerCapture(__nativePointerId)')
                        if not captured:
                            raise AssertionError('Native mouse did not reach the bar or obtain real pointer capture')
                        page.mouse.move(x + (28 if action == 'resize-end' else 56), y, steps=4)
                        if action == 'read-only-mid-drag':
                            page.evaluate('__pointerRow.setAttribute("aria-readonly", "true")')
                        page.mouse.up()
                        traces.append(page.evaluate('''mode => ({data:__auditGanttModules[mode].extractGanttData(__pointerRow),dirty:__pointerDirty,markup:__pointerRow.innerHTML})''', mode))
                    if traces[0] != traces[1]:
                        raise AssertionError('Native pointer behavior differs from the original')
                    expected_dirty = 0 if action == 'read-only-mid-drag' else 1
                    if traces[1]['dirty'] != expected_dirty:
                        raise AssertionError('Native pointer action did not exercise its commit guard')
                    task = traces[1]['data']['tasks'][0]
                    if action == 'move' and task['start'] != '2026-09-16':
                        raise AssertionError('Two-day move was not committed')
                    if action == 'resize-end' and task['end'] != '2026-09-19':
                        raise AssertionError('One-day resize was not committed')
                    result['results'].append({'name': 'Real CSS/native pointer capture: ' + action, 'passed': True})
                except Exception as error:
                    page.mouse.up()
                    result['results'].append({'name': 'Real CSS/native pointer capture: ' + action, 'passed': False, 'error': str(error)})
        report['runs'].append({'timezone': zone, **result})
        context.close()
    browser.close()
report['passed'] = sum(item['passed'] for run in report['runs'] for item in run['results'])
report['failed'] = sum(not item['passed'] for run in report['runs'] for item in run['results'])
text = json.dumps(report, ensure_ascii=False, indent=2)
if args.output:
    args.output.write_text(text + '\n')
print(json.dumps({'browser': report['browser'], 'passed': report['passed'], 'failed': report['failed']}, indent=2))
for run in report['runs']:
    for item in run['results']:
        if not item['passed']:
            print(run['timezone'], item['name'], item.get('error'))
raise SystemExit(1 if report['failed'] else 0)
