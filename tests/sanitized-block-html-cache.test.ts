import sanitizeHtml from "sanitize-html";
import { describe, expect, it } from "vitest";
import type { BlockType } from "../src/types/domain.js";
import {
  getSanitizedBlockHtmlCacheStats,
  renderBlockHtml,
  sanitizeRenderedBlockHtml
} from "../src/lib/markdown.js";

// A fresh module copy has an empty cache, so it gives the uncached answer for
// any input. Each comparison below checks the cached path against it.
async function loadUncachedSanitizer() {
  const { vi } = await import("vitest");
  vi.resetModules();
  const module = await import("../src/lib/markdown.js");
  return module.sanitizeRenderedBlockHtml;
}

const hostileInputs = [
  '<p>ok</p><script>alert(1)</script>',
  '<img src="javascript:alert(1)" onerror="alert(1)">',
  '<img src="/api/users/me" alt="x">',
  '<img src="/upload/a.png" srcset="/api/x 1x">',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="https://example.com" target="_self">x</a>',
  '<iframe src="https://evil.example/embed/x"></iframe>',
  '<iframe src="https://www.youtube-nocookie.com/embed/abc" class="youtube-video-iframe"></iframe>',
  '<div class="account-settings rendered-callout">x</div>',
  '<span style="color:#fff;position:fixed">x</span>',
  '<input type="text" value="x"><input type="checkbox" checked>',
  '<svg><script>alert(1)</script></svg>',
  '<section class="rendered-ai-chat" data-ai-chat-renderer-version="9"><nav class="x" aria-label="p"><button type="button" data-ai-chat-page="2">2</button></nav></section>',
  '<button onclick="steal()">b</button>',
  "",
  "plain text & <b>bold</b>"
];

const blockTypes: BlockType[] = ["MARKDOWN", "AI_CHAT", "CODE", "TODO"];

describe("sanitized block HTML cache", () => {
  it("returns exactly what an uncached sanitize returns, for every policy", async () => {
    const uncached = await loadUncachedSanitizer();
    for (const type of blockTypes) {
      for (const html of hostileInputs) {
        const expected = uncached(type, html);
        // First call fills the cache, the second is served from it.
        expect(sanitizeRenderedBlockHtml(type, html)).toBe(expected);
        expect(sanitizeRenderedBlockHtml(type, html)).toBe(expected);
      }
    }
  });

  it("keeps the AI_CHAT pagination allowance out of the generic policy for the same input", () => {
    const html = hostileInputs[12];
    const aiChat = sanitizeRenderedBlockHtml("AI_CHAT", html);
    const generic = sanitizeRenderedBlockHtml("MARKDOWN", html);
    expect(aiChat).toContain("<button");
    expect(aiChat).toContain('data-ai-chat-page="2"');
    expect(generic).not.toContain("<button");
    expect(generic).not.toContain("data-ai-chat-page");
    // Reverse order with a fresh input, so neither result can come from the other.
    const fresh = `${html}<p>order</p>`;
    expect(sanitizeRenderedBlockHtml("MARKDOWN", fresh)).not.toContain("<button");
    expect(sanitizeRenderedBlockHtml("AI_CHAT", fresh)).toContain("<button");
  });

  it("treats non-string html_cache values as empty, like before", () => {
    for (const value of [null, undefined, 42, { html: "<p>x</p>" }, ["<p>x</p>"]]) {
      expect(sanitizeRenderedBlockHtml("MARKDOWN", value)).toBe("");
    }
  });

  it("matches renderer output for rendered blocks", () => {
    const samples: Array<[BlockType, string]> = [
      ["MARKDOWN", "Hello **world** [link](https://example.com) `code`"],
      ["HEADING_2", "## Title"],
      ["TODO", "- [x] done"],
      ["CODE", "```js\nconst x = 1;\n```"],
      ["QUOTE", "> quote"]
    ];
    for (const [type, markdown] of samples) {
      const rendered = renderBlockHtml(type, markdown);
      const once = sanitizeRenderedBlockHtml(type, rendered);
      expect(sanitizeRenderedBlockHtml(type, rendered)).toBe(once);
      // The stored cache is already sanitized, so sanitizing again keeps it stable.
      expect(sanitizeRenderedBlockHtml(type, once)).toBe(once);
    }
  });

  it("stays within its entry and size bounds and skips oversized inputs", async () => {
    const before = getSanitizedBlockHtmlCacheStats();
    for (let index = 0; index < before.maxEntries + 500; index += 1) {
      sanitizeRenderedBlockHtml("MARKDOWN", `<p>entry ${index}</p>`);
    }
    const filled = getSanitizedBlockHtmlCacheStats();
    expect(filled.entries).toBeLessThanOrEqual(filled.maxEntries);
    expect(filled.chars).toBeLessThanOrEqual(filled.maxChars);

    const oversized = `<p>${"x".repeat(filled.maxInputLength)}</p><script>bad()</script>`;
    const result = sanitizeRenderedBlockHtml("MARKDOWN", oversized);
    expect(result).not.toContain("<script");
    expect(result).toBe(sanitizeHtml(oversized, { allowedTags: ["p"], allowedAttributes: {} }));
    expect(getSanitizedBlockHtmlCacheStats().entries).toBe(filled.entries);
  });

  it("evicts least recently used entries first", () => {
    const { maxEntries } = getSanitizedBlockHtmlCacheStats();
    const kept = "<p>kept by reuse</p>";
    sanitizeRenderedBlockHtml("MARKDOWN", kept);
    const charsWithKept = getSanitizedBlockHtmlCacheStats().chars;
    for (let index = 0; index < maxEntries * 2; index += 1) {
      sanitizeRenderedBlockHtml("MARKDOWN", `<p>churn ${index}</p>`);
      // Touch the kept entry so it never becomes the oldest.
      if (index % 100 === 0) sanitizeRenderedBlockHtml("MARKDOWN", kept);
    }
    const stats = getSanitizedBlockHtmlCacheStats();
    expect(stats.entries).toBe(maxEntries);
    expect(charsWithKept).toBeGreaterThan(0);
    expect(sanitizeRenderedBlockHtml("MARKDOWN", kept)).toBe("<p>kept by reuse</p>");
    // A hit changes nothing. A miss would insert the kept entry and evict a
    // churn entry of a different length, which changes the character count.
    expect(getSanitizedBlockHtmlCacheStats()).toEqual(stats);

    const evicted = "<p>churn 0</p>";
    sanitizeRenderedBlockHtml("MARKDOWN", evicted);
    expect(getSanitizedBlockHtmlCacheStats().entries).toBe(maxEntries);
  });
});
