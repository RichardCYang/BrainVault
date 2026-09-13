import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routeSection(source, routerName, method, routePath) {
  const pattern = new RegExp(`${escapeRegExp(routerName)}\\.${method}\\(\\s*[\"']${escapeRegExp(routePath)}[\"']`);
  const match = pattern.exec(source);
  assert.ok(match, `missing route: ${method.toUpperCase()} ${routePath}`);
  const start = match.index;
  const nextPattern = new RegExp(`\n${escapeRegExp(routerName)}\\.(?:get|post|put|patch|delete)\\(`, "g");
  nextPattern.lastIndex = start + match[0].length;
  const next = nextPattern.exec(source);
  return source.slice(start, next ? next.index : undefined);
}

function assertDurableSessionFence(source, routerName, method, routePath, durableMutationPattern) {
  const section = routeSection(source, routerName, method, routePath);
  const scopeIndex = section.indexOf("requireRequestAuthScope(req)");
  const fenceIndex = section.indexOf("assertCurrentAuthSession(");
  const mutationIndex = section.search(durableMutationPattern);
  assert.ok(scopeIndex >= 0, `${method.toUpperCase()} ${routePath} must capture the exact request auth scope`);
  assert.ok(fenceIndex > scopeIndex, `${method.toUpperCase()} ${routePath} must revalidate the exact device session in its transaction`);
  assert.ok(mutationIndex > fenceIndex, `${method.toUpperCase()} ${routePath} must fence before the durable security mutation`);
}

test("account-security mutations revalidate the exact device session at the durable boundary", async () => {
  const auth = await read("src/routes/auth.routes.ts");
  for (const [method, path, mutation] of [
    ["post", "/logout", /UPDATE users SET auth_version/],
    ["delete", "/sessions/:sessionId", /revokeAuthSession\(/],
    ["put", "/totp-ip-block-policy", /UPDATE users[\s\S]*totp_ip_block_enabled/],
    ["delete", "/totp-ip-blocks/:ipAddress", /DELETE FROM user_totp_ip_blocks/],
    ["put", "/vpn-block-policy", /UPDATE users SET vpn_block_enabled/],
    ["put", "/country-login-policy", /UPDATE users SET country_login_mode/],
    ["post", "/password", /UPDATE users SET password_hash/],
  ]) {
    assertDurableSessionFence(auth, "authRouter", method, path, mutation);
  }
});

test("MFA enrollment and credential mutations cannot resurrect a revoked device session", async () => {
  const mfa = await read("src/routes/mfa.routes.ts");
  for (const [method, path, mutation] of [
    ["post", "/totp/setup", /INSERT INTO mfa_totp_setups/],
    ["post", "/totp/verify", /INSERT INTO user_totp_credentials/],
    ["delete", "/totp", /DELETE FROM user_totp_credentials/],
    ["post", "/passkeys/options", /createChallenge\(/],
    ["post", "/passkeys", /INSERT INTO user_passkeys/],
    ["patch", "/passkeys/:id", /UPDATE user_passkeys SET name/],
    ["delete", "/passkeys/:id", /DELETE FROM user_passkeys/],
  ]) {
    assertDurableSessionFence(mfa, "mfaRouter", method, path, mutation);
  }
});

test("session-only fence locks the account and exact device session without coupling account security to workspace generation", async () => {
  const sessions = await read("src/lib/auth-sessions.ts");
  const start = sessions.indexOf("export async function assertCurrentAuthSession(");
  const end = sessions.indexOf("export async function assertCurrentAuthSessionBoundary(", start);
  assert.ok(start >= 0 && end > start, "missing session-only durable fence");
  const section = sessions.slice(start, end);
  assert.match(section, /FROM users WHERE id = \? FOR UPDATE/);
  assert.match(section, /isAuthSessionActive\(userId, sessionId, authVersion, client, \{ lock: true \}\)/);
  assert.doesNotMatch(section, /workspaceGeneration/);

  const boundary = sessions.slice(end);
  assert.match(boundary, /isAuthSessionActive\(userId, sessionId, authVersion, client, \{ lock: true \}\)/);
  assert.match(boundary, /WORKSPACE_RESTORED/);
});

test("standalone reproduction shows revoked-session credential resurrection before the fix", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-account-security-session-revocation.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.credentialChanged, true);
  assert.equal(result.vulnerable.replacementSessionIssued, true);
  assert.equal(result.fixed.credentialChanged, false);
  assert.equal(result.fixed.replacementSessionIssued, false);
});
