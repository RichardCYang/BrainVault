#!/usr/bin/env python3
"""Native Chromium component regression for the search dialog keyboard handler.
Run: CHROMIUM_PATH=/usr/bin/chromium python scripts/verify-search-keyboard-browser.py
Requires Playwright for Python. JSON goes to stdout, never README.md or docs/.
This exercises real DOM/layout/trusted input, not authenticated server end-to-end.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASELINE = json.loads((ROOT / 'tests/fixtures/search-tree-resource-baseline.json').read_text())['files']

def browser_source(mode):
    source = BASELINE['public/app.js']['source'] if mode == 'baseline' else (ROOT / 'public/app.js').read_text()
    functions = []
    for name in ('getSearchDialogFocusableElements', 'getSearchResultButtons', 'handleSearchDialogKeydown'):
        start = source.index('function ' + name + '(')
        end = source.find('\nfunction ', start + 1)
        functions.append(source[start:] if end < 0 else source[start:end])
    return '\n'.join(functions)

INSTALL = r'''(source) => {
  window.__makeSearch = (config = {}) => {
    const host = document.createElement('section');
    host.innerHTML = '<div id="dialog" role="dialog" tabindex="-1"><input id="input"><button id="close">Close</button><div id="results"></div></div>';
    document.body.append(host);
    const dialog = host.querySelector('#dialog'), input = host.querySelector('#input'), results = host.querySelector('#results');
    const count = config.count ?? 30, metrics = {resultQueries:0,resultRectReads:0};
    for (let i=0;i<count;i++) {
      const button = document.createElement('button'); button.dataset.searchResultIndex=String(i);button.id=`r${i}`;button.textContent=`Result ${i}`;
      button.disabled=(config.disabled??[]).includes(i);button.hidden=(config.hidden??[]).includes(i);
      const original=button.getClientRects.bind(button);
      button.getClientRects=()=>{metrics.resultRectReads++;return original();};results.append(button);
    }
    const query=results.querySelectorAll.bind(results);
    results.querySelectorAll=(selector)=>{metrics.resultQueries++;return query(selector);};
    const state={searchDialogOpen:true};let closes=0;
    const elements={searchDialog:dialog,searchInput:input,searchResults:results};
    const handler=new Function('document','elements','state','closeSearchDialog','mobileSidebarFocusableSelector',source+'\nreturn handleSearchDialogKeydown;')(
      document,elements,state,()=>{closes++;state.searchDialogOpen=false;},'input,button');
    document.addEventListener('keydown',handler);
    const snapshot=()=>({focus:document.activeElement?.id,value:input.value,start:input.selectionStart,end:input.selectionEnd,open:state.searchDialogOpen,closes});
    return {host,input,state,metrics,snapshot,reset(){metrics.resultQueries=metrics.resultRectReads=0;},
      dispatch(key,options={}){const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});(document.activeElement||input).dispatchEvent(event);return {...snapshot(),prevented:event.defaultPrevented};},
      destroy(){document.removeEventListener('keydown',handler);host.remove();}};
  };
  window.__lifecycle=(count)=>{for(let i=0;i<count;i++){const h=window.__makeSearch();h.input.focus();h.dispatch('a');h.dispatch('ArrowDown');h.dispatch('Escape');h.destroy();}};
}'''

def main():
    output={'method':'Retained original/current functions, native Chromium DOM, trusted Playwright keyboard, isolated component only.'}
    with sync_playwright() as p:
        executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
        browser=p.chromium.launch(executable_path=executable,headless=True,args=['--no-sandbox'])
        output['browser']=browser.version
        results={}
        for mode in ('baseline','current'):
            page=browser.new_page(); errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.set_content('<!doctype html><meta charset="utf-8"><style>button{display:inline-block}button[hidden]{display:none}</style>')
            page.evaluate(INSTALL,browser_source(mode))
            traces=[]
            for config in ({'count':30},{'count':30,'disabled':[0,3],'hidden':[1,4]},{'count':0},{'count':3,'disabled':[0,1,2]}):
                page.evaluate('(config)=>{window.__h=__makeSearch(config);__h.input.focus();}',config)
                steps=[]
                for key in ('a','Backspace','Shift','ArrowDown','ArrowDown','End','Home','ArrowUp','Tab','Shift+Tab','Escape'):
                    page.keyboard.press(key)
                    steps.append({'key':key,**page.evaluate('__h.snapshot()')})
                traces.append({'config':config,'steps':steps})
                page.evaluate('__h.destroy();window.__h=null')
            page.evaluate('window.__h=__makeSearch();__h.input.focus()')
            # Real hidden/disabled changes between navigations cannot use a stale cache.
            dynamic=page.evaluate('''()=>{
              const trace=[__h.dispatch('ArrowDown')];document.querySelector('#r1').disabled=true;document.querySelector('#r2').hidden=true;
              trace.push(__h.dispatch('ArrowDown'));document.querySelector('#r1').disabled=false;document.querySelector('#r2').hidden=false;
              trace.push(__h.dispatch('ArrowUp'));return trace;
            }''')
            assert dynamic[1]['focus']=='r3' and dynamic[2]['focus']=='r2',dynamic
            passive=page.evaluate('''()=>{__h.input.focus();__h.reset();for(let i=0;i<1000;i++)__h.dispatch(i%2?'a':'Process',{isComposing:i%2===0});return {...__h.metrics};}''')
            assert passive['resultQueries']==(1000 if mode=='baseline' else 0),passive
            assert passive['resultRectReads']==(30000 if mode=='baseline' else 0),passive
            timing=page.evaluate('''()=>{
              const run=()=>{const start=performance.now();for(let i=0;i<3000;i++)__h.dispatch('a');return performance.now()-start;};
              run();const samples=[];for(let i=0;i<9;i++)samples.push(run());return samples;
            }''')
            page.evaluate('__h.destroy();window.__h=null')
            session=page.context.new_cdp_session(page);session.send('Performance.enable')
            def memory():
                session.send('HeapProfiler.collectGarbage')
                values={x['name']:x['value'] for x in session.send('Performance.getMetrics')['metrics']}
                return {key:values[key] for key in ('JSHeapUsedSize','Nodes','JSEventListeners','Documents')}
            page.evaluate('__lifecycle(10)');snapshots=[memory()]
            for _ in range(2):page.evaluate('__lifecycle(50)');snapshots.append(memory())
            assert snapshots[-1]['Nodes']<=snapshots[0]['Nodes']+10,snapshots
            assert snapshots[-1]['JSEventListeners']<=snapshots[0]['JSEventListeners']+5,snapshots
            assert snapshots[-1]['JSHeapUsedSize']<=snapshots[0]['JSHeapUsedSize']+500_000,snapshots
            assert not errors,errors
            results[mode]={'traces':traces,'dynamic':dynamic,'passiveKeyMetrics':passive,'dispatch3000Ms':timing,'lifecycleSnapshots':snapshots}
            page.close()
        assert results['baseline']['traces']==results['current']['traces'],'Trusted keyboard traces differ'
        assert results['baseline']['dynamic']==results['current']['dynamic'],'Dynamic visibility traces differ'
        output.update({'status':'PASS','matchingTrustedKeyboardSteps':44,'matchingDynamicSteps':3,
                       'traceSha256':hashlib.sha256(json.dumps(results['current']['traces'],sort_keys=True).encode()).hexdigest(),'results':results})
        browser.close()
    print(json.dumps(output,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
