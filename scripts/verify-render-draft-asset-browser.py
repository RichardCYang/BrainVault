#!/usr/bin/env python3
"""Offline Chromium component regression, not backend/authentication/full-app E2E.
Requires Python + playwright and an installed Chromium. Run:
  python scripts/verify-render-draft-asset-browser.py --chromium /path/to/chromium --output browser.json
Uses exact original/current asset-wait functions, real DOM listeners and CDP
inspection. The test image.complete flag is held false to model stalled loads;
load/error events and the 2500-ms clock are controlled, not external requests.
No project files, browser security policies, or production settings are changed.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import re
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def listener_count(cdp, count):
    total = 0
    for i in range(count):
        obj = cdp.send('Runtime.evaluate', {'expression': f'__assets[{i}]', 'objectGroup': 'resource-audit'})['result']['objectId']
        total += len(cdp.send('DOMDebugger.getEventListeners', {'objectId': obj})['listeners'])
    cdp.send('Runtime.releaseObjectGroup', {'objectGroup': 'resource-audit'})
    return total

def run_case(browser, source, mode, scenario):
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    # about:blank + local content; no network or navigation policy changes.
    page.set_content('<!doctype html><title>BrainVault resource regression</title>')
    page.clock.install(time=datetime(2026, 9, 16, tzinfo=timezone.utc))
    page.clock.pause_at(datetime(2026, 9, 16, 0, 0, 10, tzinfo=timezone.utc))
    cdp = page.context.new_cdp_session(page)
    page.evaluate('''source => {
      const pageView = document.createElement('div');
      globalThis.__assets = [];
      for(let i=0;i<20;i++) {
        const el=document.createElement(i<12?'img':'iframe');
        if(i<12) Object.defineProperty(el,'complete',{value:false});
        else el.className='mermaid-sandbox-frame';
        pageView.append(el); __assets.push(el);
      }
      globalThis.__wait = new Function('elements', source+';return waitForPdfExportAssets;')({pageView});
      globalThis.__done=0;
    }''', source)
    start = listener_count(cdp, 20)
    assert start == 0
    repeats = 30 if scenario == 'timeout-repeated' else 1
    peak = 0
    for _ in range(repeats):
        page.evaluate('() => {globalThis.__pending=__wait().then(()=>{__done++});}')
        if scenario != 'timeout-repeated':
            peak = listener_count(cdp, 20)
        if scenario == 'load':
            page.evaluate("() => __assets.forEach(el=>el.dispatchEvent(new Event('load')))")
        elif scenario == 'error':
            page.evaluate("() => __assets.forEach(el=>el.dispatchEvent(new Event('error')))")
        elif scenario == 'overlap':
            page.evaluate('() => {globalThis.__second=__wait().then(()=>{__done++});}')
            peak = listener_count(cdp, 20)
            page.clock.run_for(2500)
            page.evaluate('() => __second')
        else:
            page.clock.run_for(2499)
            assert page.evaluate('__done') == _
            page.clock.run_for(1)
        page.evaluate('() => __pending')
    retained = listener_count(cdp, 20)
    expected = 0 if mode == 'current' else (1200 if scenario == 'timeout-repeated' else 80 if scenario == 'overlap' else 20)
    assert retained == expected, (mode,scenario,retained,expected)
    assert page.evaluate('__assets.slice(12).every(el=>el.getAttribute("loading")==="eager")')
    assert page.evaluate('__done') == (2 if scenario == 'overlap' else repeats)
    assert not errors, errors
    result={'mode':mode,'scenario':scenario,'repeats':repeats,'assets':20,'initialListeners':start,
      'peakListenersBeforeEvent':peak if scenario!='timeout-repeated' else None,
      'retainedListeners':retained,'completedWaits':page.evaluate('__done'),'passed':True,'pageErrors':errors}
    cdp.detach()
    page.context.close()
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium',default=shutil.which('chromium') or shutil.which('chromium-browser'))
    parser.add_argument('--output')
    args=parser.parse_args()
    if not args.chromium:
        parser.error('Provide --chromium or install a Chromium executable in PATH')
    fixture=json.loads((ROOT/'tests/fixtures/render-draft-asset-resource-baseline.json').read_text())
    source=(ROOT/'public/app.js').read_bytes().decode('utf-8')
    match=re.search(r'^async function waitForPdfExportAssets\([\s\S]*?^}',source,re.M)
    if not match: raise RuntimeError('Asset wait function was not found')
    original=fixture['functions']['waitForPdfExportAssets']
    assert hashlib.sha256(original['source'].encode()).hexdigest()==original['sha256']
    results=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=args.chromium)
        version=browser.version
        for mode,fn in [('baseline',original['source']),('current',match[0])]:
            for scenario in ['timeout-repeated','load','error','overlap']:
                results.append(run_case(browser,fn,mode,scenario))
        browser.close()
    report={'browser':version,'scope':'Offline DOM component tests; real event listeners via Chrome DevTools Protocol. Controlled incomplete-image property, synthetic load/error events, Playwright virtual clock. Not full app/backend E2E or real image/font/PDF-layout coverage.',
      'inputArchiveSha256':fixture['inputArchiveSha256'],'passed':len(results),'failed':0,'results':results}
    content=json.dumps(report,indent=2)+'\n'
    if args.output:Path(args.output).write_text(content)
    print(content)

if __name__=='__main__':main()
