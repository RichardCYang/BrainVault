#!/usr/bin/env python3
"""Native-ESM Chromium regression against the exact uploaded source fixture.
Requires Python Playwright and Chromium. No external network/API/database; requests
are replaced by native ESM Blob imports and in-memory SCRIPT URL fixtures.
Mermaid SCRIPT load/error events are real browser events, but the successful
Mermaid API is a minimal test fixture, not the unavailable vendor bundle. No production authentication is mocked
as a security pass. Run: python scripts/verify-cpu-memory-browser.py --output result.json
"""
import argparse
import base64
import json
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path)
parser.add_argument('--browser', default=shutil.which('chromium') or shutil.which('google-chrome'))
args = parser.parse_args()
if not args.browser:
    parser.error('Chromium was not found; specify --browser')
root = Path(__file__).resolve().parents[1]
baseline = json.loads((root / 'tests/fixtures/cpu-memory-regression-baseline.json').read_text())
frame_data = 'data:text/html;base64,' + base64.b64encode(
    b'<html><body>diagram fixture<script>parent.postMessage("UNSAFE_FRAME_EXECUTED","*")</script></body></html>'
).decode()
api_fixture = r'''
globalThis.__mermaidConfigs = [];
globalThis.__mermaidRenders = [];
globalThis.mermaid = {
 initialize(config) { globalThis.__mermaidConfigs.push(config); },
 async render(id, source) {
  globalThis.__mermaidRenders.push({id, source});
  if (globalThis.__holdMermaid) await new Promise(resolve => globalThis.__releaseMermaid = resolve);
  const src = globalThis.__invalidMermaidSource ? 'https://untrusted.invalid/' : FRAME_DATA;
  return {svg: '<img src=x onerror="parent.__xss=1"><iframe sandbox="allow-scripts allow-same-origin allow-popups" style="height:9999px" src="'+src+'"></iframe>'};
 }
};
'''.replace('FRAME_DATA', json.dumps(frame_data))

sources = {mode: {} for mode in ['baseline', 'current']}
for mode in sources:
    for name in ['treeview-block.js', 'i18n.js', 'mermaid-block.js', 'editor-content-limits.js']:
        record = baseline['files'].get('public/' + name) if mode == 'baseline' else None
        sources[mode][name] = record['source'] if record else (root / 'public' / name).read_text()

bootstrap_js = r'''payload => {
 const urls={baseline:{},current:{}},allUrls=[];
 function moduleUrl(mode,name,tag='') {
  const key=name+'?'+tag;if(urls[mode][key])return urls[mode][key];
  const source=payload.sources[mode][name];if(source===undefined)throw Error('Missing module '+name);
  const rewritten=source.replace(/^(import[^\n]*from ["'])\.\/([^"']+)(["'];)/gm,(_,a,dep,b)=>a+moduleUrl(mode,dep)+b);
  const url=URL.createObjectURL(new Blob([rewritten],{type:'text/javascript'}));allUrls.push(url);
  return urls[mode][key]=url;
 }
 globalThis.__cpuMemoryImport=(mode,name,tag='')=>import(moduleUrl(mode,name,tag));
 globalThis.__mermaidBundleMode='error';globalThis.__mermaidBundleRequests=0;globalThis.__pinnedMermaidSources=[];
 const nativeAppend=document.head.append.bind(document.head);
 document.head.append=(...nodes)=>{
  for(const node of nodes)if(node.tagName==='SCRIPT'&&node.dataset.brainvaultMermaid){
   const pinned=node.getAttribute('src');
   if(pinned!=='/vendor/mermaid/11.17.2/mermaid.min.js')throw Error('Unpinned production Mermaid URL');
   __pinnedMermaidSources.push(pinned);__mermaidBundleRequests++;
   const body=__mermaidBundleMode==='success'?payload.apiFixture:'/* intentionally invalid fixture */';
   const url=URL.createObjectURL(new Blob([body],{type:'text/javascript'}));allUrls.push(url);
   // A revoked URL delivers an actual browser script error, not a manually
   // dispatched event. No external network or browser policy changes are used.
   if(__mermaidBundleMode==='error')URL.revokeObjectURL(url);
   node.src=url;
  }
  return nativeAppend(...nodes);
 };
 globalThis.__releaseAuditUrls=()=>allUrls.forEach(url=>URL.revokeObjectURL(url));
}'''

