#!/usr/bin/env python3
"""Real Chromium component regression; not a logged-in API/DB end-to-end test.
Requires Python playwright and a Chromium executable. Run from any directory:
  python scripts/verify-resource-followup-browser.py --output results.json
"""
import argparse, json, shutil, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

parser=argparse.ArgumentParser()
parser.add_argument('--output',default='resource-followup-browser.json')
parser.add_argument('--browser',default=shutil.which('chromium') or shutil.which('google-chrome'))
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
fixture=json.loads((root/'tests/fixtures/resource-followup-baseline.json').read_text())
payload={
 'baseline':fixture['files']['clientTree']['source'],
 'current':(root/'public/treeview-block.js').read_text(),
 'i18n':(root/'public/i18n.js').read_text()
}
js=r'''async data => {
  const results = [], benchmarks = [];
  const check = (ok, message='assertion failed') => {if(!ok)throw Error(message);};
  const equal = (a,b,message='outputs differ') => check(JSON.stringify(a)===JSON.stringify(b),message);
  const test = async (name,run) => {const start=performance.now();try{await run();results.push({name,passed:true,ms:performance.now()-start});}catch(error){results.push({name,passed:false,error:String(error),stack:error.stack});}};
  const i18n = new Function(data.i18n.replace(/^export /gm,'')+'\nreturn {t,formatNumber,setLanguage};')();
  i18n.setLanguage('en',{persist:false});
  function make(mode,{instrument=false}={}) {
    let source=data[mode].replace(/^import[^\n]*;\r?$/gm,'').replace(/^export /gm,'');
    const metrics={childComparisons:0,indexVisits:0};
    if(instrument){
      source=source.replace('data.nodes.filter((node) => node.parentId === parentId)','data.nodes.filter((node) => (metrics.childComparisons++,node.parentId === parentId))');
      source=source.replace('for (const node of data.nodes) {','for (const node of data.nodes) { metrics.indexVisits++;');
    }
    let id=0;
    return new Function('t','formatNumber','globalThis','metrics',source+'\nreturn {create:createTreeViewEditor,normalize:normalizeTreeViewData,summarize:summarizeTreeViewData,metrics};')(
      i18n.t,i18n.formatNumber,{crypto:{randomUUID:()=>`test-id-${++id}`}},metrics);
  }
  const fixture = () => ({title:'Outline <script> & 한글',nodes:[
    {id:'a',parentId:null,title:'Root A',note:'root memo',expanded:true},
    {id:'a1',parentId:'a',title:'A 1',note:'memo\n1',expanded:true},
    {id:'a2',parentId:'a',title:'A 2',note:'',expanded:false},
    {id:'b',parentId:null,title:'Root B',note:'memo B',expanded:true},
    {id:'b1',parentId:'b',title:'B 1',note:'memo B1',expanded:false},
    {id:'b11',parentId:'b1',title:'B 1 child',note:'memo B11',expanded:true}
  ]});
  const frames = () => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  async function trace(mode,input,run=()=>{},readOnly=false) {
    const module=make(mode),row=document.createElement('section');let dirty=0;
    if(readOnly)row.setAttribute('aria-readonly','true');
    document.body.append(row);row.append(module.create(row,structuredClone(input),{onDirty:()=>dirty++}));
    const editor=()=>row.querySelector('.treeview-block-editor');
    const click=(action,id)=>{
      const selector=`[data-action="${action}"]${id?`[data-treeview-node-id="${CSS.escape(id)}"]`:''}`;
      const button=row.querySelector(selector);check(!!button,`missing ${selector}`);button.click();
    };
    const inputValue=(selector,value)=>{const field=row.querySelector(selector);check(!!field,selector);field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));};
    const key=async(id,key)=>{const label=row.querySelector(`[data-action="treeview-select-node"][data-treeview-node-id="${id}"]`);label.focus();label.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));await frames();};
    try {
      await run({row,editor,click,inputValue,key});await frames();
      return {data:structuredClone(editor().treeViewData),selected:editor().treeViewSelectedNodeId,dirty,
        markup:row.innerHTML,inputs:[...row.querySelectorAll('input,textarea')].map(x=>({value:x.value,hidden:x.hidden,disabled:x.disabled})),
        focused:row.contains(document.activeElement)?document.activeElement.dataset.treeviewNodeId??document.activeElement.className:null};
    } finally {row.remove();await frames();}
  }
  async function compare(name,run,options={}) {
    await test(name,async()=>{
      const input=options.input??fixture();
      const a=await trace('baseline',input,run,options.readOnly),b=await trace('current',input,run,options.readOnly);
      equal(a,b);options.assert?.(b);
    });
  }
  await compare('DOM/ARIA/selection and memo values are identical on initial render');
  await compare('edit outline title, node title, and multiline memo',async h=>{
    h.inputValue('.treeview-title-input','수정 제목');h.click('treeview-select-node','a1');
    h.inputValue('.treeview-note-title-input','new <img src=x onerror=alert(1)>');
    h.inputValue('.treeview-note-input','기록\n<script>window.pwned=1</script>');
    check(!h.row.querySelector('script,img,iframe'),'untrusted text became markup');
  },{assert:b=>{check(b.data.title==='수정 제목');check(b.dirty===3);}});
  await compare('collapse and expand without reordering child content',h=>{h.click('treeview-toggle-node','a');h.click('treeview-toggle-node','a');});
  await compare('move siblings up and down',h=>{h.click('treeview-move-up','b');h.click('treeview-move-down','b');h.click('treeview-move-down','a1');});
  await compare('indent and outdent after structural replacement uses current parent links',h=>{h.click('treeview-indent','b');h.click('treeview-outdent','b');h.click('treeview-indent','a2');h.click('treeview-outdent','a2');});
  await compare('add child, edit memo and select existing root',h=>{h.click('treeview-add-child','a');h.inputValue('.treeview-note-input','new child memo');h.click('treeview-select-node','b');});
  await compare('add new root and preserve keyboard focus',h=>{h.click('treeview-add-root');h.inputValue('.treeview-note-title-input','New root');});
  await compare('delete parent preserves children by reparenting',h=>{h.click('treeview-delete-node','a');},{assert:b=>{check(!b.data.nodes.some(n=>n.id==='a'));check(b.data.nodes.find(n=>n.id==='a1').parentId===null);}});
  await compare('delete leaf then add sibling',h=>{h.click('treeview-delete-node','a2');h.click('treeview-add-child','a');});
  await compare('arrow/Home/End/Enter keyboard navigation and expansion',async h=>{
    await h.key('a','ArrowDown');await h.key('a1','Enter');await h.key('a1','End');
    await h.key('b1','ArrowRight');await h.key('b1','ArrowRight');await h.key('b11','ArrowLeft');
    await h.key('b1','ArrowLeft');await h.key('b1','Home');
  });
  await compare('readonly mode allows selection and folding but no dirty notification',async h=>{
    h.click('treeview-select-node','a1');h.click('treeview-toggle-node','a');await h.key('b1','ArrowRight');
  },{readOnly:true,assert:b=>check(b.dirty===0)});
  await compare('readonly guard rejects title, memo and structural mutations',h=>{
    h.inputValue('.treeview-title-input','blocked');h.inputValue('.treeview-note-input','blocked');
    h.click('treeview-add-root');h.click('treeview-delete-node','a');h.click('treeview-indent','b');
  },{readOnly:true,assert:b=>{equal(b.data,make('current').normalize(fixture()));check(b.dirty===0);}});
  await compare('empty-tree display and first root insertion',(h=>h.click('treeview-add-root')),{input:{title:'',nodes:[]}});
  await compare('cycle, orphan, duplicate and prototype-like IDs normalize identically',()=>{},{input:{title:'',nodes:[
    {id:'__proto__',parentId:'constructor',title:'<svg/onload=alert(1)>',note:'<script>x</script>'},
    {id:'constructor',parentId:'__proto__',title:'B',note:'B'},
    {id:'constructor',parentId:'missing',title:'C',note:'C'}
  ]}});
  for(const language of ['en','ko','ja','fr','de','es','pt']){
    i18n.setLanguage(language,{persist:false});await compare(`locale ${language}: labels, fallback title, paths and counts`,()=>{},{input:{title:'',nodes:[{id:'n',parentId:null,title:'',note:'한글😀'}]}});
  }
  i18n.setLanguage('en',{persist:false});
  const large={title:'300 nodes',nodes:Array.from({length:300},(_,i)=>({id:`n${i}`,parentId:null,title:`Node ${i}`,note:'memo',expanded:true}))};
  await compare('300-node limit, ordering controls and all ARIA positions',h=>{
    check(h.row.querySelector('[data-action="treeview-add-root"]').disabled,'root limit');
    check(h.row.querySelectorAll('[role="treeitem"]').length===300,'all nodes visible');
    check(h.row.querySelector('[data-action="treeview-move-up"][data-treeview-node-id="n0"]').disabled,'first boundary');
    check(h.row.querySelector('[data-action="treeview-move-down"][data-treeview-node-id="n299"]').disabled,'last boundary');
  },{input:large});
  await test('real DOM: full-list parent comparisons 180300 -> 0; index visits 300',()=>{
    const output=[];
    for(const mode of ['baseline','current']){const module=make(mode,{instrument:true}),row=document.createElement('section');document.body.append(row);row.append(module.create(row,large));output.push({html:row.innerHTML,metrics:module.metrics});row.remove();}
    equal(output[0].html,output[1].html);check(output[0].metrics.childComparisons===180300);check(output[1].metrics.childComparisons===0);check(output[1].metrics.indexVisits===300);
  });
  await test('large memos preserve full editable metadata while summary remains exact',()=>{
    const input={...large,nodes:large.nodes.map(n=>({...n,note:'한글abcd'.repeat(1334).slice(0,8000)}))};
    const a=make('baseline'),b=make('current');equal(a.summarize(input),b.summarize(input));equal(a.normalize(input),b.normalize(input));
    check(b.normalize(input).nodes.reduce((s,n)=>s+n.note.length,0)===2400000);
  });
  for(const mode of ['baseline','current']){
    const module=make(mode),times=[];
    for(let i=0;i<9;i++){const row=document.createElement('section');document.body.append(row);const start=performance.now();row.append(module.create(row,large));row.getBoundingClientRect();const elapsed=performance.now()-start;row.remove();if(i>=2)times.push(elapsed);}
    benchmarks.push({mode,nodes:300,samples:7,includes:'complete editor construction, attach and layout; actual DOM',allWallMs:times,medianWallMs:[...times].sort((a,b)=>a-b)[3]});
  }
  check(window.pwned===undefined,'script executed');
  return {scope:'Actual complete TreeView browser module and i18n in Chromium DOM; no HTTP/API/database/authenticated full-app session.',results,benchmarks,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length};
}'''
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=args.browser,headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    page=browser.new_page()
    page.set_content('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    result=page.evaluate(js,payload)
    result['browserVersion']=browser.version
    result['pageErrors']=errors
    browser.close()
Path(args.output).parent.mkdir(parents=True,exist_ok=True)
Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':result['passed'],'failed':result['failed'],'pageErrors':result['pageErrors'],'browserVersion':result['browserVersion'],'benchmarks':result['benchmarks']},ensure_ascii=False,indent=2))
sys.exit(1 if result['failed'] or errors else 0)
