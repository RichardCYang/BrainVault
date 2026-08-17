import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  highlightCode,
  highlightResourceLimits as serverHighlightResourceLimits
} from "../src/lib/code-highlighting.ts";
import {
  highlightCodeForBrowser,
  highlightLuaSource,
  hydrateHighlightedCodeBlocks,
  highlightResourceLimits as browserHighlightResourceLimits
} from "../public/code-highlighting.js";

test("adversarial C input bypasses the synchronous grammar above the safe ceiling", () => {
  const payload = "a ".repeat(10_000);
  const startedAt = performance.now();
  const result = highlightCode(payload, "c");
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.source, payload);
  assert.equal(result.html, payload);
  assert.ok(elapsedMs < 200, `long C fallback took ${elapsedMs.toFixed(1)}ms`);
});

test("the long-code fallback still HTML-escapes the complete source", () => {
  const payload = `<script>${"&".repeat(serverHighlightResourceLimits.maxSourceLength)}</script>`;
  const result = highlightCode(payload, "cpp");

  assert.equal(result.source, payload);
  assert.ok(!result.html.includes("<script>"));
  assert.ok(result.html.startsWith("&lt;script&gt;"));
  assert.ok(result.html.endsWith("&lt;/script&gt;"));
});

test("server and browser highlighting limits remain aligned and bounded", () => {
  assert.equal(serverHighlightResourceLimits.maxSourceLength, 2_000);
  assert.equal(browserHighlightResourceLimits.maxSourceLength, serverHighlightResourceLimits.maxSourceLength);
  assert.ok(browserHighlightResourceLimits.maxHydrationSourceLength <= 8_000);
  assert.ok(browserHighlightResourceLimits.maxHydratedBlocks <= 20);
});


test("long Lua blocks keep syntax highlighting without invoking the generic grammar runtime", () => {
  const payload = ("-- generated Lua\nlocal value = 42\nif value > 0 then print(\"<ok>\") end\n").repeat(60);
  assert.ok(payload.length > serverHighlightResourceLimits.maxSourceLength);
  assert.ok(payload.length <= browserHighlightResourceLimits.maxLuaSourceLength);

  const previousHighlighter = globalThis.hljs;
  globalThis.hljs = {
    getLanguage() {
      throw new Error("Lua fallback must not consult Highlight.js");
    },
    highlight() {
      throw new Error("Lua fallback must not execute Highlight.js");
    }
  };
  try {
    const html = highlightCodeForBrowser(payload, "lua");
    assert.match(html, /hljs-comment/);
    assert.match(html, /hljs-keyword/);
    assert.match(html, /hljs-number/);
    assert.match(html, /hljs-built_in/);
    assert.match(html, /&lt;ok&gt;/);
    assert.ok(!html.includes("<ok>"));
  } finally {
    if (previousHighlighter === undefined) delete globalThis.hljs;
    else globalThis.hljs = previousHighlighter;
  }
});


test("read-only hydration highlights a full-size Lua block beyond the generic 8k budget", () => {
  const payload = ("local value = 42 -- hydrated\n").repeat(500);
  assert.ok(payload.length > browserHighlightResourceLimits.maxHydrationSourceLength);
  assert.ok(payload.length <= browserHighlightResourceLimits.maxLuaSourceLength);

  const classNames = new Set(["language-lua"]);
  const code = {
    textContent: payload,
    innerHTML: "",
    classList: {
      [Symbol.iterator]() {
        return classNames[Symbol.iterator]();
      },
      add(...names) {
        for (const name of names) classNames.add(name);
      }
    }
  };
  const root = {
    querySelectorAll(selector) {
      if (selector.startsWith("pre > code")) return [code];
      return [];
    }
  };

  hydrateHighlightedCodeBlocks(root);

  assert.ok(classNames.has("hljs"));
  assert.ok(classNames.has("language-lua"));
  assert.match(code.innerHTML, /hljs-keyword/);
  assert.match(code.innerHTML, /hljs-number/);
  assert.match(code.innerHTML, /hljs-comment/);
});

test("Lua lexer handles long bracket strings/comments and remains bounded to editor content", () => {
  const source = `--[=[ comment <tag> ]=]\nlocal text = [==[hello <world>]==]\nreturn true`;
  const html = highlightLuaSource(source);

  assert.match(html, /hljs-comment/);
  assert.match(html, /hljs-string/);
  assert.match(html, /hljs-literal/);
  assert.ok(html.includes("&lt;tag&gt;"));
  assert.ok(html.includes("&lt;world&gt;"));
  assert.equal(highlightLuaSource("x".repeat(browserHighlightResourceLimits.maxLuaSourceLength + 1)), null);
});
