#!/usr/bin/env python3
"""Actual Chromium DOM/module regression; not a server/database E2E test.

Requires Python Playwright and Chromium. Runs entirely locally, makes no network
requests, and writes nothing unless --output is supplied.
Run: python scripts/verify-editor-batch-browser.py --chromium /usr/bin/chromium
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium', help='Browser executable, otherwise detect Chromium')
    parser.add_argument('--output', type=Path, help='Optional JSON result outside the project')
    args = parser.parse_args()
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        parser.error(f'Python Playwright is required: {exc}')
    root = Path(__file__).resolve().parent.parent
    helper = (root / 'tests/helpers/editor-batch-resource-harness.mjs').read_text(encoding='utf-8')
    helper = re.sub(r'^export ', '', helper[helper.index('export function extractFunction'):], flags=re.M)
    current_app = (root / 'public/app.js').read_text(encoding='utf-8')
    current_caret = (root / 'public/collaboration-caret.js').read_text(encoding='utf-8')
    fixture = json.loads((root / 'tests/fixtures/editor-batch-resource-baseline.json').read_text(encoding='utf-8'))
    data = {'baseline': fixture, 'currentApp': current_app, 'currentCaret': current_caret, 'helper': helper}
    script = r'''async data => {
      const h = new Function('baseline', 'currentApp', 'currentCaret', data.helper +
        '\nreturn {makeApp,makeBlocks,makeCaret,randomGenerator,extractFunction};')(
          data.baseline,data.currentApp,data.currentCaret);
      const currentURL = URL.createObjectURL(new Blob([data.currentCaret], {type:'text/javascript'}));
      const current = await import(currentURL); URL.revokeObjectURL(currentURL);
      const baselineURL = URL.createObjectURL(new Blob([data.baseline.caret], {type:'text/javascript'}));
      const before = await import(baselineURL); URL.revokeObjectURL(baselineURL);
      const results = [], operations = [];
      const check = (value,message='assertion failed')=>{if(!value)throw Error(message);};
      const equal = (a,b)=>check(JSON.stringify(a)===JSON.stringify(b),'serialized output differs');
      const test = async(name,fn)=>{try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.stack||String(e)});}};
      const stage=document.querySelector('main');
      const makeRow=(id,type='MARKDOWN',text='한글 😀 <script>data only</script>')=>{
        const row=document.createElement('div');row.className='editor-block-row';
        Object.assign(row.dataset,{blockId:id,blockType:type,textAlign:'right',toggleOpen:'true'});
        const textControl=document.createElement('textarea');textControl.name='markdown';textControl.value=text;
        const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.name='checked';checkbox.checked=true;
        row.append(textControl,checkbox);return row;
      };
      const makeControl=(type,index)=>{
        const el=document.createElement(type==='textarea'?'textarea':'input');
        if(type!=='textarea')el.type=type;
        if(type!=='file')el.value=`${index} 한글😀`;
        el.dataset.index=String(index);return el;
      };
      await test('native ES module exports remain identical',()=>equal(Object.keys(current).sort(),Object.keys(before).sort()));
      for(const type of ['text','search','tel','url','password','textarea','number','checkbox','hidden','email','date','file']) {
        await test(`real ${type} selection eligibility and ordinal mapping`,()=>{
          const row=document.createElement('div');const input=makeControl(type,0),tail=makeControl('textarea',1);row.append(input,tail);stage.replaceChildren(row);
          for(const target of [input,tail,null,document.createElement('input')])check(
            current.getTextSelectionControlKey(target,row)===before.getTextSelectionControlKey(target,row),'key mismatch');
          for(const key of ['text:0','text:1','text:2'])check(current.getTextSelectionControlByKey(row,key)===before.getTextSelectionControlByKey(row,key),'target mismatch');
          const a=current.getRowTextSelectionControls(row),b=before.getRowTextSelectionControls(row);check(a.length===b.length&&a.every((v,i)=>v===b[i]));
        });
      }
      await test('mixed 1000-control DOM: all keys, focus, values and selections match',()=>{
        const row=document.createElement('div'),types=['text','textarea','number','checkbox','hidden','email','search'];
        for(let i=0;i<1000;i++)row.append(makeControl(types[i%types.length],i));stage.replaceChildren(row);
        const controls=before.getRowTextSelectionControls(row);controls[10].focus();controls[10].setSelectionRange(1,3);
        const values=[...row.children].map(el=>el.value),active=document.activeElement;
        for(const [i,input]of controls.entries()){
          const key=current.getTextSelectionControlKey(input,row);check(key===`text:${i}`);check(key===before.getTextSelectionControlKey(input,row));
          check(current.getTextSelectionControlByKey(row,key)===input);
        }
        check(document.activeElement===active&&active.selectionStart===1&&active.selectionEnd===3,'focus/selection changed');
        equal([...row.children].map(el=>el.value),values);
      });
      await test('DOM mutation, reordered controls, removed nodes and input type changes are not cached',()=>{
        const row=document.createElement('div'),a=makeControl('text',0),b=makeControl('textarea',1),c=makeControl('text',2);row.append(a,b,c);stage.replaceChildren(row);
        check(current.getTextSelectionControlByKey(row,'text:0')===a);row.prepend(c);
        check(current.getTextSelectionControlByKey(row,'text:0')===c);c.remove();a.type='number';
        check(current.getTextSelectionControlByKey(row,'text:0')===b);check(current.getTextSelectionControlKey(c,row)===null);
        row.replaceChildren(makeControl('text',3));check(current.getTextSelectionControlByKey(row,'text:0')!==b);
      });
      for(const key of ['text:-1','text:10000','text:1.0','text:0] input','text:0\n','__proto__','constructor','<img src=x onerror=alert(1)>',null,{},4]) {
        await test(`untrusted awareness key: ${JSON.stringify(key)}`,()=>{
          const row=document.createElement('div');row.append(makeControl('text',0));
          check(current.getTextSelectionControlByKey(row,key)===before.getTextSelectionControlByKey(row,key),'validation changed');
        });
      }
      await test('caret hot path: no copied/filtered full-control arrays, prefix-only iteration',()=>{
        const row=document.createElement('div');for(let i=0;i<1000;i++)row.append(makeControl('text',i));stage.replaceChildren(row);
        const target=row.firstElementChild,nativeIterator=NodeList.prototype[Symbol.iterator],nativeFilter=Array.prototype.filter;
        let visits=0,filterCalls=0;
        NodeList.prototype[Symbol.iterator]=function*(){for(const item of nativeIterator.call(this)){visits++;yield item;}};
        Array.prototype.filter=function(...args){filterCalls++;return nativeFilter.apply(this,args);};
        const stats=[];
        try {for(const api of [before,current]){visits=0;filterCalls=0;check(api.getTextSelectionControlKey(target,row)==='text:0');check(api.getTextSelectionControlByKey(row,'text:0')===target);stats.push({visits,filterCalls});}}
        finally{NodeList.prototype[Symbol.iterator]=nativeIterator;Array.prototype.filter=nativeFilter;}
        equal(stats,[{visits:2000,filterCalls:2},{visits:2,filterCalls:0}]);operations.push({operation:'real DOM caret roundtrip, 1000 inputs',before:stats[0],after:stats[1]});
      });
      await test('caret lookup adds no DOM writes, listeners or timers',()=>{
        const row=document.createElement('div');row.append(makeControl('text',0));stage.replaceChildren(row);
        const observer=new MutationObserver(()=>{});observer.observe(stage,{subtree:true,childList:true,attributes:true,characterData:true});
        const nativeAdd=EventTarget.prototype.addEventListener,nativeTimeout=window.setTimeout,nativeInterval=window.setInterval;let listeners=0,timers=0;
        EventTarget.prototype.addEventListener=function(...args){listeners++;return nativeAdd.apply(this,args);};
        window.setTimeout=function(...args){timers++;return nativeTimeout.apply(this,args);};window.setInterval=function(...args){timers++;return nativeInterval.apply(this,args);};
        try{for(let i=0;i<1000;i++){current.getTextSelectionControlKey(row.firstChild,row);current.getTextSelectionControlByKey(row,'text:0');}}
        finally{EventTarget.prototype.addEventListener=nativeAdd;window.setTimeout=nativeTimeout;window.setInterval=nativeInterval;}
        const mutations=observer.takeRecords();observer.disconnect();check(listeners===0&&timers===0&&mutations.length===0,'lookup mutated environment');
      });
      for(const count of [1,100,2000]) await test(`real DOM keepalive: ${count} edited rows, UTF-8 bytes and payloads`,()=>{
        const f=h.makeBlocks(count,{nested:true}),rows=new Map();
        const types=['MARKDOWN','TODO','ATTACHMENT','TOGGLE','QUOTE','DIVIDER'];
        for(let i=0;i<count;i++){const row=makeRow(f.ids[i],types[i%types.length]);rows.set(f.ids[i],row);}
        stage.replaceChildren(...rows.values());const stats=[];
        for(const mode of ['baseline','current']){const app=h.makeApp(mode,{capturePayloads:true});app.state.selectedPage.blocks=f.roots;
          const title=document.createElement('input');title.value='제목 😀';app.elements.pageTitle=title;
          const bytes=app.bytes({saveTitle:true,rowsToSave:rows});
          check(bytes===app.payloads.reduce((n,x)=>n+new TextEncoder().encode(JSON.stringify(x)).byteLength,0),'UTF-8 accounting');
          stats.push({bytes,payloads:app.payloads});}
        equal(stats[0],stats[1]);check(!stage.querySelector('script'),'text executed as markup');
      });
      for(const delta of [-1,0,1])await test(`real DOM keepalive budget: 60KiB ${delta>=0?'+':''}${delta}`,()=>{
        const stats=[];for(const mode of ['baseline','current']){const app=h.makeApp(mode);app.state.selectedPage.blocks=h.makeBlocks(1).roots;
          const row=makeRow('block-0','MARKDOWN',''),rows=new Map([['block-0',row]]);const overhead=app.bytes({saveTitle:false,rowsToSave:rows});
          row.querySelector('textarea').value='x'.repeat(60*1024+delta-overhead);const bytes=app.bytes({saveTitle:false,rowsToSave:rows});check(bytes===60*1024+delta);stats.push(bytes<=60*1024);}
        equal(stats,[delta<=0,delta<=0]);
      });
      for(const change of ['navigation','auth','page','read-only'])await test(`queued collaborative commit: ${change} still blocks mutation`,async()=>{
        const app=h.makeApp();app.state.selectedPage.blocks=h.makeBlocks(2).roots;
        let release,commits=0;app.state.collaborationSession={isReady:true,async upsertBlocks(updates,{beforeCommit}){await new Promise(r=>release=r);if(beforeCommit())commits++;}};
        const pending=app.persist(null,['block-1','block-0']);if(change==='auth')app.gate.auth++;else if(change==='navigation')app.gate.navigation++;else if(change==='page')app.state.selectedPage={id:'other',blocks:[]};else app.gate.writable=false;
        release();let outcome;try{outcome=await pending;}catch(e){check(change==='auth'&&e.message==='STALE_AUTH');}
        if(change!=='auth')check(outcome===app.skippedApiRequest);check(commits===0,'stale write committed');
      });
      for(const state of [null,{}, {selection:{}}, {selection:{},control:'title'}, {selection:{},field:'title'},
        {selection:{},blockId:'missing'}, {selection:{},blockId:'row',control:'text:1'},
        {selection:{},blockId:'row',control:'bad',field:'markdown'}, {selection:{},blockId:'row',control:'bad',field:'table'},
        {selection:{},blockId:'row',control:'bad'}, {selection:{},blockId:'row',control:'text:9999'},
        {selection:{},blockId:'empty',control:'bad'}]) await test(`remote caret app dispatch: ${JSON.stringify(state)}`,()=>{
          const row=makeRow('row');const cell=makeControl('text',3);cell.className='table-cell-input';row.append(cell);
          const title=document.createElement('input'),empty=document.createElement('div');stage.replaceChildren(title,row,empty);
          const find=id=>id==='row'?row:id==='empty'?empty:null;
          const stats=[];for(const [api,source]of [[before,data.baseline.remoteCaretTargetSource],[current,h.extractFunction(data.currentApp,'getRemoteCollaborationCaretTarget')]]){
            const get=new Function('elements','findRenderedBlockRow','getTextSelectionControlByKey','getRowTextSelectionControls',source+'\nreturn getRemoteCollaborationCaretTarget;')(
              {pageTitle:title},find,api.getTextSelectionControlByKey,api.getRowTextSelectionControls);
            stats.push(get({state}));
          }
          check(stats[0]===stats[1],'app target/fallback identity changed');
      });
      stage.replaceChildren();return{scope:'Native Chromium ES modules and DOM; extracted app functions with explicit auth/network doubles; NOT full-app/DB E2E',userAgent:navigator.userAgent,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,operations,tests:results};
    }'''
    with sync_playwright() as playwright:
        executable = args.chromium or shutil.which('chromium') or shutil.which('chromium-browser')
        launch = {'headless': True, 'args': ['--no-sandbox']}
        if executable:
            launch['executable_path'] = executable
        browser = playwright.chromium.launch(**launch)
        try:
            page = browser.new_page()
            page_errors = []
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            # Native module imports use Blob URLs on about:blank: no network.
            page.route('**/*', lambda route: route.abort())
            page.set_content('<!doctype html><meta charset="utf-8"><main></main>')
            report = page.evaluate(script, data)
            report["pageErrors"] = page_errors
            report["browserVersion"] = browser.version
        finally:
            browser.close()
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(text + '\n', encoding='utf-8')
    print(text)
    return int(report['failed'] > 0 or bool(report['pageErrors']))


if __name__ == '__main__':
    raise SystemExit(main())
