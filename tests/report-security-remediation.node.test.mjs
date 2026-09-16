import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  inferNat64PrefixFromIpv4OnlyAddress,
  isPrivateOrNat64TranslatedAddress,
  parseNat64Prefix
} from "../src/lib/network-address.ts";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("BV-31 validates server-generated canonical and incremental Yjs encodings", () => {
  const source = read("src/lib/yjs-validation.ts");
  assert.match(source, /assertUpdatePreflight\(stateUpdate, maxStateBytes\);/);
  assert.match(source, /assertUpdatePreflight\(incrementalUpdate, maxStateBytes\);/);
});

test("BV-32 snapshot diff uses the export concurrency gate", () => {
  const source = read("src/routes/snapshot.routes.ts");
  assert.match(
    source,
    /snapshotRouter\.get<SnapshotRouteParams>\("\/:snapshotId\/diff", dataExportRateLimit, dataExportConcurrencyLimit,/
  );
});

test("BV-33 rendered content cannot auto-dispatch API image requests", () => {
  const serverSanitizer = read("src/lib/markdown.ts");
  const clientSanitizer = read("public/rendered-html-sanitizer.js");
  const blockRoutes = read("src/routes/block.routes.ts");

  assert.match(serverSanitizer, /new URL\(source, `\$\{renderedImageSyntheticOrigin\}\/`\)/);
  assert.match(serverSanitizer, /decodedRenderedPathForPolicy\(parsed\.pathname\)/);
  assert.match(clientSanitizer, /new URL\(source, `\$\{renderedImageSyntheticOrigin\}\/`\)/);
  assert.match(clientSanitizer, /decodedRenderedPathForPolicy\(parsed\.pathname\)/);
  assert.match(serverSanitizer, /rendered-ai-chat-image-link/);
  assert.doesNotMatch(serverSanitizer, /\/api\/ai-chat\/image\?url=/);
  assert.doesNotMatch(blockRoutes, /"\/ai-chat\/image"/);
});

test("BV-34 blocks private IPv4 destinations embedded in a configured RFC 6052 NAT64 prefix", () => {
  const prefix = parseNat64Prefix("2a00:64::/96");
  assert.ok(prefix);
  assert.equal(isPrivateOrNat64TranslatedAddress("2a00:64::7f00:1", [prefix]), true);
  assert.equal(isPrivateOrNat64TranslatedAddress("2a00:64::a9fe:a9fe", [prefix]), true);
  assert.equal(isPrivateOrNat64TranslatedAddress("2a00:64::808:808", [prefix]), false);
});

test("BV-34 infers RFC 6052 NAT64 prefixes from RFC 7050 ipv4only.arpa answers", () => {
  assert.deepEqual(inferNat64PrefixFromIpv4OnlyAddress("2a00:64::c000:aa"), {
    base: "2a00:0064:0000:0000:0000:0000:0000:0000",
    prefixLength: 96
  });
  assert.deepEqual(inferNat64PrefixFromIpv4OnlyAddress("2001:db8:122:344:c0:0:aa00:0"), {
    base: "2001:0db8:0122:0344:0000:0000:0000:0000",
    prefixLength: 64
  });

  const bookmark = read("src/lib/bookmark.ts");
  assert.match(bookmark, /resolver\.resolve6\("ipv4only\.arpa"\)/);
  assert.match(bookmark, /isPrivateOrNat64TranslatedAddress\(item\.address, nat64Prefixes\)/);
  assert.match(bookmark, /discoveredPrefixes === null[\s\S]*addresses\.filter\(\(item\) => net\.isIP\(item\.address\) === 4\)/);
  assert.match(bookmark, /const pinned = prioritizeResolvedAddresses\(addresses, knownNat64Prefixes\)/);
  assert.doesNotMatch(bookmark, /discoveredNat64Prefixes = \[\]/);
});


test("BV-35 backup page-version revisions cannot poison future history increments", () => {
  const source = read("src/lib/data-transfer.ts");
  assert.match(source, /revision: z\.number\(\)\.int\(\)\.min\(1\)\.max\(dataTransferResourceLimits\.maxPageVersions\)/);
});

test("BV-36 hostname normalization strips all trailing root dots", () => {
  const source = read("src/lib/network-address.ts");
  assert.match(source, /\.replace\(\/\\\.\+\$\/, ""\)/);
});
