import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  highlightCode,
  highlightResourceLimits as serverHighlightResourceLimits
} from "../src/lib/code-highlighting.ts";
import { highlightResourceLimits as browserHighlightResourceLimits } from "../public/code-highlighting.js";

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
