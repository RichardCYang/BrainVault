import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("MFA credential changes rotate the authentication boundary atomically", async () => {
  const source = await read("src/routes/mfa.routes.ts");

  assert.match(source, /SELECT \* FROM users WHERE id = \? FOR UPDATE/);
  assert.match(source, /normalizeAuthVersion\(user\.auth_version\) !== expectedAuthVersion/);
  assert.match(source, /async function rotateAuthenticationCredentials/);
  assert.match(source, /UPDATE users SET auth_version = \? WHERE id = \?/);
  assert.match(source, /DELETE FROM mfa_login_sessions WHERE user_id = \?/);
  assert.match(source, /DELETE FROM webauthn_challenges WHERE user_id = \?/);
  assert.match(source, /DELETE FROM mfa_totp_setups WHERE user_id = \?/);
  assert.match(source, /function issueRotatedAuthenticationSession/);
  assert.match(source, /disconnectUserCollaborators\(user\.id, "Authentication credentials changed"\)/);
  assert.ok(
    (source.match(/issueRotatedAuthenticationSession\(res,/g) ?? []).length >= 4,
    "TOTP verification/removal and passkey registration/removal must issue a replacement cookie"
  );
  assert.match(source, /authVersion: expectedAuthVersion/);
  assert.match(source, /Number\(metadata\.authVersion\) !== expectedAuthVersion/);
});

test("current-password operations have an account-scoped throttle", async () => {
  const limiter = await read("src/middleware/auth-rate-limit.ts");
  const authRoutes = await read("src/routes/auth.routes.ts");
  const mfaRoutes = await read("src/routes/mfa.routes.ts");

  assert.match(limiter, /function accountReauthenticationKey/);
  assert.match(limiter, /hashRateLimitKey\("account-reauthentication", userId\)/);
  assert.match(limiter, /export const accountReauthenticationRateLimit = rateLimit/);
  assert.match(limiter, /windowMs: env\.AUTH_MFA_SETUP_WINDOW_MS/);
  assert.match(limiter, /limit: env\.AUTH_MFA_SETUP_MAX/);
  assert.match(authRoutes, /"\/password",\s+requireAuth,\s+accountReauthenticationRateLimit,/);
  assert.ok(
    (mfaRoutes.match(/accountReauthenticationRateLimit/g) ?? []).length >= 5,
    "all MFA operations that accept the current password must share the account limiter"
  );
});

test("password change and logout reject stale requests and clear pending authentication state", async () => {
  const source = await read("src/routes/auth.routes.ts");

  assert.match(source, /function assertAuthenticationVersion/);
  assert.ok(
    (source.match(/assertAuthenticationVersion\(user, expectedAuthVersion\)/g) ?? []).length >= 2,
    "password change and logout must revalidate auth_version under the user row lock"
  );
  assert.ok(
    (source.match(/DELETE FROM mfa_totp_setups WHERE user_id = \?/g) ?? []).length >= 2,
    "password change and logout must invalidate unfinished TOTP enrollment"
  );
});

test("the global limiter executes before request-body parsing", async () => {
  const source = await read("src/app.ts");
  const limiterIndex = source.indexOf("rateLimit({");
  const jsonParserIndex = source.indexOf("express.json({ limit: \"5mb\" })");
  const urlencodedParserIndex = source.indexOf("express.urlencoded({ extended: false })");

  assert.ok(limiterIndex >= 0, "global rate limiter is missing");
  assert.ok(limiterIndex < jsonParserIndex, "JSON parsing must not precede the global limiter");
  assert.ok(limiterIndex < urlencodedParserIndex, "form parsing must not precede the global limiter");
});

test("the browser fences responses started under the replaced cookie", async () => {
  const source = await read("public/app.js");

  assert.match(source, /function acceptRotatedAuthenticationSession\(\)/);
  assert.match(source, /authenticationSessionGeneration \+= 1/);
  assert.ok(
    (source.match(/acceptRotatedAuthenticationSession\(\);/g) ?? []).length >= 5,
    "password and MFA credential changes must accept the replacement cookie generation"
  );
});

test("standalone reproduction demonstrates vulnerable and remediated outcomes", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-authentication-credential-boundary.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.stolenSessionSurvivesFactorChange, true);
  assert.equal(result.fixed.stolenSessionSurvivesFactorChange, false);
  assert.equal(result.fixed.replacementSessionIsValid, true);
  assert.equal(result.vulnerable.passwordOnlyLoginSurvivesMfaEnrollment, true);
  assert.equal(result.fixed.passwordOnlyLoginSurvivesMfaEnrollment, false);
  assert.equal(result.vulnerable.stalePasskeyCommitCrossesPasswordChange, true);
  assert.equal(result.fixed.stalePasskeyCommitRejected, true);
  assert.equal(result.fixed.stalePasskeyCommitCrossesPasswordChange, false);
  assert.equal(result.vulnerable.staleTotpSetupSurvivesPasswordChange, true);
  assert.equal(result.fixed.staleTotpSetupSurvivesPasswordChange, false);
  assert.equal(result.vulnerable.distributedCurrentPasswordAttempts, 1_440);
  assert.equal(result.fixed.accountScopedCurrentPasswordAttempts, 10);
  assert.equal(result.vulnerable.rejectedBodyBytesParsedBeforeRateLimit, 131_072_000);
  assert.equal(result.fixed.rejectedBodyBytesParsedBeforeRateLimit, 0);
});
