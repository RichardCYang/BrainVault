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
  assert.match(server, /const verified = item\.verified !== false/);
  assert.match(server, /imageUrl:\s*verified \? normalizeBookmarkUrl\(item\.imageUrl, url\) : ""/);
  assert.match(server, /faviconUrl:\s*verified[\s\S]*:\s*""/);
});

test("browser normalization cannot recreate remote media for an unverified fallback", () => {
  assert.match(client, /const verified = rawItem\.verified !== false/);
  assert.match(client, /imageUrl:\s*verified \? normalizeBookmarkUrl\(rawItem\.imageUrl, url\) : ""/);
  assert.match(client, /faviconUrl:\s*verified[\s\S]*:\s*""/);
});