tree_js = r'''async () => {
 const results=[];
 const check=(x,m='assertion failed')=>{if(!x)throw Error(m);};
 const equal=(a,b)=>check(JSON.stringify(a)===JSON.stringify(b),'original/current outputs differ');
 const test=async(name,run)=>{try{await run();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:String(e),stack:e.stack});}};
 const modules={baseline:await __cpuMemoryImport('baseline','treeview-block.js'),current:await __cpuMemoryImport('current','treeview-block.js')};
 const languages={baseline:await __cpuMemoryImport('baseline','i18n.js'),current:await __cpuMemoryImport('current','i18n.js')};
 const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const fixture=()=>({title:'Outline <&> 한글',nodes:[
  {id:'a',parentId:null,title:'Root A',note:'memo A',expanded:true},
  {id:'a1',parentId:'a',title:'Child A1',note:'memo A1',expanded:true},
  {id:'a2',parentId:'a',title:'',note:'memo A2',expanded:true},
  {id:'b',parentId:null,title:'Root B',note:'memo B',expanded:true},
  {id:'b1',parentId:'b',title:'Child B1',note:'memo B1',expanded:true}
 ]});
 async function trace(mode,run=()=>{},input=fixture(),readOnly=false) {
  const m=modules[mode],row=document.createElement('section');row.className='editor-block-row';
  if(readOnly)row.setAttribute('aria-readonly','true');
  let dirty=0;document.body.append(row);row.append(m.createTreeViewEditor(row,structuredClone(input),{onDirty:()=>dirty++}));
  const click=(action,id)=>{const b=row.querySelector(`[data-action="${action}"]${id?`[data-treeview-node-id="${CSS.escape(id)}"]`:''}`);check(b,action);b.click();};
  const edit=(selector,value)=>{const f=row.querySelector(selector);check(f,selector);f.value=value;f.dispatchEvent(new Event('input',{bubbles:true}));};
  const key=async(id,key)=>{const b=row.querySelector(`[data-action="treeview-select-node"][data-treeview-node-id="${CSS.escape(id)}"]`);b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));await frames();};
  try {
   await run({row,click,edit,key});await frames();
   const data=m.extractTreeViewData(row),editor=row.querySelector('.treeview-block-editor');
   const known=new Set(input.nodes.map(n=>n.id)),added=data.nodes.filter(n=>!known.has(n.id)&&/^tree-node-(?:[0-9a-f]{8}-[0-9a-f]{4}-|[0-9]{10,}-)/.test(n.id));
   const snapshot={data,dirty,selected:editor.treeViewSelectedNodeId,markup:row.innerHTML,
    values:[...row.querySelectorAll('input,textarea')].map(f=>({value:f.value,hidden:f.hidden,disabled:f.disabled})),
    focused:row.contains(document.activeElement)?document.activeElement.dataset.treeviewNodeId??document.activeElement.className:null};
   let encoded=JSON.stringify(snapshot);
   // New IDs use the original Web Crypto/fallback path and are nondeterministic.
   // Compare their references after a bijective test-only renaming; deterministic
   // duplicate-ID repairs are not renamed.
   added.forEach((n,i)=>{check(n.id.length<=64&&n.id.startsWith('tree-node-'),'invalid generated ID');encoded=encoded.split(n.id).join(`NEW_NODE_${i}`);});
   check(!row.querySelector('script,img,iframe'),'tree text became executable HTML');
   return JSON.parse(encoded);
  } finally {row.remove();await frames();}
 }
 async function compare(name,run,input,readOnly=false,verify=()=>{}) {
  await test(name,async()=>{const a=await trace('baseline',run,input,readOnly),b=await trace('current',run,input,readOnly);equal(a,b);verify(b);});
 }
 await compare('native ESM: initial DOM, metadata, ARIA and selection');
 await compare('title and multiline memo edits retain exact data and escaped DOM',h=>{
  h.click('treeview-select-node','a2');h.edit('.treeview-title-input','수정 제목');
  h.edit('.treeview-note-title-input','<img src=x onerror="globalThis.__xss=1">');
  h.edit('.treeview-note-input','메모\n<script>globalThis.__xss=1</script>');
 },undefined,false,s=>check(s.dirty===3));
 await compare('live indent/outdent and sibling reorder do not reuse stale parent indexes',h=>{
  h.click('treeview-indent','b');h.click('treeview-outdent','b');h.click('treeview-move-up','b');h.click('treeview-move-down','b');
 });
 await compare('parent deletion preserves child notes and reparents children',h=>h.click('treeview-delete-node','a'),undefined,false,s=>{
  check(!s.data.nodes.some(n=>n.id==='a'));check(s.data.nodes.find(n=>n.id==='a1').parentId===null);
 });
 await compare('add child, edit new memo and select another node',h=>{h.click('treeview-add-child','a');h.edit('.treeview-note-input','new child');h.click('treeview-select-node','b');});
 await compare('add root preserves generated ID references and keyboard focus',h=>{h.click('treeview-add-root');h.edit('.treeview-note-title-input','New root');});
 await compare('delete leaf then add a new sibling',h=>{h.click('treeview-delete-node','a2');h.click('treeview-add-child','a');});
 await compare('collapse and keyboard navigation preserve selection and focus',async h=>{
  h.click('treeview-toggle-node','a');h.click('treeview-toggle-node','a');
  await h.key('a','ArrowDown');await h.key('a1','End');await h.key('b1','Home');await h.key('a','Enter');
 });
 await compare('read-only input and structural guards remain unchanged',h=>{
  h.edit('.treeview-title-input','blocked');h.edit('.treeview-note-input','blocked');h.click('treeview-add-root');h.click('treeview-delete-node','a');
 },undefined,true,s=>check(s.dirty===0));
 await compare('read-only navigation and folding emit no dirty notifications',async h=>{
  h.click('treeview-select-node','a2');h.click('treeview-toggle-node','a');await h.key('b','ArrowRight');
 },undefined,true,s=>check(s.dirty===0));
 await compare('empty outline accepts its first root',h=>h.click('treeview-add-root'),{title:'',nodes:[]});
 const deep={title:'300-level outline',nodes:Array.from({length:300},(_,i)=>({id:`n${i}`,parentId:i?`n${i-1}`:null,title:i%5?'Node '+i:'',note:'한글😀'.repeat(50),expanded:true}))};
 await compare('300-level selection and title edit preserve full path and all memos',h=>{
  h.click('treeview-select-node','n299');h.edit('.treeview-note-title-input','마지막 수정');h.edit('.treeview-note-input','edited leaf memo');
  check(h.row.querySelector('[data-action="treeview-add-root"]').disabled,'node limit changed');
 },deep);
 await compare('cyclic, orphan, duplicate and prototype-like IDs retain repairs',()=>{},{title:'',nodes:[
  {id:'__proto__',parentId:'constructor',title:'<svg/onload=alert(1)>',note:'<script>x</script>'},
  {id:'constructor',parentId:'__proto__',title:'B',note:'B'},
  {id:'constructor',parentId:'missing',title:'C',note:'C'}
 ]});
 for(const lang of ['en','ko','ja','fr','de','es','pt']){
  for(const m of Object.values(languages))m.setLanguage(lang,{persist:false});
  await compare(`native ESM ${lang}: empty-title fallback and ancestor path`,h=>h.click('treeview-select-node','a2'));
 }
 for(const m of Object.values(languages))m.setLanguage('en',{persist:false});
 check(globalThis.__xss===undefined,'tree XSS executed');
 return results;
}'''

