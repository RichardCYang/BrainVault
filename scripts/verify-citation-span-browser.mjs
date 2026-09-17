// Real Chromium DOM/ESM regression checks; no npm package dependencies.
// Usage: CHROMIUM_PATH=/path/to/chromium node --experimental-strip-types scripts/verify-citation-span-browser.mjs [--output file.json]
// Chromium's sandbox stays enabled unless --no-sandbox is explicitly supplied
// (only needed in a suitably isolated/root-owned test container).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { aiModuleSource, appSources, baseline } from '../tests/helpers/citation-span-resource-harness.mjs';

async function browserChecks(modules) {
  const old = await import(modules.baseline);
  const fixed = await import(modules.current);
  const { renderServerBlockHtml } = await import(modules.sanitizer);
  const checks = [];
  function ok(value, name) { if (!value) throw new Error(name); checks.push(name); }
  function same(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name); }
  function snap(node) {
    if (node.nodeType === 3) return ['text', node.nodeValue];
    if (node.nodeType !== 1) return [node.nodeType, node.nodeValue];
    return [node.tagName, [...node.attributes].map(a => [a.name, a.value]).sort(),
      node.aiChatCitationSources ?? null, [...node.childNodes].map(snap)];
  }
  const p = html => { const node = document.createElement('p'); node.innerHTML = html; return node; };
  const a = (n, extra = '') => `<a href="https://example.invalid/s${n}" ${extra}>[${n}]</a>`;
  const fixtures = [
    '', 'plain', '한글😀é', 'x'.repeat(50_000), 'x'.repeat(500_000),
    `본문 (${a(1)})!`, `본문 (${a(1)}, ${a(2)})!`, `${a(1)} and ${a(2)} tail`,
    `😀<em>(</em>${a(1)}<strong>, ${a(2)}</strong><span>)</span>!`,
    `문장 (${a(1)}) 다음`, `문장 (${a(1)}<code>,</code>${a(2)})`,
    `문장 (${a(1)}<!--comment-->, ${a(2)})`,
    'literal (\ufffc)!', '😀<em>(\ufffc</em><strong>, \ufffc)</strong>!',
    `문장 (${a(1)}<button class="rendered-ai-chat-link-preview">2</button>)`,
    `문장 (${a(1, 'data-ai-chat-source-definition="true"')}, ${a(2)})`,
    `문장 (${a(1, 'class="rendered-ai-chat-citation-reference"')}, ${a(2)}) 다음`,
    '<span>(<a href="javascript:alert(1)">1</a>, <a href="data:text/html,test">2</a>)</span>',
    `${a(1)}<br>${a(2)}`, `${a(1)}<mark>${a(2)}</mark>`,
    `x (<span>${a(1)}, ${a(1)}</span>).`
  ];
  let seed = 0x348194;
  const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
  const pieces = ['text', '😀', ' ', '(', ')', ',', ';', '\ufffc', '\ufffd', a(1), a(2), a(3),
    a(2, 'data-ai-chat-source-definition="true"'), '<!--comment-->', '<br>',
    '<a href="javascript:alert(1)">1</a>', '<a href="mailto:test@example.invalid">2</a>'];
  for (let i = 0; i < 1000; i++) {
    let value = '';
    for (let j = 0, count = 2 + Math.floor(rand() * 14); j < count; j++) {
      let piece = pieces[Math.floor(rand() * pieces.length)];
      if (rand() < .45) { const tag = ['span', 'em', 'strong', 'sup', 'code', 'mark', 'del'][Math.floor(rand() * 7)]; piece = `<${tag}>${piece}</${tag}>`; }
      value += piece;
    }
    fixtures.push(value);
  }
  for (let i = 0; i < fixtures.length; i++) {
    for (const order of [['group', 'wrapper'], ['wrapper', 'group']]) {
      const left = p(fixtures[i]), right = p(fixtures[i]);
      for (let repeat = 0; repeat < 2; repeat++) {
        for (const op of order) { old[op](left); fixed[op](right); }
        same(snap(left), snap(right), `DOM differential ${i}/${order.join('+')}/${repeat}`);
      }
    }
  }

  // Full public hydration, including real buttons, preview fetch boundaries and
  // idempotence. Disable only the test page observer to await deterministic I/O.
  globalThis.IntersectionObserver = undefined;
  const htmlCases = [
    `<p>주장 (${a(1)}, ${a(2)}).</p>`,
    `<p>인용 [1], [2].</p><h2>Sources</h2><ol><li><a href="https://example.invalid/s1">First source</a></li><li><a href="https://example.invalid/s2">Second source</a></li></ol>`,
    `<p>일반 링크 <a href="https://example.invalid/manual">설명서</a> 다음 문장.</p>`,
    `<p>한글😀 (${a(1)}).</p><p>아래 문단.</p>`
  ];
  const hydrated = [];
  for (let i = 0; i < htmlCases.length; i++) {
    const results = [];
    for (const module of [old, fixed]) {
      const root = document.createElement('div');
      root.innerHTML = `<div class="rendered-ai-chat-answer"><div class="rendered-ai-chat-content">${htmlCases[i]}</div></div>`;
      document.body.append(root);
      const urls = [];
      const preview = async url => { urls.push(url); return { title: 'Safe title', url, favicon: '' }; };
      module.hydrateRenderedAiChatLinks(root, preview);
      await new Promise(resolve => setTimeout(resolve, 0));
      const first = snap(root);
      module.hydrateRenderedAiChatLinks(root, preview);
      await new Promise(resolve => setTimeout(resolve, 0));
      same(snap(root), first, `hydrate stable ${i}/${module === old ? 'baseline' : 'current'}`);
      ok(urls.every(url => url.startsWith('https://example.invalid/')), `preview boundary ${i}/${module === old ? 'baseline' : 'current'}`);
      results.push(snap(root));
      if (module === fixed && i === 0) hydrated.push(root); else root.remove();
    }
    same(results[0], results[1], `full public hydration differential ${i}`);
  }
  const citation = hydrated[0].querySelector('.rendered-ai-chat-link-preview');
  ok(citation?.tagName === 'BUTTON', 'grouped citation becomes button');
  same(citation.aiChatCitationSources.map(s => s.referenceNumber), ['1', '2'], 'source order preserved');
  citation.click();
  const popover = document.getElementById('rendered-ai-chat-citation-popover');
  ok(popover && !popover.hidden && citation.getAttribute('aria-expanded') === 'true', 'click opens citation popover');
  ok(popover.querySelector('a').href.endsWith('/s1'), 'first source navigation');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  ok(popover.querySelector('a').href.endsWith('/s2'), 'next source keyboard navigation');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  ok(popover.querySelector('a').href.endsWith('/s1'), 'previous source keyboard navigation');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok(popover.hidden && citation.getAttribute('aria-expanded') === 'false' && document.activeElement === citation, 'Escape closes and restores focus');
  hydrated.forEach(root => root.remove());

  globalThis.auditXss = 0;
  const target = document.createElement('div'); document.body.append(target);
  const dirty = `<div class="rendered-ai-chat-answer"><div class="rendered-ai-chat-content"><p>safe (<a href="https://unsafe-preview.invalid/s1" onclick="auditXss=1">1</a>, ${a(2)})</p><script>auditXss=1</script><iframe srcdoc="<script>parent.auditXss=1<\/script>"></iframe><img src="invalid" onerror="auditXss=1"><a href="javascript:auditXss=1">3</a><svg onload="auditXss=1"></svg></div></div>`;
  renderServerBlockHtml(target, dirty, { allowAiControls: true });
  let maliciousPreviewCalls = 0;
  fixed.hydrateRenderedAiChatLinks(target, async () => { maliciousPreviewCalls++; return { title: '<img onerror="auditXss=1">', favicon: 'javascript:auditXss=1' }; });
  await new Promise(resolve => setTimeout(resolve, 30));
  ok(!target.querySelector('script,iframe,svg'), 'sanitizer drops executable containers');
  ok([...target.querySelectorAll('*')].every(node => [...node.attributes].every(attr => !/^on/i.test(attr.name))), 'sanitizer strips event handlers');
  ok([...target.querySelectorAll('a[href]')].every(node => !/^(javascript|data):/i.test(node.getAttribute('href'))), 'sanitizer strips unsafe link protocols');
  ok(maliciousPreviewCalls > 0, 'unsafe preview fixture really fetched, not hidden by cache');
  target.querySelector('.rendered-ai-chat-link-preview')?.click();
  ok(!popover.querySelector('img[onerror],script,iframe,svg') && popover.textContent.includes('<img onerror='), 'preview title stays text rather than executable HTML');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok(globalThis.auditXss === 0, 'malicious HTML/preview does not execute');
  ok(target.textContent.includes('safe'), 'sanitizer preserves safe content');
  target.remove();

  const editorValue = { title: '보존😀', provider: 'gemini', model: 'test-model', layout: 'paginated', hideAnswerBorder: true,
    turns: [{ answeredAt: '2026-09-16T20:30', question: '질문?', answer: '답변😀' }, { answeredAt: '2026-09-16T20:31', question: '둘째', answer: '두 번째 답' }] };
  const editorStates = [];
  for (const module of [old, fixed]) {
    let dirty = 0;
    const row = document.createElement('div'); document.body.append(row);
    row.append(module.createAiChatEditor(row, editorValue, { onDirty: () => dirty++, htmlCache: '<p>cached-safe<script>auditXss=1</script></p>' }));
    same(module.extractAiChatData(row), module.normalizeAiChatData(editorValue), 'editor data roundtrip/' + (module === old ? 'baseline' : 'current'));
    const answer = row.querySelector('.ai-chat-answer-input'); answer.value = '편집한 답변😀'; answer.dispatchEvent(new Event('input', { bubbles: true }));
    row.querySelector('.ai-chat-add-turn').click();
    const edited = module.extractAiChatData(row);
    ok(edited.turns[0].answer === '편집한 답변😀' && edited.turns.length === 3 && dirty >= 2, 'editor edits and adds turn/' + (module === old ? 'baseline' : 'current'));
    ok(!row.querySelector('.ai-chat-rendered-preview script') && globalThis.auditXss === 0, 'editor cached HTML stays sanitized/' + (module === old ? 'baseline' : 'current'));
    editorStates.push(edited); row.remove();
  }
  same(editorStates[0], editorStates[1], 'baseline/current editor output identical');
  const pages = [];
  for (const module of [old, fixed]) {
    const chat = document.createElement('section'); chat.className = 'rendered-ai-chat--paginated';
    chat.innerHTML = '<div class="rendered-ai-chat-track"><div class="rendered-ai-chat-turn">first</div><div class="rendered-ai-chat-turn">second</div></div><nav class="rendered-ai-chat-pagination"><button class="rendered-ai-chat-page">1</button><button class="rendered-ai-chat-page">2</button></nav>';
    module.hydrateRenderedAiChatPagination(chat);
    ok(module.setRenderedAiChatPage(chat, 1) && chat.querySelectorAll('.rendered-ai-chat-turn')[1].getAttribute('aria-hidden') === 'false', 'read pagination second page/' + (module === old ? 'baseline' : 'current'));
    const beforeInvalid = snap(chat);
    ok(module.setRenderedAiChatPage(chat, 'invalid') === false, 'invalid page rejected/' + (module === old ? 'baseline' : 'current'));
    same(snap(chat), beforeInvalid, 'invalid page does not mutate DOM/' + (module === old ? 'baseline' : 'current'));
    module.setRenderedAiChatPage(chat, 999); pages.push(snap(chat));
  }
  same(pages[0], pages[1], 'baseline/current pagination and clamping identical');

  // Exercise the actual changed allocation path with native DOM nodes.
  const longHtml = '한글 abc 😀 '.repeat(4400) + ` [${a(1)}, ${a(2)}]`;
  const beforeNode = p(longHtml), afterNode = p(longHtml);
  const beforeText = afterNode.firstChild, beforeTextValue = beforeText.nodeValue;
  const beforeUnits = [], afterUnits = [];
  old.collect(beforeNode, beforeUnits); fixed.collect(afterNode, afterUnits);
  ok(beforeUnits.length >= 44_000 && afterUnits.length <= 16, 'long prose tokens bounded in native DOM');
  old.group(beforeNode); fixed.group(afterNode);
  same(snap(beforeNode), snap(afterNode), 'long prose citation DOM identical');
  ok(afterNode.firstChild === beforeText && beforeText.nodeValue === beforeTextValue.replace(/\[$/, ''), 'long prose text node identity and content preserved');
  const originalSignature = await import(modules.baselineSignature);
  const currentSignature = await import(modules.currentSignature);
  const blocks = Array.from({length: 5000}, (_, i) => ({id:`id-${i}`, type:'MARKDOWN', markdown:`한글😀${i}`, children:[], metadata:{n:i}}));
  same(currentSignature.signature(blocks), originalSignature.signature(blocks), '5000-block signature byte-identical in Chromium');
  blocks[49].children.push({id:'child', type:'TODO', markdown:'중첩', checked:true});
  same(currentSignature.signature(blocks), originalSignature.signature(blocks), 'nested edited signature byte-identical in Chromium');
  const timings = [];
  const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
  for (const operation of ['group', 'wrapper']) {
    const fixture = () => p(operation === 'group' ? longHtml : 'x'.repeat(44_000) + ` (${a(1)})`);
    for (let i = 0; i < 10; i++) { old[operation](fixture()); fixed[operation](fixture()); }
    const samples = {baseline:[], current:[]}, iterations = 20;
    for (let sample = 0; sample < 7; sample++) {
      for (const [mode, module] of sample % 2 ? [['current', fixed], ['baseline', old]] : [['baseline', old], ['current', fixed]]) {
        const nodes = Array.from({length:iterations}, fixture);
        const before = performance.now();
        for (const node of nodes) module[operation](node);
        samples[mode].push((performance.now() - before) / iterations);
      }
    }
    timings.push({operation, iterationsPerSample:iterations, samples, baselineMedianMs:median(samples.baseline), currentMedianMs:median(samples.current)});
  }
  return { passed: checks.length, failed: 0, deterministicDomFixtures: fixtures.length, hydrationCases: htmlCases.length,
    allocationCounts:{baseline:beforeUnits.length, current:afterUnits.length}, checks, timings, userAgent: navigator.userAgent,
    scope: 'Native Chromium DOM, production ESM embedded as offline data URLs; AI hydration, editor, pagination, sanitizer, and complete extracted signature functions. No authenticated full-app or database E2E. Seven alternating timing samples, twenty calls per sample, fixtures/parsing outside timing; timings are local component observations, not total app CPU/RAM.' };
}

