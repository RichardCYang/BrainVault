#!/usr/bin/env python3
"""Compare native browser modules to the retained original fixture.
Requires Python 3, Playwright for Python, and Chromium; no project dependency changes.
Run: CHROMIUM_PATH=/usr/bin/chromium python scripts/verify-resource-audit-2026-09-18-browser.py
Loads local modules through Blob URLs without network access. Writes JSON to stdout, not docs/.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = (ROOT / 'public').resolve()
FIXTURE = json.loads((ROOT / 'tests/fixtures/resource-audit-2026-09-18-baseline.json').read_text())['files']

BROWSER_TEST = r'''async (version) => {
  const m = await import(window.__auditModules['treeview-block.js']);
  const high = await import(window.__auditModules['code-highlighting.js']);
  const assert = (ok, reason) => { if (!ok) throw new Error(reason); };
  let assertions = 0;
  const check = (ok, reason) => { assertions++; assert(ok, reason); };
  const tick = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const nodes = [
    {id:'p', parentId:null, title:'Parent', note:'parent note', expanded:false},
    {id:'a', parentId:'p', title:'Alpha', note:'alpha note', expanded:true},
    {id:'b', parentId:'p', title:'Beta', note:'beta note', expanded:true},
    {id:'g', parentId:'b', title:'Grandchild', note:'grandchild note', expanded:true},
    {id:'q', parentId:null, title:'Last', note:'last note', expanded:true}
  ];
  const traces = [];
  const label = (editor, id) => editor.querySelector(`[data-action="treeview-select-node"][data-treeview-node-id="${CSS.escape(id)}"]`);
  const state = (editor, dirty) => ({
    data: structuredClone(editor.treeViewData), selected: editor.treeViewSelectedNodeId, dirty,
    focus: document.activeElement?.dataset.treeviewNodeId ?? null,
    aria: [...editor.querySelectorAll('[role="treeitem"]')].map(x => [x.dataset.treeviewNodeId, x.getAttribute('aria-selected'), x.getAttribute('aria-expanded'), x.getAttribute('aria-level'), x.tabIndex]),
    groupsHidden: [...editor.querySelectorAll('[role="group"]')].map(x => x.hidden)
  });
  for (const readOnly of [false, true]) {
    for (const shape of ['nested', 'flat300', 'deep300']) {
      let dirty = 0;
      const row = document.createElement('div');
      row.setAttribute('aria-readonly', String(readOnly));
      document.body.append(row);
      const inputNodes = shape === 'nested' ? nodes : Array.from({length:300}, (_, i) => ({id:`n${i}`, parentId:shape === 'deep300' && i ? `n${i-1}` : null, title:`Node ${i}`, note:`note ${i}`, expanded:true}));
      const editor = m.createTreeViewEditor(row, {title:'Audit',nodes:inputNodes}, {onDirty:()=>dirty++});
      row.append(editor);
      check(editor.querySelectorAll('[role="treeitem"]').length === inputNodes.length, 'All nodes retained');
      const initial = inputNodes[0].id;
      label(editor, initial).focus();
      const steps = [];
      for (const key of ['Shift','Tab','a','Escape','ArrowRight','ArrowRight','ArrowDown','ArrowRight','ArrowDown','End','Home','ArrowLeft','ArrowRight','Enter',' ','ArrowUp']) {
        const target = label(editor, editor.treeViewSelectedNodeId);
        const previous = state(editor, dirty);
        const event = new KeyboardEvent('keydown', {key,bubbles:true,cancelable:true});
        // Exercise delegation from the label's nested text element too.
        target.querySelector('.treeview-node-label-text').dispatchEvent(event);
        await tick();
        const next = state(editor, dirty);
        if (['Shift','Tab','a','Escape'].includes(key)) {
          check(!event.defaultPrevented, `Pass through ${key}`);
          check(JSON.stringify(previous) === JSON.stringify(next), `No state change for ${key}`);
        }
        check(editor.querySelectorAll('[role="treeitem"][aria-selected="true"]').length === 1, 'Exactly one selection');
        check(editor.querySelectorAll('[role="treeitem"][tabindex="0"]').length === 1, 'Exactly one tab stop');
        steps.push({key, prevented:event.defaultPrevented, ...next});
      }
      if (readOnly) check(dirty === 0, 'Read-only navigation does not dirty the note');
      traces.push({readOnly,shape,steps});
      row.remove();
    }
  }
  for (const readOnly of [false,true]) {
    let dirty=0;
    const row=document.createElement('div'); row.setAttribute('aria-readonly', String(readOnly)); document.body.append(row);
    let editor=m.createTreeViewEditor(row,{title:'Audit',nodes},{onDirty:()=>dirty++}); row.append(editor);
    label(editor,'b').click();
    check(editor.treeViewSelectedNodeId === 'b','Mouse selection');
    const title=editor.querySelector('.treeview-note-title-input'); title.value='<img src=x onerror="globalThis.__auditXss=1">'; title.dispatchEvent(new Event('input',{bubbles:true}));
    const note=editor.querySelector('.treeview-note-input'); note.value='changed note'; note.dispatchEvent(new Event('input',{bubbles:true}));
    check(!editor.querySelector('img,script,iframe'),'Titles remain text, never active HTML');
    const saved=m.extractTreeViewData(row);
    check(saved.nodes.find(x=>x.id==='b').note === (readOnly?'beta note':'changed note'),'Editable/read-only data boundary');
    check(readOnly ? dirty===0 : dirty===2,'Dirty notifications preserved');
    editor.replaceWith(m.createTreeViewEditor(row,saved,{selectedNodeId:'b',onDirty:()=>dirty++}));
    editor=row.querySelector('.treeview-block-editor');
    check(JSON.stringify(saved)===JSON.stringify(m.extractTreeViewData(row)),'Data round trip');
    for (const action of ['treeview-move-up','treeview-move-down','treeview-indent','treeview-outdent']) {
      const button=editor.querySelector(`[data-action="${action}"][data-treeview-node-id="b"]`);
      if(button && !button.disabled) button.click();
      await tick(); editor=row.querySelector('.treeview-block-editor');
      check(editor.treeViewData.nodes.length===5,'Move preserves all nodes');
    }
    traces.push({kind:'editing', readOnly, state:state(editor,dirty)});
    row.remove();
  }
  const luaCases=['', 'local x=1\nprint(x) -- <tag>', '--[=[<script>globalThis.__auditXss=1</script>]=]', '<img src=x onerror="globalThis.__auditXss=1">', '"<svg onload=globalThis.__auditXss=1>"', '& < > '.repeat(3000), 'x'.repeat(20001)];
  const rendered=[];
  for(const value of luaCases){
    const output=high.highlightLuaSource(value), host=document.createElement('div');
    if(output===null) host.textContent=value; else host.innerHTML=output;
    document.body.append(host);
    check(host.textContent===value,'Lua text content round trip');
    check(!host.querySelector('img,script,iframe,svg'),'Lua HTML remains inert');
    rendered.push(output); host.remove();
  }
  check(high.highlightLuaSource('x'.repeat(20001))===null,'Lua length cap');
  check(high.highlightCodeForBrowser('a'.repeat(2001),'javascript')===null,'Generic grammar length cap');
  await tick(); check(!globalThis.__auditXss,'No injected handler executed');
  // Count Map lookups in the real listener, without changing module source.
  const row=document.createElement('div'); document.body.append(row);
  const flat=Array.from({length:300},(_,i)=>({id:`cost${i}`,parentId:null,title:`n${i}`,note:'',expanded:true}));
  const editor=m.createTreeViewEditor(row,{nodes:flat}); row.append(editor);
  const target=label(editor,'cost0'), NativeMap=globalThis.Map;
  let mapGets=0, maps=0;
  globalThis.Map=class extends NativeMap {constructor(...args){super(...args);maps++;} get(key){mapGets++;return super.get(key);}};
  try {for(let i=0;i<1000;i++) target.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true,cancelable:true}));}
  finally {globalThis.Map=NativeMap;}
  row.remove();
  if(version==='after') {check(mapGets===0,'No Map traversal for ignored keys');check(maps===0,'No Map allocation for ignored keys');}
  window.__auditLifecycle=async(count)=>{
    for(let i=0;i<count;i++){
      const row=document.createElement('div');document.body.append(row);
      const editor=m.createTreeViewEditor(row,{nodes:flat});row.append(editor);
      label(editor,'cost0').dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true}));
      row.remove();
    }
    await tick();
  };
  return {assertions,traces,rendered,mapGets,maps};
}'''

def main():
    output = {'method': 'Native ES modules and Chromium DOM; original/current exact trace comparison. Isolated components, not authenticated HTTP/MariaDB end-to-end.'}
    with sync_playwright() as p:
        executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
        browser = p.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])
        output['browser'] = browser.version
        results = {}
        for version in ('before', 'after'):
            page = browser.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.set_content('<!doctype html><meta charset="utf-8"><title>BrainVault regression</title><body></body>')
            module_sources = {}
            for name in ('i18n.js', 'editor-content-limits.js', 'treeview-block.js', 'code-highlighting.js'):
                key = f'public/{name}'
                module_sources[name] = FIXTURE[key]['source'] if version == 'before' and key in FIXTURE else (PUBLIC / name).read_text()
            page.evaluate(r'''(sources) => {
              const urls = {};
              for (const [name, source] of Object.entries(sources)) {
                const rewritten = source.replace(/from "\.\/([^"\n]+)"/g, (_, dependency) => {
                  if (!urls[dependency]) throw new Error(`Unknown dependency ${dependency}`);
                  return `from "${urls[dependency]}"`;
                });
                urls[name] = URL.createObjectURL(new Blob([rewritten], {type:'text/javascript'}));
              }
              window.__auditModules = urls;
            }''', module_sources)
            result = page.evaluate(BROWSER_TEST, version)
            assert not errors, errors
            session = page.context.new_cdp_session(page)
            session.send('Performance.enable')
            def memory():
                session.send('HeapProfiler.collectGarbage')
                values = {x['name']: x['value'] for x in session.send('Performance.getMetrics')['metrics']}
                return {k: values[k] for k in ('JSHeapUsedSize','Nodes','JSEventListeners','Documents')}
            page.evaluate('window.__auditLifecycle(10)')
            snapshots = [memory()]
            for _ in range(2):
                page.evaluate('window.__auditLifecycle(50)')
                snapshots.append(memory())
            assert snapshots[-1]['Nodes'] <= snapshots[0]['Nodes'] + 20, snapshots
            assert snapshots[-1]['JSEventListeners'] <= snapshots[0]['JSEventListeners'] + 10, snapshots
            assert snapshots[-1]['JSHeapUsedSize'] <= snapshots[0]['JSHeapUsedSize'] + 1_000_000, snapshots
            result['lifecycleSnapshots'] = snapshots
            # Actual trusted Playwright keyboard input (not only dispatched events).
            page.evaluate(f'''async()=>{{const m=await import(window.__auditModules['treeview-block.js']);const row=document.createElement('div');document.body.append(row);row.append(m.createTreeViewEditor(row,{{nodes:[{{id:'u',parentId:null,title:'u',expanded:true}},{{id:'v',parentId:null,title:'v',expanded:true}}]}}));}}''')
            page.locator('[data-action="treeview-select-node"][data-treeview-node-id="u"]').focus()
            page.keyboard.press('ArrowDown')
            page.wait_for_function("document.activeElement?.dataset.treeviewNodeId === 'v'")
            page.keyboard.press('Home')
            page.wait_for_function("document.activeElement?.dataset.treeviewNodeId === 'u'")
            result['trustedKeyboardChecks'] = 2
            results[version] = result
            page.close()
        assert results['before']['traces'] == results['after']['traces'], 'Tree DOM/state/ARIA/dirty traces differ'
        assert results['before']['rendered'] == results['after']['rendered'], 'Lua native browser outputs differ'
        trace = json.dumps(results['after']['traces'], sort_keys=True).encode()
        output.update({'status':'PASS','matchingTreeScenarios':len(results['after']['traces']), 'matchingKeyboardSteps':96,
                       'traceSha256':hashlib.sha256(trace).hexdigest(), 'nativeLuaCases':len(results['after']['rendered']),
                       'results':{k:{x:v[x] for x in ('assertions','mapGets','maps','lifecycleSnapshots','trustedKeyboardChecks')} for k,v in results.items()}})
        browser.close()
    print(json.dumps(output, indent=2))

if __name__ == '__main__':
    main()
