import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const vpnGateSourceUrl = new URL("src/lib/vpngate-relays.ts", root);
const vpnGateMaxBytes = 8 * 1024 * 1024;

async function importVpnGateModuleForBehaviorTest() {
  const countryCodesUrl = new URL("src/lib/country-codes.ts", root).href;
  const geoCountryUrl = new URL("src/lib/geo-country.ts", root).href;
  const directory = await mkdtemp(join(tmpdir(), "brainvault-vpngate-stream-test-"));
  const dnsMockPath = join(directory, "dns-mock.mjs");
  await writeFile(
    dnsMockPath,
    "export async function resolve4() { return []; }\nexport async function resolve6() { return []; }\n",
    "utf8"
  );
  const source = (await readFile(vpnGateSourceUrl, "utf8"))
    .replace('from "node:dns/promises"', `from ${JSON.stringify(pathToFileURL(dnsMockPath).href)}`)
    .replace('from "./country-codes.js"', `from ${JSON.stringify(countryCodesUrl)}`)
    .replace('from "./geo-country.js"', `from ${JSON.stringify(geoCountryUrl)}`);
  const modulePath = join(directory, "vpngate-relays.ts");
  await writeFile(modulePath, source, "utf8");
  const module = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}-${Math.random()}`);
  return { module, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function responseFromChunks(chunks, { onCancel } = {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() {
      onCancel?.();
    }
  }), { status: 200, headers: { "content-type": "text/csv" } });
}

test("other bounded network readers avoid a redundant Buffer.from copy for each fetch chunk", async () => {
  for (const relativePath of ["src/lib/vpn-access-policy.ts", "src/lib/geo-country.ts"]) {
    const source = await readFile(new URL(relativePath, root), "utf8");
    assert.match(source, /const chunks: Uint8Array\[\] = \[\]/);
    assert.match(source, /chunks\.push\(value\)/);
    assert.doesNotMatch(source, /chunks\.push\(Buffer\.from\(value\)\)/);
    assert.match(source, /Buffer\.concat\(chunks, totalBytes\)/);
  }
});

test("country batch JSON decoding remains correct when Uint8Array chunks are retained without copying", async () => {
  const originalFetch = globalThis.fetch;
  const geoCountryUrl = new URL(`src/lib/geo-country.ts?test=${Date.now()}-${Math.random()}`, root);
  const geoCountry = await import(geoCountryUrl.href);
  const bytes = new TextEncoder().encode('[{"ip":"1.1.1.1","country":"US"}]');
  globalThis.fetch = async () => responseFromChunks([bytes.slice(0, 7), bytes.slice(7, 19), bytes.slice(19)]);
  try {
    const result = await geoCountry.lookupCountryCodes(["1.1.1.1"]);
    assert.equal(result.get("1.1.1.1"), "US");
  } finally {
    globalThis.fetch = originalFetch;
    geoCountry.resetCountryInfoCacheForTests();
  }
});

test("VPN Gate refresh parses the bounded directory incrementally instead of materializing duplicate full-body buffers", async () => {
  const source = await readFile(vpnGateSourceUrl, "utf8");
  assert.match(source, /const decoder = new TextDecoder\(\)/);
  assert.match(source, /totalBytes \+= value\.byteLength/);
  assert.match(source, /if \(totalBytes > vpnGateMaxBytes\)/);
  assert.match(source, /await reader\.cancel\(\)/);
  assert.doesNotMatch(source, /const chunks: Buffer\[\] = \[\]/);
  assert.doesNotMatch(source, /chunks\.push\(Buffer\.from\(value\)\)/);
  assert.doesNotMatch(source, /Buffer\.concat\(chunks, totalBytes\)/);
});

test("streaming VPN Gate parsing preserves chunk-boundary, CRLF, quoted CSV, and public-relay behavior", async () => {
  const originalFetch = globalThis.fetch;
  const { module, cleanup } = await importVpnGateModuleForBehaviorTest();
  const encoder = new TextEncoder();
  const csv = [
    "comment before header 한글",
    "#HostName,IP,CountryShort,Score",
    '"vpn-one",1.1.1.1,US,10',
    '"vpn-two.opengw.net",8.8.4.4,KR,20',
    "*"
  ].join("\r\n");
  const bytes = encoder.encode(csv);
  const cutPoints = [1, 2, 5, 17, 31, 47, 73, 101, bytes.length];
  const chunks = [];
  let start = 0;
  for (const end of cutPoints) {
    if (end <= start) continue;
    chunks.push(bytes.slice(start, Math.min(end, bytes.length)));
    start = end;
    if (start >= bytes.length) break;
  }
  if (start < bytes.length) chunks.push(bytes.slice(start));

  globalThis.fetch = async () => responseFromChunks(chunks);
  try {
    module.resetVpnGateRelayCacheForTests();
    const first = await module.matchVpnGateRelay("1.1.1.1");
    const second = await module.matchVpnGateRelay("8.8.4.4");
    assert.deepEqual(first, {
      listed: true,
      dnsVerified: false,
      countryCode: "US",
      hostname: "vpn-one.opengw.net"
    });
    assert.deepEqual(second, {
      listed: true,
      dnsVerified: false,
      countryCode: "KR",
      hostname: "vpn-two.opengw.net"
    });
  } finally {
    globalThis.fetch = originalFetch;
    module.resetVpnGateRelayCacheForTests();
    await cleanup();
  }
});

test("streaming parser keeps the 20,000 accepted-row cap and four-hostname-per-IP cap", async () => {
  const { module, cleanup } = await importVpnGateModuleForBehaviorTest();
  try {
    const hostnameRows = ["a", "b", "c", "d", "e"].map((name) => `${name},1.1.1.1,US`);
    const cappedRows = Array.from({ length: 19_995 }, () => "a,1.1.1.1,US");
    const csv = [
      "#HostName,IP,CountryShort",
      ...hostnameRows,
      ...cappedRows,
      "late,8.8.8.8,US"
    ].join("\n");
    const parsed = module.parseVpnGateCsv(csv);
    assert.equal(parsed.size, 1, "the 20,001st accepted row must remain outside the directory");
    assert.deepEqual(parsed.get("1.1.1.1")?.hostnames, [
      "a.opengw.net",
      "b.opengw.net",
      "c.opengw.net",
      "d.opengw.net"
    ]);
    assert.equal(parsed.has("8.8.8.8"), false);
  } finally {
    await cleanup();
  }
});

test("streaming refresh still reads raw bytes after the row cap and rejects an oversized chunked body", async () => {
  const originalFetch = globalThis.fetch;
  const { module, cleanup } = await importVpnGateModuleForBehaviorTest();
  const encoder = new TextEncoder();
  const header = encoder.encode("#HostName,IP,CountryShort\n");
  const acceptedRows = encoder.encode("vpn1,1.1.1.1,US\n".repeat(20_000));
  const padding = new Uint8Array(1024 * 1024);
  padding.fill(42);
  let canceled = false;

  globalThis.fetch = async () => responseFromChunks(
    [header, acceptedRows, ...Array.from({ length: 9 }, () => padding)],
    { onCancel: () => { canceled = true; } }
  );
  try {
    module.resetVpnGateRelayCacheForTests();
    const match = await module.matchVpnGateRelay("1.1.1.1");
    assert.equal(canceled, true, "oversized chunked bodies must still be canceled after the parser row cap is reached");
    assert.equal(match.listed, false, "an oversized refresh must fail closed instead of publishing partial rows");
  } finally {
    globalThis.fetch = originalFetch;
    module.resetVpnGateRelayCacheForTests();
    await cleanup();
  }
});

test("declared VPN Gate bodies above the byte limit are rejected before any body data is accepted", async () => {
  const originalFetch = globalThis.fetch;
  const { module, cleanup } = await importVpnGateModuleForBehaviorTest();
  let bodyAccessed = false;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-length" ? String(vpnGateMaxBytes + 1) : null;
      }
    },
    get body() {
      bodyAccessed = true;
      throw new Error("oversized declared body must not be read");
    }
  });

  try {
    module.resetVpnGateRelayCacheForTests();
    const match = await module.matchVpnGateRelay("1.1.1.1");
    assert.equal(match.listed, false);
    assert.equal(bodyAccessed, false);
  } finally {
    globalThis.fetch = originalFetch;
    module.resetVpnGateRelayCacheForTests();
    await cleanup();
  }
});
