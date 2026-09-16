#!/usr/bin/env python3
"""Compare uploaded/current modules in real Chromium (native Blob ES modules).
Requires Python Playwright and Chromium. Does not start the application server.
Run: python scripts/verify-sort-sanitizer-browser.py --output result.json
This checks real DOM/security policies and work counts, not HTTP/CSP/auth/DB E2E.
"""
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
JS = r'''async ({sources, locale}) => {
 const results=[], urls={baseline:{},current:{}}, modules={}, alloc={}, measures={};
 const check=(ok,msg='assertion failed')=>{if(!ok)throw Error(msg);};
 const equal=(a,b)=>check(JSON.stringify(a)===JSON.stringify(b),'original/current output differs');
 const test=async(name,run)=>{try{await run();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:String(e),stack:e.stack});}};
 const load=(mode,name)=>{
   if(urls[mode][name])return urls[mode][name];
   const source=sources[mode][name].replace(/(from\s+["'])\.\/([^"']+)(["'])/g,(_,a,d,b)=>a+load(mode,d)+b);
   return urls[mode][name]=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
 };
 for(const mode of ['baseline','current']){
   modules[mode]={database:await import(load(mode,'database-block.js')),sanitizer:await import(load(mode,'rendered-html-sanitizer.js'))};
   (await import(load(mode,'i18n.js'))).setLanguage(locale.split('-')[0],{persist:false});
   let source=sources[mode]['rendered-html-sanitizer.js'].replace(/new Set\(/g,'new AuditSet(')
     .replaceAll('[...node.childNodes]','auditSnapshot(node.childNodes)').replaceAll('[...template.content.childNodes]','auditSnapshot(template.content.childNodes)');
   source=`export const counts={sets:0,nodeListArrays:0,copiedNodeReferences:0};
     class AuditSet extends Set{constructor(...args){super(...args);counts.sets++;}}
     function auditSnapshot(nodes){counts.nodeListArrays++;counts.copiedNodeReferences+=nodes.length;return [...nodes];}\n`+source;
   const u=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));alloc[mode]=await import(u);URL.revokeObjectURL(u);
 }
 function render(mod,html,allowAiControls=false){const target=document.createElement('div');target.innerHTML='<p>old content</p>';mod.renderServerBlockHtml(target,html,{allowAiControls});return target;}
 const fixtures=[
   '',null,42,'plain &lt;escaped&gt; 한글 😀',
   '<!-- comment --><p>before<span>inside</span> after</p><p>last</p>',
   '<script>globalThis.auditPwned=1</script><style>body{display:none}</style><p>safe</p>',
   '<svg><script>globalThis.auditPwned=1</script></svg><math><mtext><img src=x onerror="globalThis.auditPwned=1"></mtext></math>',
   '<form action="/api/delete"><label>safe<b>text</b></label><input type=password><input type=checkbox checked disabled></form>',
   '<textarea><img src=x onerror=alert(1)></textarea><xmp>hidden</xmp><custom-element>a<span>b</span>c</custom-element>',
   '<template><script>globalThis.auditPwned=1</script></template><p title=x onclick="globalThis.auditPwned=1">text</p>',
   '<a href="https://example.test/a?b=1&amp;c=2" onclick="globalThis.auditPwned=1" target=_self rel=opener>https</a>',
   '<a href="/notes/1">relative</a><a href="#heading">anchor</a><a href="mailto:test@example.test">mail</a>',
   '<a href="javascript:globalThis.auditPwned=1">bad</a><a href="java&#x09;script:alert(1)">tab</a><a href="data:text/html,x">data</a><a href="//evil.test">network</a>',
   '<img src="/attachments/image.png" onerror="globalThis.auditPwned=1" width=120 height=80 alt="한글">',
   '<img src="data:image/png;base64,aGVsbG8="> <img src="data:image/svg+xml;base64,PHN2Zz4=">',
   '<img src="/api/delete"><img src="/%61pi/users"><img src="/%2561pi/users"><img src="//evil.test/x"><img src="https://evil.test/x">',
   '<iframe src="https://www.youtube-nocookie.com/embed/abc" title=video loading=lazy allowfullscreen onload="globalThis.auditPwned=1"></iframe>',
   '<iframe src="javascript:alert(1)"></iframe><iframe src="https://www.youtube.com.evil.test/embed/x"></iframe>',
   '<span style="color:#abc;width:25%;background:url(javascript:alert(1));grid-column:2 / span 3" data-latex="x^2" data-math-display="block">math</span>',
   '<nav class=ai-chat-pagination><button type=button data-ai-chat-page=2 aria-label=next onclick="globalThis.auditPwned=1">next</button><button type=submit>submit</button></nav>',
   '<details open><summary>summary</summary><p>body</p></details><table><thead><tr><th scope=col>h</th></tr></thead><tbody><tr><td colspan=2>v</td></tr></tbody></table>',
   '<table><p>parser foster parenting</p><tr><td>A<td>B</table><p><b>unclosed<i>markup',
   '<div>'.repeat(100)+'<a href="https://example.test">deep</a>'+'</div>'.repeat(100),
 ];
 for(let index=0;index<fixtures.length;index++)for(const ai of [false,true])await test(`real HTML parser parity ${index}, AI controls ${ai}`,()=>{
   const a=render(modules.baseline.sanitizer,fixtures[index],ai),b=render(modules.current.sanitizer,fixtures[index],ai);
   equal(a.innerHTML,b.innerHTML);equal(a.textContent,b.textContent);
   check(!b.querySelector('script,style,svg,math,textarea,xmp,form,input:not([type="checkbox"])'),'forbidden tag survived');
   for(const node of b.querySelectorAll('*'))for(const attr of node.attributes)check(!/^on/i.test(attr.name),'event attribute survived');
   for(const a of b.querySelectorAll('a')){check(a.rel==='noopener noreferrer'&&a.target==='_blank');if(a.hasAttribute('href'))check(['https:','http:','mailto:'].includes(new URL(a.getAttribute('href'),'https://brainvault.invalid/').protocol));}
   for(const img of b.querySelectorAll('img[src]')){const src=img.getAttribute('src');check(!src.startsWith('//')&&!src.startsWith('https:'));if(src.startsWith('/')){let path=new URL(src,'https://brainvault.invalid/').pathname;for(let i=0;i<8;i++)path=decodeURIComponent(path);check(!/^\/api(?:\/|$)/i.test(path));}}
   if(!ai)check(!b.querySelector('button'),'AI button leaked into normal content');
   const host=document.createElement('section');host.append(b);document.body.append(host);host.remove();
   check(globalThis.auditPwned===undefined,'HTML executed');
 });
 await test('non-Element targets retain no-op behavior',()=>{for(const target of [null,{},document.createTextNode('x')])for(const mode of ['baseline','current'])modules[mode].sanitizer.renderServerBlockHtml(target,'<p>x</p>');});
 await test('1000-link render removes per-link Sets and per-node snapshot arrays without changing HTML',()=>{
   const html='<section>'+Array.from({length:1000},(_,i)=>`<p><a href="/n/${i}">x</a><span>v</span></p>`).join('')+'</section>';
   check(html.length <= 50000,'stress fixture exceeds 50000 HTML characters');
   const outputs={};for(const mode of ['baseline','current']){for(const k of Object.keys(alloc[mode].counts))alloc[mode].counts[k]=0;outputs[mode]=render(alloc[mode],html).innerHTML;measures[mode]={...alloc[mode].counts};}
   equal(outputs.baseline,outputs.current);check(measures.baseline.sets===1000&&measures.current.sets===0);
   check(measures.baseline.nodeListArrays===3002&&measures.current.nodeListArrays===0);
   check(measures.baseline.copiedNodeReferences===5001&&measures.current.copiedNodeReferences===0);
 });
 function fixture(rows=200){const options=Array.from({length:30},(_,i)=>({id:`o${i}`,name:['İ','ı','Ä','한글','a2','a12'][i%6]+i,color:'blue'}));
   return {title:'Sorted options',properties:[{id:'title',name:'Title',type:'title',options:[]},{id:'value',name:'Value',type:'multi_select',options}],
     rows:Array.from({length:rows},(_,i)=>({id:`r${i}`,values:{title:`Row ${i}`,value:Array.from({length:10},(_,j)=>`o${(i*17+j*7)%30}`)}})),
     views:['table','list','board'].map(type=>({id:type,name:type,type,filters:[],sorts:[{id:'sort',propertyId:'value',direction:'ascending'}],hiddenPropertyIds:[],groupPropertyId:'value'})),activeViewId:'table'};
 }
 await test('native Intl comparison retains exact rows and fresh keys after 90 edits',()=>{
   const data=fixture();for(let i=0;i<90;i++){data.properties[1].options[i%30].name=`${i%2?'AAA':'ZZZ'} ${i}`;data.rows[i%200].values.value.reverse();data.views[0].sorts[0].direction=i%2?'ascending':'descending';
     const bytes=JSON.stringify(data),a=modules.baseline.database.applyDatabaseView(data),b=modules.current.database.applyDatabaseView(data);equal(a,b);check(bytes===JSON.stringify(data));b.forEach(r=>check(data.rows.includes(r),'row identity changed'));}
 });
 const frames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 async function ui(mode,scenario){const m=modules[mode].database,row=document.createElement('section');row.className='editor-block-row';const host=document.createElement('div');host.className='block-editor-host';row.append(host);document.body.append(row);let dirty=0;
   host.append(m.createDatabaseEditor(row,fixture(12),{onDirty:()=>dirty++}));
   const state=()=>({data:m.extractDatabaseData(row),dirty,html:host.innerHTML,fields:[...row.querySelectorAll('input,textarea,select')].map(n=>({value:n.value,checked:n.checked,disabled:n.disabled}))});
   try{await frames();const states=[state()];
     if(scenario==='views')for(const id of ['list','board','table','list','table']){row.querySelector(`[data-action="database-select-view"][data-view-id="${id}"]`).click();await frames();states.push(state());}
     if(scenario==='search')for(const q of ['Row 1','no-match','','<script>']){const n=row.querySelector('.database-search-input');n.value=q;n.dispatchEvent(new Event('input',{bubbles:true}));await frames();states.push(state());check(dirty===0);}
     if(scenario==='remove-sort'){row.querySelector('[data-action="database-remove-sort"]').click();await frames();states.push(state());check(m.extractDatabaseData(row).views[0].sorts.length===0);}
     if(scenario==='edit'){const title=row.querySelector('.database-title-input');title.focus();title.value='한글 <script>globalThis.auditPwned=1</script>';title.setSelectionRange(2,4);title.dispatchEvent(new Event('input',{bubbles:true}));check(document.activeElement===title&&title.selectionStart===2&&title.selectionEnd===4);states.push(state());
       const cell=row.querySelector('.database-value-input');cell.focus();cell.value='edited 😀 <img src=x onerror=alert(1)>';cell.setSelectionRange(1,3);cell.dispatchEvent(new Event('input',{bubbles:true}));check(document.activeElement===cell&&cell.selectionStart===1&&cell.selectionEnd===3);await frames();states.push(state());check(dirty===2);}
     check(globalThis.auditPwned===undefined);return states;
   }finally{row.remove();await frames();}
 }
 for(const scenario of ['initial','views','search','remove-sort','edit'])await test('sorted real editor DOM/data/focus parity: '+scenario,async()=>equal(await ui('baseline',scenario),await ui('current',scenario)));
 // Only WeakRefs remain after these synchronous invocations. The Python harness
 // performs GC after evaluate returns, in a separate browser task.
 globalThis.resourceSortRefs={baseline:[],current:[]};
 for(const mode of ['baseline','current'])for(let i=0;i<12;i++){const data=fixture(30);resourceSortRefs[mode].push(new WeakRef(data),...data.rows.map(r=>new WeakRef(r.values.value)));modules[mode].database.applyDatabaseView(data);}
 for(const cache of Object.values(urls))for(const url of Object.values(cache))URL.revokeObjectURL(url);
 return {locale,resolvedLocale:Intl.DateTimeFormat().resolvedOptions().locale,results,allocationCounts:measures,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length};
}'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--browser', default=shutil.which('chromium') or shutil.which('google-chrome'))
    args = parser.parse_args()
    if not args.browser:
        parser.error('Chromium executable not found; specify --browser')
    baseline = json.loads((ROOT / 'tests/fixtures/sort-sanitizer-resource-baseline.json').read_text())
    sources = {}
    for mode in ['baseline', 'current']:
        sources[mode] = {}
        def collect(name):
            if name in sources[mode]:
                return
            record = baseline['files'].get('public/' + name) if mode == 'baseline' else None
            if record:
                source = record['source']
                if hashlib.sha256(source.encode()).hexdigest() != record['sha256']:
                    raise ValueError('Uploaded fixture hash mismatch: ' + name)
            else:
                source = (ROOT / 'public' / name).read_text()
            sources[mode][name] = source
            for dep in re.findall(r'from\s+["\']\./([^"\']+)["\']', source):
                collect(dep)
        collect('database-block.js')
        collect('rendered-html-sanitizer.js')
    report = {'scope':'Uploaded/current native modules in real Chromium. Requests aborted. No application server, authenticated API, CSP/HTTP, localStorage origin, or MariaDB E2E.', 'runs':[], 'pageErrors':[]}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox','--disable-dev-shm-usage'])
        try:
            report['browserVersion'] = browser.version
            for locale in ['en-US','ko-KR','tr-TR']:
                context = browser.new_context(locale=locale)
                try:
                    context.route('**/*', lambda route: route.abort())
                    page = context.new_page()
                    page.on('pageerror', lambda error, lang=locale: report['pageErrors'].append({'locale':lang,'error':str(error)}))
                    page.set_content('<!doctype html><meta charset="utf-8"><title>Sort/sanitizer regression</title><body></body>')
                    run = page.evaluate(JS, {'sources':sources,'locale':locale})
                    page.wait_for_timeout(30)
                    cdp = context.new_cdp_session(page)
                    cdp.send('HeapProfiler.collectGarbage')
                    cdp.send('HeapProfiler.collectGarbage')
                    alive = page.evaluate('Object.fromEntries(Object.entries(resourceSortRefs).map(([mode,refs])=>[mode,refs.filter(r=>r.deref()).length]))')
                    run['sortInputRetention'] = {'weakReferencesPerVersion':372,'aliveAfterGc':alive}
                    ok = all(value == 0 for value in alive.values())
                    run['results'].append({'name':'invocation-local cache does not retain discarded input/selection arrays after forced GC','passed':ok})
                    run['passed' if ok else 'failed'] += 1
                    report['runs'].append(run)
                finally:
                    context.close()
        finally:
            browser.close()
    report['passed'] = sum(run['passed'] for run in report['runs'])
    report['failed'] = sum(run['failed'] for run in report['runs'])
    text = json.dumps(report,ensure_ascii=False,indent=2)+'\n'
    if args.output:
        args.output.write_text(text)
    print(text)
    return 1 if report['failed'] or report['pageErrors'] else 0

if __name__ == '__main__':
    raise SystemExit(main())
