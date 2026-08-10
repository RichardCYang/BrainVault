import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("VPN access policy is enforced across authentication and collaboration boundaries", async () => {
  const [authRoutes, mfaRoutes, passkeyRoutes, authMiddleware, collaborationServer] = await Promise.all([
    read("src/routes/auth.routes.ts"),
    read("src/routes/mfa.routes.ts"),
    read("src/routes/passkey-login.routes.ts"),
    read("src/middleware/auth.ts"),
    read("src/lib/collaboration-server.ts")
  ]);

  assert.match(authRoutes, /await enforceVpnAccessPolicy\([\s\S]*?user\.id,[\s\S]*?user\.vpn_block_enabled,[\s\S]*?sourceIp/);
  assert.match(mfaRoutes, /await enforceVpnAccessPolicy\(pendingSession\.user_id, undefined, pendingSession\.source_ip, getClientTimeZone\(req\)\);/);
  assert.match(mfaRoutes, /await enforceVpnAccessPolicy\(session\.user_id, undefined, session\.source_ip, getClientTimeZone\(req\)\);/);
  assert.match(passkeyRoutes, /await enforceVpnAccessPolicy\(passkey\.user_id, undefined, sourceIp, getClientTimeZone\(req\)\);/);
  assert.match(authMiddleware, /await enforceVpnAccessPolicy\([\s\S]*?user\.vpn_block_enabled[\s\S]*?getClientTimeZone\(req\)/);
  assert.match(collaborationServer, /await enforceVpnAccessPolicy\(user\.id, user\.vpn_block_enabled, sourceIp\);/);
  assert.match(collaborationServer, /await enforceVpnAccessPolicy\(client\.user\.id, currentUser\.vpn_block_enabled, client\.ipAddress\);/);
});

test("VPN detection uses free no-key network intelligence, Tor bulk data, VPN Gate directory data, and conservative supporting signals", async () => {
  const [policy, vpnGate] = await Promise.all([
    read("src/lib/vpn-access-policy.ts"),
    read("src/lib/vpngate-relays.ts")
  ]);

  assert.match(policy, /https:\/\/api\.ipquery\.io/);
  assert.match(policy, /https:\/\/api\.ipapi\.is\//);
  assert.match(policy, /https:\/\/check\.torproject\.org\/exit-addresses/);
  assert.match(policy, /TOR_AUTHORITATIVE_EXIT_LIST/);
  assert.match(policy, /VPN_GATE_DIRECTORY_DDNS_VERIFIED/);
  assert.match(policy, /VPN_GATE_DIRECTORY_PROVIDER_CORROBORATED/);
  assert.match(policy, /VPN_GATE_DIRECTORY_UNVERIFIED/);
  assert.match(policy, /vpnGatePositiveRiskCacheMs = 2 \* 60_000/);
  assert.match(policy, /reason: "VPN_GATE_DETECTED"/);
  assert.match(policy, /MULTI_PROVIDER_VPN_SIGNAL/);
  assert.match(vpnGate, /https:\/\/www\.vpngate\.net\/api\/iphone\//);
  assert.match(vpnGate, /\.opengw\.net/);
  assert.match(vpnGate, /resolve4/);
  assert.match(vpnGate, /resolve6/);
  assert.match(vpnGate, /vpnGateMaxBytes = 8 \* 1024 \* 1024/);
  assert.match(vpnGate, /vpnGateStaleMs = 15 \* 60_000/);
  assert.match(vpnGate, /isPublicCountryLookupIp/);
  assert.match(policy, /PROVIDER_DISAGREEMENT/);
  assert.match(policy, /TIMEZONE_OFFSET_MISMATCH/);
  assert.match(policy, /DATACENTER_NETWORK/);
  assert.match(policy, /timezoneMismatchThresholdMinutes = 180/);
  assert.match(policy, /verdict: "UNKNOWN",\s*blocked: false/);
  assert.match(policy, /"VPN_ACCESS_BLOCKED"/);
});

test("settings API, migration, browser UI, and block history include VPN blocking", async () => {
  const [authRoutes, migration, vpnGateMigration, index, client, i18n, countryPolicy] = await Promise.all([
    read("src/routes/auth.routes.ts"),
    read("migrations/046_vpn_access_policy.sql"),
    read("migrations/047_vpngate_detection.sql"),
    read("public/index.html"),
    read("public/app.js"),
    read("public/i18n.js"),
    read("src/lib/country-login-policy.ts")
  ]);

  assert.match(authRoutes, /authRouter\.get\("\/vpn-block-policy", requireAuth/);
  assert.match(authRoutes, /"\/vpn-block-policy",\s*requireAuth,/);
  assert.match(authRoutes, /assertVpnPolicyAllowsCurrentConnection\(enabled, sourceIp, clientTimeZone\)/);
  assert.match(migration, /vpn_block_enabled TINYINT\(1\) NOT NULL DEFAULT 0/);
  assert.match(migration, /'VPN_DETECTED'/);
  assert.match(migration, /'PROXY_DETECTED'/);
  assert.match(migration, /'TOR_DETECTED'/);
  assert.match(vpnGateMigration, /'VPN_GATE_DETECTED'/);
  assert.match(countryPolicy, /\| "VPN_DETECTED"/);
  assert.match(countryPolicy, /\| "VPN_GATE_DETECTED"/);
  assert.match(index, /id="account-vpn-block-enabled"/);
  assert.match(index, /id="account-vpn-block-current-verdict"/);
  assert.match(client, /async function loadVpnBlockPolicy/);
  assert.match(client, /async function saveVpnBlockPolicy/);
  assert.match(client, /data\?\.error\?\.code === "VPN_ACCESS_BLOCKED"/);
  assert.match(client, /VPN_DETECTED: "account\.blockHistoryVpnDetected"/);
  assert.match(client, /VPN_GATE_DETECTED: "account\.blockHistoryVpnGateDetected"/);
  assert.match(client, /VPN_GATE: "account\.vpnBlockRiskVpnGate"/);
  assert.match(client, /VPN_GATE_DIRECTORY_DDNS_VERIFIED/);
  assert.match(i18n, /vpnBlockTitle: "VPN \/ 프록시 접속 차단"/);
  assert.match(i18n, /blockHistoryVpnDetected: "VPN 감지"/);
  assert.match(i18n, /blockHistoryVpnGateDetected: "VPN Gate 공개 릴레이 감지"/);
});
