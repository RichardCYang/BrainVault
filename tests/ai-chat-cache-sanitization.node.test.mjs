import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("AI chat persisted caches retain pagination controls only through the AI_CHAT sanitizer policy", async () => {
  const markdown = await readSource("src/lib/markdown.ts");

  assert.match(
    markdown,
    /const aiChatSanitizeOptions:[\s\S]*allowedTags:\s*\[\.\.\.allowedTags,\s*"button",\s*"nav"\]/
  );
  assert.match(
    markdown,
    /export function sanitizeRenderedBlockHtml\(type: BlockType, value: unknown\)[\s\S]*type === "AI_CHAT" \? aiChatSanitizeOptions : sanitizeOptions/
  );

  const genericSanitizerStart = markdown.indexOf("const sanitizeOptions:");
  const aiSanitizerStart = markdown.indexOf("const aiChatSanitizeOptions:");
  assert.ok(genericSanitizerStart >= 0 && aiSanitizerStart > genericSanitizerStart);
  const genericPolicy = markdown.slice(genericSanitizerStart, aiSanitizerStart);
  assert.doesNotMatch(genericPolicy, /allowedTags:[^\n]*"button"/);
  assert.doesNotMatch(genericPolicy, /allowedTags:[^\n]*"nav"/);
});

test("both persisted html_cache read boundaries select the sanitizer by block type", async () => {
  const [mappers, pageRoutes] = await Promise.all([
    readSource("src/lib/mappers.ts"),
    readSource("src/routes/page.routes.ts")
  ]);

  assert.match(
    mappers,
    /sanitizeRenderedBlockHtml\(row\.type, row\.html_cache\)/
  );
  assert.match(
    pageRoutes,
    /sanitizeRenderedBlockHtml\(block\.type, block\.html_cache\)/
  );

  assert.doesNotMatch(mappers, /sanitizeRenderedHtml\(row\.html_cache\)/);
  assert.doesNotMatch(pageRoutes, /sanitizeRenderedHtml\(block\.html_cache\)/);

  // AI_CHAT caches are renderer-version-sensitive because reference-style citations are
  // normalized before client-side favicon/domain hydration. Existing rows must therefore
  // be regenerated from canonical metadata rather than trusting a legacy derived cache.
  assert.match(mappers, /row\.type === "AI_CHAT" \|\| row\.html_cache === null/);
  assert.match(pageRoutes, /block\.type === "CALLOUT" \|\| block\.type === "AI_CHAT" \|\| block\.html_cache === null/);
});


test("client pagination hydration depends on the controls preserved by the read-boundary sanitizer", async () => {
  const [client, aiChatBlock] = await Promise.all([
    readSource("public/app.js"),
    readSource("public/ai-chat-block.js")
  ]);

  assert.match(
    client,
    /button\.rendered-ai-chat-page[\s\S]*dataset\.aiChatPage[\s\S]*setRenderedAiChatPage\(chat, page\)/
  );
  assert.match(
    aiChatBlock,
    /querySelector\("\.rendered-ai-chat-pagination"\)[\s\S]*querySelectorAll\("\.rendered-ai-chat-page"\)/
  );
});
