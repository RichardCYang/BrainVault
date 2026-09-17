#!/usr/bin/env python3
"""Original/current rendered-row resource regression in real Chromium.

Requires Node, Python Playwright and Chromium; no API server or npm dependencies.
Runs exact application function slices with native DOM, while save transport,
authentication scope, persistence and preview dispatch are controlled test seams.
The sanitizer case executes the actual sanitizer module. This is component
regression, not authenticated HTTP/CSP/MariaDB end-to-end certification.
Timing samples are informational; deterministic counts and parity are the gates.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
JS = r'''async ({factorySource, sources, recovery, sanitizerSource, samples}) => {
  const factory = new Function('return (' + factorySource + ')')();
  const tests = [], counts = [], timings = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const equal = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), message);
  const test = async (name, run) => {
    try { await run(); tests.push({name, passed:true}); }
    catch(error) { tests.push({name, passed:false, error:String(error), stack:error.stack}); }
  };
  const ids = n => Array.from({length:n}, (_, i) => 'b_' + i);
  function makeRow(id) {
    const row = document.createElement('article'); row.className = 'editor-block-row'; row.dataset.blockId = id;
    const input = document.createElement('textarea'); input.name = 'markdown'; input.value = '한글 😀';
    const preview = document.createElement('div'); preview.className = 'block-rendered-preview';
    row.append(input, preview); return row;
  }
  function harness(mode, identifiers = ids(2000), extra = {}) {
    const host = document.createElement('section'), root = document.createElement('div'), title = document.createElement('input');
    root.append(...identifiers.map(makeRow)); host.append(title, root); document.body.append(host);
    const state = {selectedPage:{id:'page-a', blocks:identifiers.map(id => ({id, htmlCache:'old', children:[]}))}};
    const context = factory(sources[mode], {blockList:root, pageTitle:title, state, ...extra});
    const snapshot = () => ({dom:root.innerHTML, title:title.outerHTML, state, outcome:context.outcome()});
    return {host, root, context, snapshot, dispose:() => host.remove()};
  }
  const versions = ids(2000).map(id => ({id, version:7}));
  const caches = {blocks: ids(2000).map(id => ({id, htmlCache:'<p>' + id + '</p>'}))};
  const invoke = (context, kind) => {
    if (kind === 'conflicts') return context.conflicts(versions);
    if (kind === 'materialize') return context.materialize(caches);
    if (kind === 'recovery') return context.activate(structuredClone(recovery));
    let result;
    for (let i = 0; i < 400; i++) result = context.find(['b_0','b_1000','b_1999','missing'][i % 4]);
    return result?.dataset.blockId;
  };
  function counted(h, run) {
    const all = Element.prototype.querySelectorAll, one = Element.prototype.querySelector;
    const result = {allQueries:0, singleQueries:0, listedRows:0};
    Element.prototype.querySelectorAll = function(selector) {
      const list = Reflect.apply(all, this, [selector]);
      if (this === h.root) { result.allQueries++; result.listedRows += list.length; }
      return list;
    };
    Element.prototype.querySelector = function(selector) {
      if (this === h.root) result.singleQueries++;
      return Reflect.apply(one, this, [selector]);
    };
    try { result.returnValue = run(); }
    finally { Element.prototype.querySelectorAll = all; Element.prototype.querySelector = one; }
    return result;
  }
  for (const kind of ['conflicts','materialize','recovery']) {
    await test('2,000 real rows: ' + kind + ' count and complete DOM/state parity', () => {
      const before = harness('baseline'), after = harness('current');
      try {
        const b = counted(before, () => invoke(before.context, kind));
        const a = counted(after, () => invoke(after.context, kind));
        equal(a.returnValue, b.returnValue, 'return differs');
        equal(after.snapshot(), before.snapshot(), 'DOM/state/save effects differ');
        check(b.allQueries === 2000 && b.listedRows === 4000000, 'baseline did not reproduce');
        check(a.allQueries === 1 && a.listedRows === 2000, 'batch allocation regression');
        counts.push({kind, baseline:b, current:a});
      } finally { before.dispose(); after.dispose(); }
    });
  }
  await test('400 mixed single lookups use no full NodeList snapshots', () => {
    const before = harness('baseline'), after = harness('current');
    try {
      const b = counted(before, () => invoke(before.context, 'single'));
      const a = counted(after, () => invoke(after.context, 'single'));
      check(b.allQueries === 400 && b.listedRows === 800000, 'baseline single reproduction');
      check(a.allQueries === 0 && a.singleQueries === 400, 'single lookup allocation regression');
      equal(a.returnValue, b.returnValue, 'single result differs'); counts.push({kind:'single',baseline:b,current:a});
    } finally { before.dispose(); after.dispose(); }
  });
  await test('strict IDs, selector injection, Unicode, NUL, duplicates and nested DOM order', () => {
    const identifiers = ['b_0','0','__proto__','constructor','A-Z_9','b_0','a"], .editor-block-row, [x="',
      "a'b", 'a\\b', '줄\n바꿈', '한글😀', '', 'x\u0000y', 'x\ufffdy'];
    const h = harness('current', identifiers), b = factory(sources.baseline, {blockList:h.root});
    try {
      const nested = makeRow('nested'); h.root.firstElementChild.append(nested);
      for (const id of [...identifiers, 'absent', null, undefined, 0, false, {}, NaN]) {
        check(h.context.find(id) === b.find(id), 'strict lookup differs for ' + String(id));
        check(h.context.batch(20)(id) === b.find(id), 'batch identity differs for ' + String(id));
      }
      check(h.context.find('b_0') === h.root.firstElementChild, 'duplicate must select first');
      check(h.context.find('nested') === nested, 'nested row order changed');
    } finally { h.dispose(); }
  });
  await test('empty work and early origin conflict do not enumerate rows', () => {
    const h = harness('current');
    try {
      let result = counted(h, () => {h.context.conflicts([]);h.context.materialize({blocks:[]});h.context.activate({...recovery,blocks:[],conflictCount:0});});
      check(result.allQueries === 0 && result.singleQueries === 0, 'empty work allocated');
      h.context.origins.set('b_0',{resolved:false});
      result = counted(h, () => h.context.conflicts(versions));
      check(result.returnValue === true && result.allQueries === 0 && result.singleQueries === 0, 'eager batch cache');
    } finally { h.dispose(); }
  });
  await test('page/account DOM replacement and subsequent batches use only new rows', () => {
    const h = harness('current', ids(3));
    try {
      const old = h.context.find('b_0'); h.context.conflicts([{id:'b_0'},{id:'b_1'}]);
      h.root.replaceChildren(...ids(3).map(makeRow)); h.context.scope.userId = 'user-b';
      const fresh = h.context.find('b_0'); fresh.dataset.draftConflict = 'true';
      check(old !== fresh && !old.isConnected, 'stale row reused');
      check(h.context.conflicts([{id:'b_0'},{id:'b_1'}]) === true, 'batch cache crossed page');
      fresh.remove(); check(h.context.find('b_0') === undefined, 'removed row returned');
    } finally { h.dispose(); }
  });
  for (const extra of [{invalidScope:true},{failPersistence:true}]) {
    await test('recovery abort and no save after ' + Object.keys(extra)[0], async () => {
      const snapshots = [];
      for (const mode of ['baseline','current']) {
        const h = harness(mode, ids(3), extra);
        try {
          let error; try {h.context.activate({...recovery,blocks:recovery.blocks.slice(0,3).map(b => ({...b, conflict:false}))});} catch(e) {error=String(e);}
          check(!!error, 'invalid operation did not abort'); await h.context.fireTimers();
          check(!h.context.events.some(e => e[0] === 'save-block'), 'unauthorized save occurred');
          snapshots.push({error,...h.snapshot()});
        } finally {h.dispose();}
      }
      equal(snapshots[0],snapshots[1], 'abort side effects changed');
    });
  }
  await test('nonconflicting recovery: timer, current-tab source, edits and save ordering parity', async () => {
    const outcomes = [];
    for (const mode of ['baseline','current']) {
      const h = harness(mode, ids(3));
      try {
        const input = {...recovery,blocks:recovery.blocks.slice(0,3).map(b => ({...b,conflict:false})),conflictCount:0};
        h.context.activate(input); check(h.context.timers.size === 3,'missing save timer');
        await h.context.fireTimers();
        check(h.context.events.filter(e => e[0] === 'save-block').length === 3,'save missing');
        check([...h.root.children].every(row => row.dataset.draftSourceId === 'current-tab'),'foreign source key reused');
        outcomes.push(h.snapshot());
      } finally {h.dispose();}
    }
    equal(outcomes[0],outcomes[1],'timer/save behavior differs');
  });
  const url = URL.createObjectURL(new Blob([sanitizerSource],{type:'text/javascript'}));
  const sanitizer = await import(url); URL.revokeObjectURL(url);
  await test('real sanitizer: malicious preview cannot inject script, block IDs or cross-row updates', () => {
    const outcomes=[];
    const html = '<article class="editor-block-row" data-block-id="b_1"><script>globalThis.__rowXss=1</script>' +
      '<img src="/api/auth/logout" onerror="globalThis.__rowXss=2"><a href="javascript:globalThis.__rowXss=3">bad</a>' +
      '<p>safe 한글 😀</p></article>';
    for (const mode of ['baseline','current']) {
      const h = harness(mode,ids(2),{updatePreview:(row,block) => sanitizer.renderServerBlockHtml(row.querySelector('.block-rendered-preview'),block.htmlCache)});
      try {
        h.context.materialize({blocks:[{id:'b_0',htmlCache:html},{id:'b_1',htmlCache:'<p>second block</p>'}]});
        check(h.root.querySelectorAll('[data-block-id]').length === 2,'untrusted preview forged editor row');
        check(!h.root.querySelector('script,[onerror],[href^="javascript:"]'),'unsafe markup retained');
        check(!globalThis.__rowXss,'script executed');
        check(h.root.children[1].querySelector('.block-rendered-preview').textContent === 'second block','second row missed');
        outcomes.push(h.snapshot());
      } finally {h.dispose();}
    }
    equal(outcomes[0],outcomes[1],'sanitized output differs');
  });
  await test('lookup and materialization preserve focused editor selection and row identity', () => {
    const h = harness('current',ids(3));
    try {
      const row = h.context.find('b_1'), editor = row.querySelector('textarea'); editor.focus(); editor.setSelectionRange(1,3,'backward');
      h.context.conflicts([{id:'b_0'},{id:'b_1'}]); h.context.materialize({blocks:[{id:'b_0',htmlCache:'a'},{id:'b_1',htmlCache:'b'}]});
      check(h.context.find('b_1') === row && document.activeElement === editor,'focus or identity changed');
      equal([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[1,3,'backward'],'selection changed');
    } finally {h.dispose();}
  });
  // Native DOM timing: no query spies; setup and fixture copies are outside each
  // timed region. Interleave the modes to reduce order/JIT drift. Do not gate on speed.
  for (const kind of ['single','conflicts','materialize','recovery']) {
    const measured = {baseline:[],current:[]};
    for (let sample=-1; sample<samples; sample++) {
      for (const mode of sample % 2 ? ['current','baseline'] : ['baseline','current']) {
        const h = harness(mode); const input = kind === 'recovery' ? structuredClone(recovery) : null;
        try {
          const start = performance.now();
          if (kind === 'recovery') h.context.activate(input); else invoke(h.context,kind);
          const elapsed = performance.now()-start;
          if(sample>=0) measured[mode].push(elapsed);
        } finally {h.dispose();}
      }
    }
    const median = values => {const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];};
    const before=median(measured.baseline), after=median(measured.current);
    timings.push({kind,rows:2000,samples:measured,baselineMedianMs:before,currentMedianMs:after,ratio:after ? before/after:null});
  }
  // Keep the context (as a real app would) but only WeakRefs to removed rows.
  // A later separate task + explicit Chromium GC checks that a completed batch
  // did not retain its operation-local index. Not an entire-app leak proof.
  window.__rowGc = [];
  for (const mode of ['baseline','current']) {
    const h = harness(mode,ids(100)); h.context.materialize({blocks:ids(100).map(id=>({id,htmlCache:'x'}))});
    const refs = [...h.root.children].map(row=>new WeakRef(row)); h.root.replaceChildren(); h.dispose();
    window.__rowGc.push({mode,refs,context:h.context});
  }
  return {tests,counts,timings,passed:tests.filter(t=>t.passed).length,failed:tests.filter(t=>!t.passed).length};
}'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--browser', default=shutil.which('chromium') or shutil.which('google-chrome'))
    parser.add_argument('--samples', type=int, default=7)
    args = parser.parse_args()
    if not args.browser:
        parser.error('Chromium not found; supply --browser')
    if args.samples < 3 or args.samples % 2 == 0:
        parser.error('--samples must be odd and at least 3')
    data = json.loads(subprocess.check_output(['node','--input-type=module','-e',
        "import {rowSources,createRowHarnessFromSource,recoveryFixture} from './tests/helpers/rendered-row-resource-harness.mjs';"
        "console.log(JSON.stringify({factorySource:createRowHarnessFromSource.toString(),sources:{baseline:rowSources('baseline'),current:rowSources()},recovery:recoveryFixture(2000)}));"], cwd=ROOT, text=True))
    fixture = json.loads((ROOT/'tests/fixtures/rendered-row-resource-baseline.json').read_text())
    for name, record in fixture['records'].items():
        if hashlib.sha256(record['source'].encode()).hexdigest() != record['sha256']:
            raise ValueError('Original fixture checksum mismatch: ' + name)
    data.update(sanitizerSource=(ROOT/'public/rendered-html-sanitizer.js').read_text(), samples=args.samples)
    report = {'scope':__doc__, 'pageErrors':[], 'networkRequests':[]}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.browser,headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
        try:
            report['browserVersion'] = browser.version
            context = browser.new_context(locale='ko-KR')
            context.route('**/*', lambda route: route.abort())
            page = context.new_page()
            page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
            page.on('request', lambda request: report['networkRequests'].append(request.url))
            page.set_content('<!doctype html><meta charset="utf-8"><title>Rendered row regression</title><body></body>')
            report.update(page.evaluate(JS,data))
            cdp = context.new_cdp_session(page)
            cdp.send('HeapProfiler.collectGarbage')
            cdp.send('HeapProfiler.collectGarbage')
            report['removedRowRetention'] = page.evaluate("() => window.__rowGc.map(({mode,refs}) => ({mode,checked:refs.length,retained:refs.filter(ref=>!!ref.deref()).length}))")
            retention_passed = all(item['retained']==0 for item in report['removedRowRetention'])
            report['tests'].append({'name':'completed batches do not retain removed rows after explicit GC','passed':retention_passed})
            report['passed' if retention_passed else 'failed'] += 1
            context.close()
        finally:
            browser.close()
    text=json.dumps(report,ensure_ascii=False,indent=2)+'\n'
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(text,encoding='utf-8')
    print(text)
    return int(bool(report['failed'] or report['pageErrors']))


if __name__ == '__main__':
    raise SystemExit(main())
