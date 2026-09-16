import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const appSource = read("public/app.js");
const sanitizerSource = read("public/rendered-html-sanitizer.js");
const bookmarkSource = read("src/lib/bookmark.ts");
const markdownSource = read("src/lib/markdown.ts");
const networkSource = read("src/lib/network-address.ts");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing source range: ${startMarker}`);
  return source.slice(start, end);
}

test("BV-37 bookmark image rendering rejects application API paths by default", () => {
  const policySource = sliceBetween(
    appSource,
    "function decodedApplicationPathForPolicy",
    "function getCustomImageSource"
  );
  const context = {
    URL,
    window: { location: new URL("https://brainvault.example/workspace/page") }
  };
  vm.createContext(context);
  vm.runInContext(`${policySource}\nglobalThis.imageSource = getRenderableImageSource;`, context);

  assert.equal(context.imageSource("/assets/logo.png", { allowData: false }), "https://brainvault.example/assets/logo.png");
  assert.equal(context.imageSource("/api/data/export", { allowData: false }), null);
  assert.equal(context.imageSource("/ap\ti/data/export", { allowData: false }), null);
  assert.equal(context.imageSource("/%61pi/data/export", { allowData: false }), null);
  assert.equal(context.imageSource("/safe/../api/data/export", { allowData: false }), null);
  assert.equal(
    context.imageSource("/api/pages/page-1/cover?v=1", {
      allowData: false,
      allowedApplicationApiPath: "/api/pages/page-1/cover"
    }),
    "https://brainvault.example/api/pages/page-1/cover?v=1"
  );
  assert.equal(
    context.imageSource("/api/data/export", { allowedApplicationApiPath: "/api/pages/page-1/cover" }),
    null
  );
});

test("BV-38 browser rendered-HTML sanitizer rejects URL-normalization bypasses", () => {
  const patternStart = sanitizerSource.indexOf("const renderedImageDataPattern");
  const policyEnd = sanitizerSource.indexOf("function normalizeRenderedHref", patternStart);
  assert.ok(patternStart >= 0 && policyEnd > patternStart);
  const policySource = sanitizerSource.slice(patternStart, policyEnd);
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(`${policySource}\nglobalThis.imageSource = normalizeRenderedImageSource;`, context);

  for (const payload of [
    "/api/data/export",
    "/ap\ti/data/export",
    "/\tapi/data/export",
    "/ap\ni/data/export",
    "/ap\ri/data/export",
    "/%61pi/data/export",
    "/safe/../api/data/export",
    "/%2561pi/data/export"
  ]) {
    assert.equal(context.imageSource(payload), "", payload);
  }
  assert.equal(context.imageSource("/upload/icons/user/icon.png"), "/upload/icons/user/icon.png");

  assert.match(markdownSource, /new URL\(source, `\$\{renderedImageSyntheticOrigin\}\/`\)/);
  assert.match(markdownSource, /decodedRenderedPathForPolicy\(parsed\.pathname\)/);
});

test("BV-39 NAT64 filtering fails closed when prefix discovery is unknown", () => {
  assert.match(bookmarkSource, /if \(isDnsNoDataError\(error\)\) return configured\.length \? configured : null;/);
  assert.match(bookmarkSource, /hasIpv6 && discoveredPrefixes === null[\s\S]*addresses\.filter\(\(item\) => net\.isIP\(item\.address\) === 4\)/);
  assert.match(bookmarkSource, /reason: "nat64-discovery"/);
  assert.match(bookmarkSource, /const pinned = prioritizeResolvedAddresses\(addresses, knownNat64Prefixes\)/);
  assert.match(networkSource, /isPrivateOrNat64TranslatedAddress\(item\.address, nat64Prefixes\)/);
  assert.doesNotMatch(bookmarkSource, /discoveredNat64Prefixes\s*=\s*\[\]/);
});

test("BV-40 verified preview semantics require a server-issued HMAC", () => {
  assert.match(bookmarkSource, /createHmac\("sha256", env\.JWT_SECRET\)/);
  assert.match(bookmarkSource, /const verified = item\.verified === true && hasValidBookmarkPreviewToken/);
  assert.match(bookmarkSource, /return signBookmarkPreview\(\{/);
  assert.match(bookmarkSource, /previewToken: verified \? previewToken : ""/);
  assert.match(appSource, /const verified = rawItem\.verified === true && hasPreviewToken/);
});
