#!/usr/bin/env python3
"""Chromium component regression of the exact changed app functions.
Uses real DOM and the complete production buildBlockPayload for text/todo,
heading/quote, toggle, callout, image, divider and attachment paths. Draft-store
callbacks remain explicit doubles. This is NOT an authenticated API/database E2E.
Requires Python Playwright, Chromium and Node with native type stripping.
Run: python scripts/verify-resource-utilization-browser.py --output /path/result.json
"""
from __future__ import annotations
import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--browser', default=shutil.which('chromium') or shutil.which('google-chrome'))
    args = parser.parse_args()
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        parser.error(f'Python Playwright is required: {exc}')
    root = Path(__file__).resolve().parents[1]
    generate = """import {baseline,appParts,payloadParts} from './tests/helpers/resource-utilization-harness.mjs';
console.log(JSON.stringify({baseline,parts:Object.fromEntries(['baseline','current'].map(m=>[m,appParts(m)])),payloads:Object.fromEntries(['baseline','current'].map(m=>[m,payloadParts(m)]))}));"""
    data = json.loads(subprocess.check_output(['node','--experimental-strip-types','--input-type=module','-e',generate], cwd=root, text=True))
    helper = (root/'tests/helpers/resource-utilization-harness.mjs').read_text()
    helper = helper[helper.index('export function makeAppHarness'):helper.index('export function makeWebSocketHarness')]
    data['helper'] = re.sub(r'^export ', '', helper, flags=re.M)
    script = r'''data => {
      const {makeAppHarness,fixture}=new Function('appParts','payloadParts','baseline',data.helper+'\nreturn {makeAppHarness,fixture};')(
        mode=>({...data.parts[mode]}),mode=>({...data.payloads[mode]}),data.baseline);
      const results=[],benchmarks=[];
      const check=(ok,message='assertion failed')=>{if(!ok)throw Error(message);};
      const equal=(a,b)=>check(JSON.stringify(a)===JSON.stringify(b),'original/current output differs');
      const test=(name,run)=>{try{run();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:String(error),stack:error.stack});}};
      function setup(mode,{n=24,nested=false,type='MARKDOWN',instrument=false}={}){
        const h=makeAppHarness(mode,{instrument,realPayload:true}),f=fixture(n,{nested});h.state.selectedPage=f.page;
        const host=document.createElement('main'),rows=[];
        for(let i=0;i<f.flat.length;i++){
          const block=f.flat[i];block.type=type;block.metadata={marker:i,textAlign:'right',toggleOpen:false,calloutType:'info',attachment:{originalName:'file.txt',size:3}};
          const row=document.createElement('section');row.className='editor-block-row'+(i%2?'':' is-dirty');row.dataset.blockId=block.id;row.dataset.blockType=type;row.dataset.textAlign='center';row.dataset.toggleOpen='true';row.dataset.calloutType='warning';
          const textarea=document.createElement('textarea');textarea.name='markdown';textarea.value=`편집 ${i} 😀 <script>window.__resourceXss=1</script>`;
          const checked=document.createElement('input');checked.type='checkbox';checked.name='checked';checked.checked=i%2===0;
          const title=document.createElement('input');title.className='toggle-title-input';title.value=`제목 ${i}`;
          row.append(textarea,checked,title);host.append(row);rows.push(row);
        }
        document.body.append(host);h.elements.blockList=host;
        return {h,f,host,rows};
      }
      for(const type of ['MARKDOWN','TODO','HEADING_1','QUOTE','TOGGLE','CALLOUT','IMAGE','DIVIDER','ATTACHMENT'])for(const nested of [false,true])for(const dirtyOnly of [false,true])test(`real payload + DOM: ${type}, nested=${nested}, dirtyOnly=${dirtyOnly}`,()=>{
        const outputs=[];
        for(const mode of ['baseline','current']){
          const x=setup(mode,{nested,type});
          try{
            const textarea=x.rows[2].querySelector('textarea');textarea.focus();textarea.setSelectionRange(2,6);
            const originalNode=x.rows[2],before=x.host.innerHTML,metadata=JSON.stringify(x.f.flat[1].metadata);
            x.h.sync({dirtyOnly});
            check(document.activeElement===textarea,'focus changed');check(textarea.selectionStart===2&&textarea.selectionEnd===6,'selection changed');
            check(x.rows[2]===originalNode&&x.host.contains(originalNode),'DOM nodes replaced');check(x.host.innerHTML===before,'DOM changed');
            if(dirtyOnly)check(JSON.stringify(x.f.flat[1].metadata)===metadata,'clean metadata mutated');
            if(type==='ATTACHMENT')check(x.f.flat[0].markdown==='원문 0','attachment name overwritten');
            else check(x.f.flat[0].markdown.includes('편집 0'),'edited content lost');
            outputs.push(x.h.state.selectedPage);
          }finally{x.host.remove();}
        }
        equal(outputs[0],outputs[1]);check(window.__resourceXss===undefined,'inert text executed');
      });
      test('5000 real DOM rows and real payload construction: 25005000 recursive visits -> 5000 index visits',()=>{
        const outputs=[];
        for(const mode of ['baseline','current']){const x=setup(mode,{n:5000,instrument:true});try{x.h.sync();check(x.h.metrics.searchVisits===(mode==='baseline'?25005000:0),'recursive count');check(x.h.metrics.indexVisits===(mode==='current'?5000:0),'index count');outputs.push(x.f.page);}finally{x.host.remove();}}
        equal(outputs[0],outputs[1]);
      });
      test('clean rows do not allocate a page index or change active input',()=>{
        const x=setup('current',{instrument:true});try{for(const row of x.rows)row.classList.remove('is-dirty');const before=JSON.stringify(x.f.page);x.h.sync({dirtyOnly:true});check(x.h.metrics.indexVisits===0);check(JSON.stringify(x.f.page)===before);}finally{x.host.remove();}
      });
      test('page/account navigation reuses no stale block references',()=>{
        const x=setup('current');try{const old=x.f.page;const next=structuredClone(old);next.id='other-account-page';next.blocks[0].markdown='other';x.h.state.selectedPage=next;x.h.sync();check(old.blocks[0].markdown==='원문 0');check(next.blocks[0].markdown.includes('편집 0'));}finally{x.host.remove();}
      });
      test('recovery with real browser objects preserves divergent-draft conflicts and different selected-page isolation',()=>{
        const outputs=[];
        for(const mode of ['baseline','current']){const h=makeAppHarness(mode),f=fixture(24,{nested:true,withDrafts:true}),other=fixture(24).page;h.state.selectedPage=other;const before=JSON.stringify(other);const alternate=structuredClone(f.record);alternate.sourceId='source_b';alternate.blocks[f.flat[0].id].payload.markdown='다른 탭';h.setRecords([f.record,alternate]);const recovered=h.recover(f.page);check(recovered.blocks[0].conflict===true);check(JSON.stringify(other)===before);outputs.push({recovered,page:f.page,events:h.events});}
        equal(outputs[0],outputs[1]);
      });
      const cases=Object.fromEntries(['baseline','current'].map(mode=>[mode,setup(mode,{n:2000})]));
      const samples={baseline:[],current:[]};
      try{for(let i=0;i<9;i++)for(const mode of i%2?['current','baseline']:['baseline','current']){const start=performance.now();cases[mode].h.sync();const elapsed=performance.now()-start;if(i>=2)samples[mode].push(elapsed);}
      for(const mode of ['baseline','current'])benchmarks.push({mode,rows:2000,samples:7,medianWallMs:[...samples[mode]].sort((a,b)=>a-b)[3],allWallMs:samples[mode],scope:'Real DOM query and complete production text payload extraction; excludes initial DOM rendering/layout, network and database.'});}finally{for(const x of Object.values(cases))x.host.remove();}
      return {scope:'Real Chromium DOM + exact changed functions and full production text-like payload builder. Storage callbacks are doubles, not authenticated server/DB E2E.',passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,results,benchmarks};
    }'''
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox','--disable-dev-shm-usage'])
        try:
            page = browser.new_page()
            page.set_content('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
            errors=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            report = page.evaluate(script, data)
            report['browserVersion']=browser.version
            report['pageErrors']=errors
        finally:
            browser.close()
    text=json.dumps(report,ensure_ascii=False,indent=2)+'\n'
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(text)
    print(text)
    return 1 if report['failed'] or report['pageErrors'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
