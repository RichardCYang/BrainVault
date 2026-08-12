import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("TOTP attempt limiting persists failures, permanent blocks, and security history", async () => {
  const [migration, policy, mfaRoutes, countryPolicy] = await Promise.all([
    read("migrations/050_totp_ip_permanent_block.sql"),
    read("src/lib/totp-ip-block.ts"),
    read("src/routes/mfa.routes.ts"),
    read("src/lib/country-login-policy.ts")
  ]);

  assert.match(migration, /totp_ip_block_enabled TINYINT\(1\) NOT NULL DEFAULT 0/);
  assert.match(migration, /totp_ip_block_threshold TINYINT UNSIGNED NOT NULL DEFAULT 3/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_totp_ip_failures/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_totp_ip_blocks/);
  assert.match(migration, /KEY idx_user_totp_ip_blocks_ip \(ip_address\)/);
  assert.match(migration, /'TOTP_ATTEMPTS_EXCEEDED'/);
  assert.match(policy, /export const defaultTotpIpBlockThreshold = 3/);
  assert.match(policy, /attempts >= maxAttempts/);
  assert.match(policy, /INSERT IGNORE INTO user_totp_ip_blocks/);
  assert.match(policy, /recordCountryLoginBlockStrict\([\s\S]*?"TOTP_ATTEMPTS_EXCEEDED"/);
  assert.match(countryPolicy, /\| "TOTP_ATTEMPTS_EXCEEDED"/);
  assert.match(mfaRoutes, /await recordTotpIpFailure\(session\.user_id, session\.source_ip\)/);
  assert.match(mfaRoutes, /disconnectIpCollaborators\(session\.source_ip/);
  assert.match(mfaRoutes, /"TOTP_IP_PERMANENTLY_BLOCKED"/);
  assert.match(mfaRoutes, /await clearTotpIpFailures\(activeSession\.user_id, activeSession\.source_ip, client\)/);
});

test("permanent TOTP IP blocking runs before static files and WebSockets and provides authenticated manual unblock", async () => {
  const [server, app, middleware, authRoutes, collaborationServer, index, client, i18n] = await Promise.all([
    read("src/server.ts"),
    read("src/app.ts"),
    read("src/middleware/totp-ip-block.ts"),
    read("src/routes/auth.routes.ts"),
    read("src/lib/collaboration-server.ts"),
    read("public/index.html"),
    read("public/app.js"),
    read("public/i18n.js")
  ]);

  assert.match(server, /await initializePermanentTotpIpEnforcement\(\)/);
  assert.ok(app.indexOf("app.use(enforcePermanentTotpIpBlock)") < app.indexOf("app.use(express.static(publicDir"));
  assert.ok(app.indexOf("app.use(enforcePermanentTotpIpBlock)") < app.indexOf('app.get("/"'));
  assert.match(middleware, /isPermanentlyBlockedTotpIp\(ipAddress\)/);
  assert.match(middleware, /res\.status\(403\).*?Forbidden/s);
  assert.match(authRoutes, /authRouter\.get\("\/totp-ip-block-policy", requireAuth/);
  assert.match(authRoutes, /"\/totp-ip-block-policy",\s*requireAuth,/);
  assert.match(authRoutes, /authRouter\.get\("\/totp-ip-blocks", requireAuth/);
  assert.match(authRoutes, /"\/totp-ip-blocks\/:ipAddress",\s*requireAuth,\s*accountReauthenticationRateLimit/);
  assert.match(authRoutes, /verifyPassword\(currentPassword, user\.password_hash\)/);
  assert.match(collaborationServer, /if \(await isPermanentlyBlockedTotpIp\(sourceIp\)\)/);
  assert.match(collaborationServer, /if \(await isPermanentlyBlockedTotpIp\(client\.ipAddress\)\)/);
  assert.match(collaborationServer, /export function disconnectIpCollaborators/);
  assert.match(middleware, /TOTP_IP_PERMANENTLY_BLOCKED/);
  assert.match(index, /id="account-totp-ip-block-threshold"[^>]*value="3"/);
  assert.match(index, /data-security-panel="totp-blocks"/);
  assert.match(index, /id="account-totp-ip-unblock-password"/);
  assert.match(client, /async function saveTotpIpBlockPolicy/);
  assert.match(client, /async function unblockPermanentTotpIp/);
  assert.match(client, /TOTP_ATTEMPTS_EXCEEDED: "account\.blockHistoryTotpAttemptsExceeded"/);
  assert.match(i18n, /totpIpBlockTitle: "TOTP 횟수 제한"/);
  assert.match(i18n, /TOTP_IP_PERMANENTLY_BLOCKED: "TOTP 인증 코드를 설정 횟수 이상 틀려 현재 IP가 영구 차단되었습니다/);
});