failure_js = r'''async ({mode,event,attempts}) => {
 delete globalThis.mermaid;
 const m=await __cpuMemoryImport(mode,'mermaid-block.js','failure='+event);
 const target=document.createElement('div');document.body.append(target);
 const results=[];
 try {
  for(let i=0;i<attempts;i++)results.push(await m.renderMermaidPreview(target,'flowchart TD; A-->B',{errorText:'expected error'}));
  return {mode,event,attempts,retainedScripts:document.querySelectorAll('script[data-brainvault-mermaid]').length,
   allFailed:results.every(r=>r===false),invalidVisible:target.classList.contains('is-invalid'),errorText:target.textContent};
 } finally {target.remove();document.querySelectorAll('script[data-brainvault-mermaid]').forEach(s=>s.remove());}
}'''

success_js = r'''async mode => {
 const results=[],check=(x,m='assertion failed')=>{if(!x)throw Error(m);};
 const test=async(name,run)=>{try{await run();results.push({name:`${mode}: ${name}`,passed:true});}catch(e){results.push({name:`${mode}: ${name}`,passed:false,error:String(e),stack:e.stack});}};
 delete globalThis.mermaid;delete globalThis.__invalidMermaidSource;delete globalThis.__holdMermaid;
 globalThis.__unsafeFrameMessage=false;
 const listener=e=>{if(e.data==='UNSAFE_FRAME_EXECUTED')globalThis.__unsafeFrameMessage=true;};addEventListener('message',listener);
 const m=await __cpuMemoryImport(mode,'mermaid-block.js','success');
 const target=document.createElement('div');document.body.append(target);
 try {
  await test('stale queued revisions are skipped; latest render loads one pinned script',async()=>{
   const first=m.renderMermaidPreview(target,'flowchart TD; A-->Old');
   const last=m.renderMermaidPreview(target,'flowchart TD; A-->Latest');
   check(await first===false);check(await last===true);
   check(document.querySelectorAll('script[data-brainvault-mermaid]').length===1);
   check(__mermaidRenders.length===1&&__mermaidRenders[0].source.endsWith('Latest'));
  });
  await test('sandbox, escaping, referrer policy and size boundaries remain intact',async()=>{
   const f=target.querySelector('iframe');check(f?.getAttribute('sandbox')==='');check(f?.referrerPolicy==='no-referrer');
   check(f.style.height==='2400px');check(!target.querySelector('img'));check(target.children.length===1);
   check(__mermaidConfigs.every(c=>c.securityLevel==='sandbox'&&c.maxTextSize===20000));
   await new Promise(r=>setTimeout(r,40));check(!__unsafeFrameMessage,'sandbox script executed');
  });
  await test('same-source rendered cache avoids another render without replacing the frame',async()=>{
   const f=target.querySelector('iframe'),count=__mermaidRenders.length;
   check(await m.renderMermaidPreview(target,'flowchart TD; A-->Latest')===true);
   check(__mermaidRenders.length===count);check(target.querySelector('iframe')===f);
  });
  await test('empty, oversized and detached previews do not invoke the renderer',async()=>{
   const count=__mermaidRenders.length;
   check(await m.renderMermaidPreview(target,'')===true);
   check(await m.renderMermaidPreview(target,'x'.repeat(20001))===false);
   const detached=document.createElement('div');check(await m.renderMermaidPreview(detached,'graph TD; A-->B')===false);
   check(__mermaidRenders.length===count);
  });
  await test('unexpected external iframe source is rejected rather than inserted',async()=>{
   globalThis.__invalidMermaidSource=true;
   check(await m.renderMermaidPreview(target,'graph TD; unsafe-->source')===false);
   check(!target.querySelector('iframe'));check(target.classList.contains('is-invalid'));
   delete globalThis.__invalidMermaidSource;
  });
  await test('revision changes during in-flight rendering cannot overwrite the latest preview',async()=>{
   globalThis.__holdMermaid=true;
   const first=m.renderMermaidPreview(target,'graph TD; old-->pending');
   for(let i=0;i<100&&!globalThis.__releaseMermaid;i++)await new Promise(r=>setTimeout(r,1));
   check(typeof globalThis.__releaseMermaid==='function');
   const last=m.renderMermaidPreview(target,'graph TD; newest-->final');
   delete globalThis.__holdMermaid;globalThis.__releaseMermaid();delete globalThis.__releaseMermaid;
   check(await first===false);check(await last===true);
   check(target.dataset.mermaidRenderedKey.endsWith('graph TD; newest-->final'));
  });
 } finally {target.remove();document.querySelectorAll('script[data-brainvault-mermaid]').forEach(s=>s.remove());removeEventListener('message',listener);}
 return results;
}'''

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    try:
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
        page.add_style_tag(content=(root / 'public/styles.css').read_text())
        page.evaluate(bootstrap_js, {'sources': sources, 'apiFixture': api_fixture})
        results = page.evaluate(tree_js)
        failures = []
        for event in ['error', 'load']:
            page.evaluate('(mode) => globalThis.__mermaidBundleMode = mode', 'error' if event == 'error' else 'invalid')
            for mode in ['baseline', 'current']:
                item = page.evaluate(failure_js, {'mode': mode, 'event': event, 'attempts': 40})
                failures.append(item)
                expected = 40 if mode == 'baseline' else 0
                passed = item['retainedScripts'] == expected and item['allFailed'] and item['invalidVisible'] and item['errorText'] == 'expected error'
                results.append({'name': f'{mode}: real SCRIPT {event} retry retention', 'passed': passed, 'measurement': item})
        page.evaluate('globalThis.__mermaidBundleMode = "success"')
        for mode in ['baseline', 'current']:
            results.extend(page.evaluate(success_js, mode))
        result = {
            'scope': __doc__, 'browserVersion': browser.version, 'secureContext': page.evaluate('isSecureContext'),
            'passed': sum(bool(r['passed']) for r in results), 'failed': sum(not r['passed'] for r in results),
            'pageErrors': errors, 'realScriptLifecycle': failures, 'bundleRequests': page.evaluate('__mermaidBundleRequests'), 'results': results
        }
        page.evaluate('__releaseAuditUrls()')
    finally:
        browser.close()
encoded = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(encoded)
print(encoded, end='')
raise SystemExit(1 if result['failed'] or errors else 0)