const root = fileURLToPath(new URL('../', import.meta.url));
// Embed the native ES modules in data URLs so the browser requires no web
// server or network permissions. The source is unchanged except import URLs
// and exports of the two private functions under test.
const moduleUrls = new Map();
async function embedSource(source, file) {
  const pattern = /(from\s+["'])(\.\.?\/[^"']+)(["'])/g;
  const matches = [...source.matchAll(pattern)];
  for (const match of matches.reverse()) {
    const path = new URL(match[2], pathToFileURL(file));
    const url = await embedFile(fileURLToPath(path));
    source = source.slice(0, match.index) + match[1] + url + match[3] + source.slice(match.index + match[0].length);
  }
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}
async function embedFile(file) {
  if (!moduleUrls.has(file)) moduleUrls.set(file, embedSource(await readFile(file, 'utf8'), file));
  return moduleUrls.get(file);
}
const modules = {};
for (const mode of ['baseline', 'current']) {
  // Revert fixture import URLs to source-relative paths before recursively
  // embedding the actual, shared production dependency graph.
  const source = aiModuleSource(mode, { browser: true }).replace(/(from\s+["'])\/public\//g, '$1./');
  modules[mode] = await embedSource(source, join(root, 'public', 'ai-chat-block.js'));
}
for (const mode of ['baseline', 'current']) {
  const source = Object.values(appSources(mode)).join('\n') + '\nexport { getCollaborationBlockSignature as signature };';
  modules[mode + 'Signature'] = await embedSource(source, join(root, 'public', 'app.js'));
}
modules.sanitizer = await embedFile(join(root, 'public', 'rendered-html-sanitizer.js'));
let browser, socket, profile, watchdog;
try {
  profile = await mkdtemp(join(tmpdir(), 'brainvault-citation-audit-'));
  const args = ['--headless=new', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
  if (process.argv.includes('--no-sandbox')) args.unshift('--no-sandbox');
  browser = spawn(process.env.CHROMIUM_PATH || 'chromium', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  watchdog = setTimeout(() => { console.error('Browser audit timed out'); browser.kill('SIGKILL'); }, 120_000);
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    browser.stderr.on('data', data => { output += data; const match = output.match(/DevTools listening on (ws:\/\/\S+)/); if (match) resolve(match[1]); });
    browser.once('error', reject); browser.once('exit', code => reject(new Error(`Chromium exited (${code}): ${output.slice(-2500)}`)));
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0; const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 90_000);
    pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const version = await call('Browser.getVersion');
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Page.enable', {}, sessionId);
  await call('Page.setDocumentContent', { frameId: (await call('Page.getFrameTree', {}, sessionId)).frameTree.frame.id, html: '<!doctype html><meta charset="utf-8"><title>Offline citation audit</title><body></body>' }, sessionId);
  const evaluated = await call('Runtime.evaluate', { expression: `(${browserChecks.toString()})(${JSON.stringify(modules)})`, awaitPromise: true, returnByValue: true }, sessionId);
  assert.ok(!evaluated.exceptionDetails, evaluated.exceptionDetails?.exception?.description || JSON.stringify(evaluated.exceptionDetails));
  const result = { inputArchiveSha256: baseline.inputArchiveSha256, browser: version, ...evaluated.result.value };
  const index = process.argv.indexOf('--output');
  if (index >= 0) { assert.ok(process.argv[index + 1], '--output requires a filename'); await writeFile(process.argv[index + 1], JSON.stringify(result, null, 2) + '\n'); }
  console.log(JSON.stringify({ ...result, checks: `${result.checks.length} assertions; see output JSON for names` }, null, 2));
} finally {
  clearTimeout(watchdog); socket?.close();
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await new Promise(resolve => { browser.once('exit', resolve); setTimeout(resolve, 2500).unref(); }); }
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
