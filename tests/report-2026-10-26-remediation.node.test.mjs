import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeTrustedProxyAddressRule, createExpressTrustProxySetting, isTrustedProxyRemoteAddress, getClientIpAddressFromTrustedProxyRequest } from '../src/lib/reverse-proxy.ts';
import { isAiChatWithinRenderBudget } from '../src/lib/ai-chat-render-budget.ts';
import { AI_CHAT_HTML_CACHE_MAX_CHARS, AI_CHAT_RENDERER_VERSION, isCurrentAiChatHtmlCache } from '../src/lib/ai-chat-cache.ts';
import { isWithinRequestValidationBudget } from '../src/lib/request-validation-budget.ts';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('BV-PT-02: malicious mapped IPv6 prefixes fail closed, even in alternate spelling', () => {
  for (const rule of ['::ffff:10.0.0.0/8', '::ffff:10.0.0.0/0', '0:0:0:0:0:ffff:0a00:0000/8', '::ffff:0a00:0/96']) {
    assert.throws(() => normalizeTrustedProxyAddressRule(rule), /unsafe IPv4-mapped IPv6 CIDR/);
    assert.throws(() => createExpressTrustProxySetting(0, [rule]), /unsafe IPv4-mapped IPv6 CIDR/);
  }
});

test('BV-PT-02: valid mapped IPv6 CIDR is normalized consistently for Express and HTTPS/WebSockets', () => {
  const canonical = '10.0.0.0/8';
  assert.equal(normalizeTrustedProxyAddressRule('::ffff:10.0.0.0/104'), canonical);
  assert.equal(normalizeTrustedProxyAddressRule('0:0:0:0:0:ffff:0a00:0000/104'), canonical);
  assert.deepEqual(createExpressTrustProxySetting(0, ['::ffff:10.0.0.0/104']), [canonical]);
  assert.equal(isTrustedProxyRemoteAddress('::ffff:10.20.30.40', [canonical]), true);
  assert.equal(isTrustedProxyRemoteAddress('127.0.0.1', [canonical]), false);
  const forged = { headers: { 'x-forwarded-for': '203.0.113.7' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(getClientIpAddressFromTrustedProxyRequest(forged, [canonical]), '127.0.0.1');
  assert.match(read('src/config/env.ts'), /normalizeTrustedProxyAddressRule\(address\)/);
});

test('BV-PT-01: 10- and 50-turn compressed DoS equivalents never reach synchronous Markdown', () => {
  const answer = 'a@b.co\n'.repeat(7142).slice(0, 49_994);
  const build = (count) => ({ turns: Array.from({ length: count }, () => ({ question: 'Q', answer })) });
  for (const turns of [10, 50]) {
    const input = build(turns);
    const start = performance.now();
    assert.equal(isAiChatWithinRenderBudget(input), false);
    assert.ok(performance.now() - start < 500, 'validation must be a cheap length check');
  }
  assert.equal(isAiChatWithinRenderBudget({turns: [{question: 'what?', answer: 'Safe **Markdown**'}]}), true);
  assert.equal(isAiChatWithinRenderBudget({turns: [{question: 'what?', answer: 'z'.repeat(16_001)}]}), false);
  assert.equal(isAiChatWithinRenderBudget({turns: Array.from({length: 7}, () => ({question:'q',answer:'x'.repeat(15_000)}))}), false);
  const markdown = read('src/lib/markdown.ts');
  assert.ok(markdown.indexOf('if (!isAiChatWithinRenderBudget(data))') < markdown.indexOf('const turns = data.turns.map('));
  assert.match(markdown, /The complete questions and answers remain saved/);
});

test('BV-PT-01: current, bounded HTML cache is reusable; legacy and oversized caches regenerate', () => {
  const valid = `<section data-ai-chat-renderer-version="${AI_CHAT_RENDERER_VERSION}" class="rendered-ai-chat">Example</section>`;
  assert.equal(isCurrentAiChatHtmlCache(valid), true);
  assert.equal(isCurrentAiChatHtmlCache('<section class="rendered-ai-chat">legacy</section>'), false);
  assert.equal(isCurrentAiChatHtmlCache(valid.replace(AI_CHAT_RENDERER_VERSION, 'legacy')), false);
  assert.equal(isCurrentAiChatHtmlCache(valid + 'x'.repeat(AI_CHAT_HTML_CACHE_MAX_CHARS)), false);
  assert.match(read('src/routes/page.routes.ts'), /!isCurrentAiChatHtmlCache\(block\.html_cache\)/);
  assert.match(read('src/lib/mappers.ts'), /!isCurrentAiChatHtmlCache\(row\.html_cache\)/);
  assert.match(read('src/lib/markdown.ts'), /data-ai-chat-renderer-version=/);
});

test('BV-PT-03: share timestamp is distinct from user updated_at in SQL and JSON mapping', () => {
  const source = read('src/routes/collection-sharing.routes.ts');
  const sql = source.match(/async function getCollectionShareRows[\s\S]+?`SELECT ([\s\S]+?)FROM collection_shares cs/);
  assert.ok(sql, 'share rows SQL query is present');
  const labels = sql[1].split(',').map((part) => part.trim()).filter(Boolean).map((expression) => expression.match(/\bAS (\w+)$/i)?.[1] ?? expression.split('.').at(-1));
  assert.equal(new Set(labels).size, labels.length, `duplicate SQL labels: ${labels.join(', ')}`);
  assert.ok(labels.includes('updated_at') && labels.includes('share_updated_at'));
  assert.match(source, /updatedAt: row\.share_updated_at/);
  assert.match(source, /user: toPublicUser\(row\)/);
  // Calls to this shared query remain in list, create, PATCH and DELETE flows.
  assert.ok((source.match(/getCollectionShareRows\(collectionId, client\)/g) ?? []).length >= 4);
});

test('BV-PT-04: Zod 3 unbounded array error accumulation is blocked before schema.parse', () => {
  assert.equal(isWithinRequestValidationBudget({turns:[{text:'normal'}]}), true);
  assert.equal(isWithinRequestValidationBudget({items:Array.from({length:10001},()=>0)}), false);
  assert.equal(isWithinRequestValidationBudget({items:Array.from({length:4000},()=>({text:'x'}))}), true);
  assert.equal(isWithinRequestValidationBudget({items:Array.from({length:9000},()=>({text:'x'.repeat(10)}))}), true);
  const source = read('src/middleware/validate.ts');
  assert.ok(source.indexOf('isWithinRequestValidationBudget(req.body)') < source.indexOf('schemas.body.parse(req.body)'));
});

test('BV-PT-04: package and lockfile pin known patched versions', () => {
  const p = JSON.parse(read('package.json'));
  const l = JSON.parse(read('package-lock.json'));
  assert.deepEqual(l.packages[''].dependencies, p.dependencies);
  const requirements = { 'markdown-it': '14.3.3', 'proxy-addr': '2.0.8', 'body-parser': '2.4.0', 'mariadb':'3.5.4', 'multer':'2.5.0', 'sanitize-html':'2.18.1', 'morgan':'1.12.1', 'ip-address':'10.7.5', 'source-map-js':'1.2.2' };
  for (const [name,version] of Object.entries(requirements)) {
    assert.equal(l.packages[`node_modules/${name}`]?.version, version);
  }
});
