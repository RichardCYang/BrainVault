import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const fiveMinutesMs = 5 * 60_000;

function csvFor(ipAddress = "1.1.1.1") {
  return [
    "#HostName,IP,CountryShort",
    `vpn1,${ipAddress},US`,
    "*"
  ].join("\n");
}

async function importVpnGateModuleForBehaviorTest() {
  const sourceUrl = new URL("src/lib/vpngate-relays.ts", root);
  const countryCodesUrl = new URL("src/lib/country-codes.ts", root).href;
  const geoCountryUrl = new URL("src/lib/geo-country.ts", root).href;
  const source = (await readFile(sourceUrl, "utf8"))
    .replace('from "./country-codes.js"', `from ${JSON.stringify(countryCodesUrl)}`)
    .replace('from "./geo-country.js"', `from ${JSON.stringify(geoCountryUrl)}`);
  const directory = await mkdtemp(join(tmpdir(), "brainvault-vpngate-test-"));
  const modulePath = join(directory, "vpngate-relays.ts");
  await writeFile(modulePath, source, "utf8");
  const module = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
  return { module, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("Public-relay refresh serves a still-safe cached directory without blocking the next authenticated request", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const baseNow = 1_800_000_000_000;
  let now = baseNow;
  let fetchCount = 0;
  let resolveRefresh = null;
  const { module, cleanup } = await importVpnGateModuleForBehaviorTest();

  Date.now = () => now;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(csvFor(), {
        status: 200,
        headers: { "content-type": "text/csv" }
      });
    }
    return new Promise((resolve) => {
      resolveRefresh = () => resolve(new Response(csvFor(), {
        status: 200,
        headers: { "content-type": "text/csv" }
      }));
    });
  };

  try {
    module.resetVpnGateRelayCacheForTests();

    const initial = await module.matchVpnGateRelay("8.8.8.8");
    assert.equal(initial.listed, false);
    assert.equal(fetchCount, 1);

    now += fiveMinutesMs + 1;

    const outcome = await Promise.race([
      module.matchVpnGateRelay("8.8.8.8").then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50))
    ]);

    assert.equal(outcome, "returned", "stale-but-safe directory refresh must stay off the request critical path");
    assert.equal(fetchCount, 2, "an expired fresh window should still trigger a background refresh");
    assert.equal(typeof resolveRefresh, "function");
    resolveRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    module.resetVpnGateRelayCacheForTests();
    await cleanup();
  }
});
