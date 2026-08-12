import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("TOTP attempt limiting scopes blocks to one account and expires them", async () => {
  const [baseMigration, expiryMigration, policy, mfaRoutes, countryPolicy] = await Promise.all([
    read("migrations/050_totp_ip_permanent_block.sql"),
    read("migrations/051_totp_ip_block_expiry.sql"),
    read("src/lib/totp-ip-block.ts"),
    read("src/routes/mfa.routes.ts"),
    read("src/lib/country-login-policy.ts")
  ]);

  assert.match(baseMigration, /totp_ip_block_enabled TINYINT\(1\) NOT NULL DEFAULT 0/);
  assert.match(baseMigration, /totp_ip_block_threshold TINYINT UNSIGNED NOT NULL DEFAULT 3/);
  assert.match(baseMigration, /CREATE TABLE IF NOT EXISTS user_totp_ip_failures/);
  assert.match(baseMigration, /CREATE TABLE IF NOT EXISTS user_totp_ip_blocks/);
  assert.match(expiryMigration, /ADD COLUMN IF NOT EXISTS expires_at DATETIME\(3\)/);
  assert.match(expiryMigration, /INTERVAL 24 HOUR/);
  assert.match(expiryMigration, /MODIFY COLUMN expires_at DATETIME\(3\) NOT NULL/);
  assert.match(policy, /export const totpIpBlockDurationHours = 24/);
  assert.match(policy, /WHERE user_id = \? AND ip_address = \? AND expires_at > CURRENT_TIMESTAMP\(3\)/);
  assert.match(policy, /attempts >= maxAttempts/);
  assert.match(policy, /INSERT INTO user_totp_ip_blocks \(user_id, ip_address, failed_attempts, expires_at\)/);
  assert.match(policy, /recordCountryLoginBlockStrict\([\s\S]*?"TOTP_ATTEMPTS_EXCEEDED"/);
  assert.match(countryPolicy, /\| "TOTP_ATTEMPTS_EXCEEDED"/);
  assert.match(mfaRoutes, /await recordTotpIpFailure\(session\.user_id, session\.source_ip\)/);
  assert.match(mfaRoutes, /disconnectUserCollaborators\(session\.user_id/);
  assert.doesNotMatch(mfaRoutes, /disconnectIpCollaborators\(session\.source_ip/);
  assert.match(mfaRoutes, /await clearTotpIpFailures\(activeSession\.user_id, activeSession\.source_ip, client\)/);
});

test("TOTP IP enforcement is post-authentication, account-scoped, and self-unblockable with an existing session", async () => {
  const [server, app, middleware, authMiddleware, authRoutes, passkeyRoutes, collaborationServer] = await Promise.all([
    read("src/server.ts"),
    read("src/app.ts"),
    read("src/middleware/totp-ip-block.ts"),
    read("src/middleware/auth.ts"),
    read("src/routes/auth.routes.ts"),
    read("src/routes/passkey-login.routes.ts"),
    read("src/lib/collaboration-server.ts")
  ]);

  assert.match(server, /await initializePermanentTotpIpEnforcement\(\)/);
  assert.doesNotMatch(app, /app\.use\(enforcePermanentTotpIpBlock\)/);
  assert.match(middleware, /!req\.user\?\.id/);
  assert.match(middleware, /isPermanentlyBlockedTotpIp\(ipAddress, req\.user\.id\)/);
  assert.match(authMiddleware, /isPermanentlyBlockedTotpIp\(clientIp, user\.id\)/);
  assert.match(authRoutes, /isPermanentlyBlockedTotpIp\(sourceIp, user\.id\)/);
  assert.match(passkeyRoutes, /isPermanentlyBlockedTotpIp\(sourceIp, passkey\.user_id\)/);
  assert.match(authRoutes, /"\/totp-ip-blocks\/:ipAddress",\s*requireAuthAllowTotpIpBlock,\s*accountReauthenticationRateLimit/);
  assert.match(authRoutes, /verifyPassword\(currentPassword, user\.password_hash\)/);
  assert.match(collaborationServer, /isPermanentlyBlockedTotpIp\(sourceIp, payload\.sub\)/);
  assert.match(collaborationServer, /isPermanentlyBlockedTotpIp\(client\.ipAddress, client\.user\.id\)/);
});
