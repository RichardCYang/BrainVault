import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../src/lib/bookmark.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("policy-blocked bookmark fallbacks are structurally unverified and media-free", () => {
  const fallbackStart = server.indexOf("export function createFallbackBookmarkPreview(");
  const fallbackEnd = server.indexOf("\nexport async function fetchBookmarkPreviewWithFallback", fallbackStart);
  assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart);
  const fallback = server.slice(fallbackStart, fallbackEnd);
  assert.match(fallback, /verified:\s*false/);
  assert.match(fallback, /previewToken:\s*""/);
  assert.match(server, /const verified = item\.verified === true && hasValidBookmarkPreviewToken/);
  assert.match(server, /imageUrl:\s*verified \? imageUrl : ""/);
  assert.match(server, /faviconUrl:\s*verified \? faviconUrl : ""/);
  assert.match(server, /previewToken:\s*verified \? previewToken : ""/);
});

test("browser normalization cannot recreate remote media for an unverified fallback", () => {
  assert.match(client, /const verified = rawItem\.verified === true && hasPreviewToken/);
  assert.match(client, /imageUrl:\s*verified \? normalizeBookmarkUrl\(rawItem\.imageUrl, url\) : ""/);
  assert.match(client, /faviconUrl:\s*verified[\s\S]*:\s*""/);
  assert.match(client, /previewToken:\s*verified \? previewToken : ""/);
});
