import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("country login policy is enforced at every authentication/session boundary", async () => {
  const [authRoutes, mfaRoutes, passkeyRoutes, authMiddleware, collaborationServer] = await Promise.all([
    read("src/routes/auth.routes.ts"),
    read("src/routes/mfa.routes.ts"),
    read("src/routes/passkey-login.routes.ts"),
    read("src/middleware/auth.ts"),
    read("src/lib/collaboration-server.ts")
  ]);

  assert.match(authRoutes, /await enforceCountryLoginPolicy\(user\.id, user\.country_login_mode, sourceIp\);/);
  assert.match(mfaRoutes, /await enforceCountryLoginPolicy\(pendingSession\.user_id, undefined, pendingSession\.source_ip\);/);
  assert.match(mfaRoutes, /await enforceCountryLoginPolicy\(session\.user_id, undefined, session\.source_ip\);/);
  assert.match(passkeyRoutes, /await enforceCountryLoginPolicy\(passkey\.user_id, undefined, sourceIp\);/);
  assert.match(authMiddleware, /await enforceCountryLoginPolicy\(user\.id, user\.country_login_mode, getClientIpAddress\(req\)\);/);
  assert.match(authMiddleware, /country_login_mode/);
  assert.match(collaborationServer, /getClientIpAddressFromTrustedProxyRequest/);
  assert.match(collaborationServer, /await enforceCountryLoginPolicy\(user\.id, user\.country_login_mode, sourceIp\);/);
  assert.match(collaborationServer, /await enforceCountryLoginPolicy\(client\.user\.id, currentUser\.country_login_mode, client\.ipAddress\);/);
});

test("enabled country policy fails closed and records a dedicated block event", async () => {
  const policy = await read("src/lib/country-login-policy.ts");

  assert.match(policy, /if \(!policy\.countries\.length\) return \{ allowed: false, reason: "POLICY_INVALID" \};/);
  assert.match(policy, /if \(!resolution\.resolved \|\| !resolution\.countryCode\)/);
  assert.match(policy, /reason: "COUNTRY_UNRESOLVED"/);
  assert.match(policy, /reason: "NOT_ALLOWLISTED"/);
  assert.match(policy, /reason: "BLOCKLISTED"/);
  assert.match(policy, /INSERT INTO user_country_login_blocks/);
  assert.match(policy, /"COUNTRY_LOGIN_BLOCKED"/);
});

test("settings API, block history API, migration, and browser controls are wired together", async () => {
  const [authRoutes, policy, migration, index, client] = await Promise.all([
    read("src/routes/auth.routes.ts"),
    read("src/lib/country-login-policy.ts"),
    read("migrations/045_country_login_access_policy.sql"),
    read("public/index.html"),
    read("public/app.js")
  ]);

  assert.match(authRoutes, /authRouter\.get\("\/country-login-policy", requireAuth/);
  assert.match(authRoutes, /"\/country-login-policy",\s*requireAuth,/);
  assert.match(authRoutes, /"\/block-history",\s*requireAuth,/);
  assert.match(authRoutes, /assertPolicyAllowsCurrentLocation\(mode, countries, sourceIp\)/);
  assert.match(policy, /COUNTRY_POLICY_WOULD_BLOCK_CURRENT_IP/);
  assert.match(migration, /country_login_mode ENUM\('OFF', 'ALLOWLIST', 'BLOCKLIST'\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_country_login_countries/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_country_login_blocks/);
  assert.match(index, /data-security-panel="blocks"/);
  assert.match(index, /id="account-country-login-mode"/);
  assert.match(index, /id="account-country-login-selected"/);
  assert.match(client, /async function loadBlockHistory/);
  assert.match(client, /async function saveCountryLoginPolicy/);
  assert.match(client, /data\?\.error\?\.code === "COUNTRY_LOGIN_BLOCKED"/);
});
