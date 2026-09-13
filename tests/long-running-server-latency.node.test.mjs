import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("MariaDB pool retires burst-only idle sockets instead of keeping the full fixed pool indefinitely", async () => {
  const db = await read("src/lib/db.ts");
  assert.match(db, /const databasePoolMinimumIdle = 1;/);
  assert.match(db, /const databasePoolIdleTimeoutSeconds = 30;/);
  assert.match(db, /const databaseSocketKeepAliveDelayMs = 30_000;/);
  assert.match(db, /minimumIdle: Math\.min\(databasePoolMinimumIdle, env\.DATABASE_CONNECTION_LIMIT\)/);
  assert.match(db, /idleTimeout: databasePoolIdleTimeoutSeconds/);
  assert.match(db, /keepAliveDelay: databaseSocketKeepAliveDelayMs/);
});

test("network-policy caches revalidate known exact-IP facts off the authenticated request critical path", async () => {
  const [vpn, country] = await Promise.all([
    read("src/lib/vpn-access-policy.ts"),
    read("src/lib/country-login-policy.ts")
  ]);

  assert.match(vpn, /const providerSignalStaleMs = 15 \* 60_000;/);
  assert.match(vpn, /const unavailableProviderSignalStaleMs = 2 \* 60_000;/);
  assert.match(vpn, /const vpnGateMatchStaleMs = 5 \* 60_000;/);
  assert.match(vpn, /if \(cached && cached\.staleUntil > now\) \{\s*void startProviderSignalRefresh/s);
  assert.match(vpn, /if \(cached && cached\.staleUntil > now\) \{\s*void startVpnGateMatchRefresh/s);
  assert.match(vpn, /const cacheKey = `\$\{provider\}\|\$\{ipAddress\}`;/);

  assert.match(country, /const successfulCountryStaleMs = 30 \* 60_000;/);
  assert.match(country, /const countryResolutionInFlight = new Map/);
  assert.match(country, /cached\?\.resolved && cached\.countryCode && cached\.staleUntil > now/);
  assert.match(country, /void startCountryResolutionRefresh\(normalizedIp\)/);
  assert.match(country, /staleUntil: now \+ \(resolved \? successfulCountryStaleMs : unresolvedCountryCacheMs\)/);
});

test("direct passkey intent warming remains bounded by the five-minute server challenge lifetime", async () => {
  const [client, route] = await Promise.all([
    read("public/app.js"),
    read("src/routes/passkey-login.routes.ts")
  ]);
  assert.match(route, /const challengeLifetimeMs = 5 \* 60_000;/);
  assert.match(client, /const directPasskeyOptionsWarmupMaxAgeMs = 3 \* 60_000;/);
  assert.match(client, /addEventListener\("pointerenter", primeDirectPasskeyOptionsFromIntent/);
  assert.match(client, /addEventListener\("focus", primeDirectPasskeyOptionsFromIntent/);
});
