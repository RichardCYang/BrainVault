#!/usr/bin/env python3
"""Native Chromium regression/benchmark for the database editor.
Run: CHROMIUM_PATH=/usr/bin/chromium python scripts/verify-database-editor-resources-browser.py
Requires Python Playwright and Chromium, not additional application dependencies.
Original source is SHA-256 checked; output is JSON on stdout (no project logs).
This is a component test, not authenticated HTTP/MariaDB end-to-end coverage.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import statistics

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((ROOT / 'tests/fixtures/database-editor-resource-baseline.json').read_text())['files']['public/database-block.js']
assert hashlib.sha256(FIXTURE['source'].encode()).hexdigest() == FIXTURE['sha256']

SETUP = r'''async (sources) => {
  const urls = {};
  for (const [name, source] of Object.entries(sources)) {
    const rewritten = source.replace(/from "\.\/([^"\n]+)"/g, (_, name) => {
      if (!urls[name]) throw new Error(`Missing local dependency: ${name}`);
      return `from "${urls[name]}"`;
    });
    urls[name] = URL.createObjectURL(new Blob([rewritten], {type:'text/javascript'}));
  }
  window.__module = await import(urls['database-block.js']);
  window.__fixture = (rowCount=8, propertyCount=8, optionCount=30) => {
    const properties = Array.from({length:propertyCount}, (_,i) => ({id:i?'p'+i:'title',name:'Property '+i,type:i?'multi_select':'title',options:i?Array.from({length:optionCount},(_,j)=>({id:'o'+j,name:'항목 '+j+' 😀',color:'blue'})):[]}));
    return {title:'Database audit',properties,rows:Array.from({length:rowCount},(_,i)=>({id:'r'+i,values:Object.fromEntries(properties.map(p=>[p.id,p.type==='title'?'Row '+i:p.options.map(o=>o.id)]))})),views:['table','list','board'].map(type=>({id:type,name:type,type,filters:[],sorts:[],groupPropertyId:null,hiddenPropertyIds:[]})),activeViewId:'table'};
  };
  window.__mount = (data, onDirty=()=>{}) => {
    const row=document.createElement('div'),host=document.createElement('div');
    row.className='block-row';host.className='block-editor-host';row.append(host);
    host.append(window.__module.createDatabaseEditor(row,data,{onDirty}));
    document.body.append(row);return row;
  };
  window.__tick = () => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  window.__lifecycle = async count => {
    for(let i=0;i<count;i++) {const row=window.__mount(window.__fixture(200,20));row.remove();}
    await window.__tick();
  };
}'''

REGRESSION = r'''async () => {
  const m=window.__module,traces=[];let assertions=0;
  const check=(ok,message)=>{assertions++;if(!ok)throw new Error(message);};
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const event=(element,type)=>element.dispatchEvent(new Event(type,{bubbles:true}));
  for(const view of ['table','list','board']) {
    let dirty=0;const data=window.__fixture();data.activeViewId=view;
    data.properties[2].options[0].name='<img src=x onerror="globalThis.__auditXss=1">';
    data.properties[3]={id:'p3',name:'URL',type:'url',options:[]};
    data.properties[4]={id:'p4',name:'Group',type:'select',options:[{id:'one',name:'One',color:'blue'},{id:'two',name:'Two',color:'red'}]};
    data.properties[5]={id:'p5',name:'Checked',type:'checkbox',options:[]};
    data.properties[6]={id:'p6',name:'Date',type:'date',options:[]};
    data.properties[7]={id:'p7',name:'Number',type:'number',options:[]};
    for(let i=0;i<data.rows.length;i++)Object.assign(data.rows[i].values,{p3:i?'https://example.com/':'javascript:alert(1)',p4:i%2?'one':'two',p5:i%2===0,p6:'2026-09-18',p7:i});
    if(view==='board')data.views.find(v=>v.type===view).groupPropertyId='p4';
    const row=window.__mount(data,()=>dirty++);
    const editor=()=>row.querySelector('.database-block-editor');
    const cell=()=>row.querySelector('input[data-row-id="r0"][data-property-id="p1"]');
    const state=()=>({dirty,data:m.extractDatabaseData(row),cells:[...row.querySelectorAll('.database-value-input')].map(x=>({row:x.dataset.rowId,property:x.dataset.propertyId,value:x.value,checked:x.checked,type:x.type,maxLength:x.maxLength,aria:x.getAttribute('aria-label')})),rows:[...row.querySelectorAll('[data-database-row-id]')].map(x=>x.dataset.databaseRowId)});
    const steps=[state()];
    check(cell().value==='항목 0 😀, '+Array.from({length:29},(_,i)=>'항목 '+(i+1)+' 😀').join(', '),'Initial full multi-select labels');
    check(!row.querySelector('img,script,iframe,svg'),'Untrusted labels must stay inert');
    check(!row.querySelector('[data-row-id="r0"][data-property-id="p3"]').parentElement.querySelector('a').hasAttribute('href'),'javascript URL remains non-clickable');
    const valid=row.querySelector('[data-row-id="r1"][data-property-id="p3"]').parentElement.querySelector('a');
    check(valid.rel==='noopener noreferrer' && valid.referrerPolicy==='no-referrer','External URL protections retained');
    cell().value='x,'.repeat(999)+'x';event(cell(),'input');event(cell(),'change');
    check(same(editor().databaseData.rows[0].values.p1,[]),'Unknown names select nothing');steps.push(state());
    cell().value='항목 2 😀, 항목 1 😀, 항목 2 😀';event(cell(),'input');event(cell(),'change');
    check(same(editor().databaseData.rows[0].values.p1,['o1','o2']),'Option order and duplicate collapse retained');steps.push(state());
    let search=row.querySelector('.database-search-input');search.value='Row 3';event(search,'input');
    check(row.querySelectorAll('[data-database-row-id]').length===1,'Search filters to one row');steps.push(state());
    search.value='';event(search,'input');check(row.querySelectorAll('[data-database-row-id]').length===8,'Clear search restores all rows');
    let options=row.querySelector('[data-property-id="p1"].database-property-item .database-property-options');
    const rename=editor().databaseData.properties.find(p=>p.id==='p1').options.map(o=>o.name);rename[1]='새 이름 😀';
    options.value=rename.join(', ');event(options,'change');await window.__tick();
    check(cell().value==='새 이름 😀, 항목 2 😀','Rename updates cell without stale cached labels');steps.push(state());
    options=row.querySelector('[data-property-id="p1"].database-property-item .database-property-options');
    const prior=JSON.stringify(editor().databaseData),beforeDirty=dirty;
    options.value=rename.filter((_,i)=>i!==1).join(', ');event(options,'change');
    check(JSON.stringify(editor().databaseData)===prior && dirty===beforeDirty,'Referenced option deletion still fails closed');
    check(!options.checkValidity(),'Validation error retained');steps.push(state());
    options.value=rename.join(', ');event(options,'change');await window.__tick();
    const visible=row.querySelector('[data-property-id="p2"].database-property-item .database-property-visibility input');
    visible.checked=false;event(visible,'change');await window.__tick();
    check(!row.querySelector('.database-value-input[data-property-id="p2"]'),'Hidden fields not rendered');steps.push(state());
    const saved=m.extractDatabaseData(row),fresh=window.__mount(saved);
    check(same(m.extractDatabaseData(fresh),saved),'Saved model round trip');fresh.remove();
    traces.push({view,steps});row.remove();await window.__tick();
  }
  const hostile=JSON.parse('{"properties":[{"id":"__proto__","type":"multi_select","options":[{"id":"constructor","name":"x"}]}],"rows":[{"id":"r","values":{"__proto__":["constructor"]}}]}');
  const normalized=m.normalizeDatabaseData(hostile);
  check(!normalized.properties.some(p=>['__proto__','constructor','prototype'].includes(p.id)),'Unsafe IDs normalized');
  check(({}).polluted===undefined,'Prototype remains unmodified');
  check(!globalThis.__auditXss,'No injected event handler ran');
  const maximum=window.__mount(window.__fixture(200,20));
  check(maximum.querySelectorAll('.database-value-input').length===4000,'Maximum model retains all 4000 cells');
  check(maximum.querySelector('.database-new-row-button').disabled,'200-row cap retained');maximum.remove();
  return {assertions,traces};
}'''

BENCHMARK = r'''({view, iterations=1})=>{
  const data=window.__fixture(200,20);data.activeViewId=view;
  let total=0;
  for(let i=0;i<iterations;i++){
    const start=performance.now();const row=window.__mount(data);
    void row.offsetHeight; // Include the existing CSS/native DOM layout, not only labels.
    total+=performance.now()-start;row.remove();
  }
  return total/iterations;
}'''


def main():
    output={'method':'Original/current native ES modules; application CSS; offline Chromium component regression. Not authenticated HTTP/MariaDB E2E. Timing includes normalization, editor construction and forced layout.','results':{}}
    with sync_playwright() as p:
        executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
        browser=p.chromium.launch(executable_path=executable,headless=True,args=['--no-sandbox'])
        output['browser']=browser.version
        pages={};traces={};errors=[]
        for version in ('before','after'):
            page=browser.new_page(viewport={'width':1280,'height':900},locale='en-US')
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.route('**/*',lambda route:route.abort())
            page.set_content('<!doctype html><meta charset="utf-8"><title>Database editor regression</title><body></body>')
            page.add_style_tag(content=(ROOT/'public/styles.css').read_text())
            sources={name:(ROOT/'public'/name).read_text() for name in ('i18n.js','summary-prefix.js')}
            sources['database-block.js']=FIXTURE['source'] if version=='before' else (ROOT/'public/database-block.js').read_text()
            page.evaluate(SETUP,sources)
            result=page.evaluate(REGRESSION)
            traces[version]=result.pop('traces')
            # Playwright-generated user input, in addition to synthetic event traces.
            page.evaluate('()=>window.__mount(window.__fixture())')
            cell=page.locator('input[data-row-id="r0"][data-property-id="p1"]')
            cell.fill('항목 2 😀, 항목 1 😀');cell.press('Tab')
            actual=page.evaluate('()=>window.__module.extractDatabaseData(document.querySelector(".block-row")).rows[0].values.p1')
            assert actual==['o1','o2'],actual
            page.locator('.database-view-tab[data-view-id="list"]').click()
            page.wait_for_selector('.database-list-view')
            assert page.locator('input[data-row-id="r0"][data-property-id="p1"]').input_value()=='항목 1 😀, 항목 2 😀'
            page.evaluate('()=>document.querySelectorAll(".block-row").forEach(x=>x.remove())')
            page.evaluate('window.__tick()')
            result['trustedInteractionChecks']=2
            output['results'][version]=result;pages[version]=page
        assert traces['before']==traces['after'],'DOM/model/event traces changed'
        output['traceSha256']=hashlib.sha256(json.dumps(traces['after'],sort_keys=True).encode()).hexdigest()
        output['traceScenarios']=len(traces['after'])
        timing={}
        # Alternate order to reduce ordering/JIT effects. No noisy timing assertions.
        for view in ('table','list','board'):
            values={'before':[],'after':[]}
            for page in pages.values():
                for _ in range(3):page.evaluate(BENCHMARK,{'view':view})
            for run in range(9):
                for version in (('before','after') if run%2==0 else ('after','before')):
                    values[version].append(pages[version].evaluate(BENCHMARK,{'view':view}))
            timing[view]={version:{'median_ms':statistics.median(times),'samples_ms':times} for version,times in values.items()}
        output['fullEditorWithLayoutTiming']=timing
        for version,page in pages.items():
            session=page.context.new_cdp_session(page)
            session.send('Performance.enable')
            def memory():
                session.send('HeapProfiler.collectGarbage')
                values={x['name']:x['value'] for x in session.send('Performance.getMetrics')['metrics']}
                return {key:values[key] for key in ('JSHeapUsedSize','Nodes','JSEventListeners','Documents')}
            page.evaluate('window.__lifecycle(5)');snapshots=[memory()]
            for _ in range(2):
                page.evaluate('window.__lifecycle(20)');snapshots.append(memory())
            assert snapshots[-1]['Nodes']<=snapshots[0]['Nodes']+20,snapshots
            assert snapshots[-1]['JSEventListeners']<=snapshots[0]['JSEventListeners']+10,snapshots
            assert snapshots[-1]['JSHeapUsedSize']<=snapshots[0]['JSHeapUsedSize']+1_000_000,snapshots
            output['results'][version]['lifecycleSnapshots']=snapshots
            output['results'][version]['lifecycleCycles']=45
        assert not errors,errors
        output['status']='PASS';browser.close()
    print(json.dumps(output,indent=2))

if __name__=='__main__':
    main()
