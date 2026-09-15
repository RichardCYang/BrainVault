#!/usr/bin/env python3
"""Real Chromium component regression tests, not full-app/server E2E.

Prerequisite: Python Playwright and a Chromium executable. The harness uses
about:blank + set_content/evaluate; it needs no HTTP server, CDN, or database.
Run: python scripts/verify-resource-efficiency-browser.py --chromium /usr/bin/chromium
Optional --output report.json. No project/configuration files are modified.
"""
from __future__ import annotations
import argparse
import json
import re
import shutil
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium', help='Chromium executable; otherwise use PATH or Playwright installation')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        parser.error(f'Python Playwright is required: {exc}')
    root = Path(__file__).resolve().parent.parent
    helper = (root / 'tests/helpers/resource-efficiency-harness.mjs').read_text()
    helper = helper[helper.index('export function extractFunction'):]
    helper = re.sub(r'^export ', '', helper, flags=re.M)
    fixture = json.loads((root / 'tests/fixtures/resource-efficiency-baseline.json').read_text())
    data = {
        'baseline': fixture,
        'currentSources': {key: (root / 'public' / name).read_text() for key, name in {
            'app': 'app.js', 'draft': 'draft-store.js', 'history': 'editor-history.js'}.items()},
        'helper': helper,
        'limits': re.sub(r'^export ', '', (root / 'public/editor-content-limits.js').read_text(), flags=re.M),
        'sanitizer': re.sub(r'^export ', '', (root / 'public/rendered-html-sanitizer.js').read_text(), flags=re.M)
    }
    script = r'''data => {
      const requireTitle = new Function(data.limits + '\nreturn requirePageTitleWithinLimit;')();
      const h = new Function('baseline','currentSources','requirePageTitleWithinLimit', data.helper +
        '\nreturn { makeAppHarness, makeDraftNormalizer, makeHistoryFactory, makeBlocks, makeOrder, randomGenerator };')(
          data.baseline, data.currentSources, requireTitle);
      const results = [];
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const equal = (a,b) => check(JSON.stringify(a) === JSON.stringify(b), 'Different serialized results');
      const test = (name, fn) => {
        const start = performance.now();
        try { fn(); results.push({name,pass:true,ms:performance.now()-start}); }
        catch(error) { results.push({name,pass:false,error:String(error.stack || error)}); }
      };
      const setPage = (app, roots=[]) => {
        app.state.selectedPage={id:'page_1',title:'Title',blocks:roots};
        app.state.allPages=[{id:'page_1',title:'Title'}];
        app.state.pages=[{id:'page_1',title:'Title'}];
      };
      for (const nested of [false,true]) test(`tree: ${nested?'nested':'flat'} 3000 blocks`,()=>{
        const {roots,flat}=h.makeBlocks(3000,{nested});
        const a=h.makeAppHarness('baseline',{instrument:true}),b=h.makeAppHarness('current',{instrument:true});
        setPage(a,roots);setPage(b,roots);
        equal(a.build(flat),b.build(flat));
        check(a.metrics.previousSearchVisits===4501500,'old scan count');
        check(b.metrics.previousIndexVisits===3000,'new index count');
      });
      for (const source of ['local','remote','recovery']) test(`snapshot: ${source} state/focus/history`,()=>{
        const {roots,flat}=h.makeBlocks(100,{nested:true});
        const a=h.makeAppHarness('baseline',{instrument:true}),b=h.makeAppHarness('current',{instrument:true});
        setPage(a,structuredClone(roots));setPage(b,structuredClone(roots));
        flat[1].markdown='수정된 내용';
        const snapshot={title:'한글 브라우저 검사',blocks:flat};
        a.apply(snapshot,{source});b.apply(snapshot,{source});a.flushFrames();b.flushFrames();
        equal(a.state,b.state);equal(a.events,b.events);
        check(a.metrics.signatureCalls===2,'old signature calls');
        check(b.metrics.signatureCalls===(source==='local'?0:2),'new signature calls');
      });
      test('snapshot: real title limit and page/account reset',()=>{
        for(const mode of ['baseline','current']) {
          const app=h.makeAppHarness(mode);setPage(app);
          app.apply({title:'x'.repeat(160),blocks:[]},{source:'local'});
          const old=JSON.stringify(app.state);let error=null;
          try{app.apply({title:'x'.repeat(161),blocks:[]},{source:'local'});}catch(e){error=e;}
          check(error?.code==='EDITOR_CONTENT_LIMIT_EXCEEDED','limit error');
          check(JSON.stringify(app.state)===old,'failed validation mutated state');
          app.state.selectedPage=null;app.apply({title:'ignored',blocks:[]});
          check(app.state.selectedPage===null,'unexpected page resurrection');
        }
      });
      test('recovery: 10000 reordered IDs, exact result and linear membership calls',()=>{
        const a=h.makeDraftNormalizer('baseline',{instrument:true}),b=h.makeDraftNormalizer('current',{instrument:true});
        equal(a.normalize(h.makeOrder(10000)),b.normalize(h.makeOrder(10000)));
        check(a.metrics.includesComparisons===50005000,'old membership count');
        check(b.metrics.setLookups===10000,'new lookup count');
      });
      const badOrders={
        duplicate:x=>x.previousIds[0]=x.previousIds[1],
        foreign:x=>x.previousIds[0]='foreign',
        badVersion:x=>x.items[0].expectedVersion=Number.MAX_SAFE_INTEGER+1,
        extra:x=>x.extra='must reject',
        badParent:x=>x.items[0].parentBlockId='foreign',
        getter:x=>Object.defineProperty(x,'mutationId',{enumerable:true,get(){throw Error('getter executed');}})
      };
      for(const [name,change] of Object.entries(badOrders)) test(`recovery: reject ${name}`,()=>{
        const input=h.makeOrder(10);change(input);
        for(const mode of ['baseline','current'])check(h.makeDraftNormalizer(mode).normalize(input)===null,'bad draft accepted');
      });
      for(const fallback of [false,true]) test(`history: 1000 randomized steps, ${fallback?'JSON fallback':'native structuredClone'}`,()=>{
        const options=fallback?{clone:undefined}:{};
        // Explicit null selects the module's JSON fallback (undefined would take
        // the helper's default structuredClone parameter).
        if(fallback)options.clone=null;
        const a=h.makeHistoryFactory('baseline',options)({maxEntries:12,maxBytes:16000});
        const b=h.makeHistoryFactory('current',options)({maxEntries:12,maxBytes:16000});
        const random=h.randomGenerator(0x42564252);let page='page_1';
        for(let i=0;i<1000;i++){
          const op=Math.floor(random()*9),key='block_'+Math.floor(random()*5);
          const value={text:'기록 '+i,rows:[{done:random()>.5,value:i}],metadata:{safe:true}};
          let x,y;
          if(op<=3){const input={pageId:page,key,value,now:i*200,coalesce:op!==3};x=a.record(input);y=b.record(input);value.rows[0].value=-1;}
          else if(op===4){x=a.commit(page,'undo');y=b.commit(page,'undo');}
          else if(op===5){x=a.commit(page,'redo');y=b.commit(page,'redo');}
          else if(op===6){x=a.seed(page,key,value);y=b.seed(page,key,value);}
          else if(op===7){x=a.discard(page,'undo');y=b.discard(page,'undo');}
          else{page=page==='page_1'?'page_2':'page_1';x=a.setPage(page);y=b.setPage(page);}
          equal(x,y);equal(a.getState(),b.getState());
          for(const direction of ['undo','redo']){const first=a.peek(page,direction),second=b.peek(page,direction);equal(first,second);if(second){second.after={bad:true};equal(a.peek(page,direction),b.peek(page,direction));}}
        }
      });
      test('history: native clone calls 400 -> 200 with same logical retention',()=>{
        const stats=[];
        for(const mode of ['baseline','current']){
          let count=0;const clone=x=>{count++;return structuredClone(x);};
          const history=h.makeHistoryFactory(mode,{clone})();
          history.seed('page_1','key',{v:0});count=0;
          for(let i=1;i<=100;i++)history.record({pageId:'page_1',key:'key',value:{v:i},now:i});
          stats.push({count,state:history.getState()});
        }
        check(stats[0].count===400&&stats[1].count===200,'clone count');equal(stats[0].state,stats[1].state);
      });
      const render = new Function(data.sanitizer+'\nreturn renderServerBlockHtml;')();
      test('real DOM security: remove executable elements and event attributes',()=>{
        const target=document.createElement('div');
        render(target,'<script>globalThis.__auditXss=1</script><svg onload="globalThis.__auditXss=2"></svg><img src="javascript:alert(1)" onerror="globalThis.__auditXss=3"><p onclick="globalThis.__auditXss=4">safe</p>');
        check(!target.querySelector('script,svg,style,math'),'executable element survived');
        check(![...target.querySelectorAll('*')].some(el=>[...el.attributes].some(at=>/^on/i.test(at.name))),'event survived');
        check(!target.querySelector('img').hasAttribute('src'),'unsafe source');
        check(target.textContent==='safe','safe text lost');
        check(globalThis.__auditXss===undefined,'script executed');
      });
      for(const href of ['javascript:alert(1)','java\nscript:alert(1)','data:text/html,bad','//evil.invalid/x'])test(`real DOM security: unsafe link ${JSON.stringify(href)}`,()=>{
        const target=document.createElement('div');render(target,`<a href="${href}">link</a>`);
        check(!target.querySelector('a').hasAttribute('href'),'unsafe link survived');
      });
      test('real DOM security: safe markup, links, style allowlist and embeds',()=>{
        const target=document.createElement('div');
        render(target,'<p><strong>노트</strong> <em>강조</em></p><a href="https://example.com/note">safe</a><span style="color:#abc;background:url(javascript:alert(1));width:25%">style</span><iframe src="https://evil.invalid/embed/a"></iframe><iframe src="https://www.youtube-nocookie.com/embed/123" title="safe"></iframe>');
        check(target.querySelector('strong').textContent==='노트','formatting lost');
        const link=target.querySelector('a');check(link.getAttribute('rel')==='noopener noreferrer','rel boundary');
        check(link.target==='_blank','target policy');
        check(target.querySelectorAll('iframe').length===1,'iframe whitelist');
        check(!target.querySelector('span').getAttribute('style').includes('background'),'style escape');
      });
      test('real DOM behavior: checkbox, details and opt-in AI controls retained',()=>{
        const target=document.querySelector('#test-content');
        render(target,'<input type="checkbox" checked><details><summary>열기</summary><p>내용</p></details><button type="button" data-ai-chat-page="2">AI</button>');
        const checkbox=target.querySelector('input');check(checkbox.checked,'checkbox initial');checkbox.click();check(!checkbox.checked,'checkbox toggle');
        const details=target.querySelector('details');target.querySelector('summary').click();check(details.open,'details toggle');
        check(!target.querySelector('button'),'AI control accepted without opt-in');
        render(target,'<button type="button" data-ai-chat-page="2">AI</button>',{allowAiControls:true});
        check(target.querySelector('button').dataset.aiChatPage==='2','AI opt-in control lost');
        target.replaceChildren();
      });
      return {scope:'Chromium in-memory component tests; NOT full-app/server E2E',userAgent:navigator.userAgent,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,tests:results};
    }'''
    with sync_playwright() as p:
        executable = args.chromium or shutil.which('chromium') or shutil.which('chromium-browser')
        launch = {'headless': True, 'args': ['--no-sandbox']}
        if executable:
            launch['executable_path'] = executable
        browser = p.chromium.launch(**launch)
        try:
            page = browser.new_page()
            page.set_content('<!doctype html><html><head><meta charset="utf-8"></head><body><main id="test-content"></main></body></html>')
            report = page.evaluate(script, data)
        finally:
            browser.close()
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(text + '\n')
    print(text)
    return 1 if report['failed'] else 0

if __name__ == '__main__':
    raise SystemExit(main())
