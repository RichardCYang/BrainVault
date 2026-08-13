import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("discoverable-passkey login keeps the WebAuthn ceremony server-authoritative", async () => {
  const route = await read("src/routes/passkey-login.routes.ts");
  const cookie = await read("src/lib/passkey-ceremony-cookie.ts");
  const migration = await read("migrations/040_passkey_direct_login.sql");
  const app = await read("src/app.ts");

  assert.match(route, /allowCredentials:\s*\[\]/);
  assert.match(route, /userVerification:\s*"required"/);
  assert.match(route, /requireUserVerification:\s*true/);
  assert.match(route, /expectedChallenge:\s*challenge\.challenge/);
  assert.match(route, /expectedOrigin:\s*webAuthnConfig\.origins/);
  assert.match(route, /expectedRPID:\s*webAuthnConfig\.rpID/);
  assert.match(route, /SET used_at = CURRENT_TIMESTAMP\(3\)/);
  assert.match(route, /opaqueTokenPattern = \/\^\[A-Za-z0-9_\-\]\{43\}\$\//);
  assert.match(route, /maxClientExtensionResultsBytes = 8 \* 1024/);
  assert.match(route, /maxClientExtensionNodes = 256/);
  assert.match(route, /directPasskeyResponseSchema[\s\S]*?\.strict\(\)/);
  assert.match(route, /verifySchema[\s\S]*?\.strict\(\)/);
  assert.match(route, /function hasStrictDirectPasskeyShape/);
  assert.match(route, /if \(!hasStrictDirectPasskeyShape\(req\.body\)\) throw loginFailure\(\)/);
  assert.ok(
    route.indexOf("consumePasskeyLoginChallenge(challengeToken, binding)")
      < route.indexOf("verifySchema.safeParse(req.body)"),
    "a valid one-time token must be consumed before full response validation"
  );
  assert.match(route, /decodeBase64UrlStrict\(response\.id/);
  assert.match(route, /equalBytes\(credentialId, rawCredentialId\)/);
  assert.match(route, /equalBytes\(userHandle, passkey\.webauthn_user_id\)/);
  assert.match(route, /assertStablePasskey/);
  assert.match(route, /previousCounter > 0 && newCounter <= previousCounter/);
  assert.match(route, /PASSKEY_LOGIN_FAILED/);

  assert.match(cookie, /httpOnly:\s*true/);
  assert.match(cookie, /sameSite:\s*"strict"/);
  assert.match(cookie, /__Host-brainvault_passkey_ceremony/);
  assert.match(cookie, /readUniqueCookieValue/);

  assert.match(migration, /token_hash CHAR\(64\) PRIMARY KEY/);
  assert.match(migration, /binding_hash CHAR\(64\) NOT NULL/);
  assert.match(migration, /expires_at DATETIME\(3\) NOT NULL/);
  assert.match(migration, /used_at DATETIME\(3\) NULL/);
  assert.doesNotMatch(migration, /user_id\s+VARCHAR/);

  assert.match(
    app,
    /app\.use\("\/api\/auth\/passkey", express\.json\(\{ limit: "64kb" \}\)\)/
  );
  assert.match(
    app,
    /app\.use\("\/api\/auth\/mfa\/login\/passkey", express\.json\(\{ limit: "64kb" \}\)\)/
  );
});

test("new passkeys are discoverable and legacy WebAuthn boundaries are canonical", async () => {
  const route = await read("src/routes/mfa.routes.ts");

  assert.match(route, /residentKey:\s*"required"/);
  assert.match(route, /function decodeBase64UrlStrict/);
  assert.match(route, /function assertMatchingCredentialIds/);
  assert.match(route, /maxClientExtensionResultsBytes = 8 \* 1024/);
  assert.match(route, /clientExtensionResultsSchema/);
  assert.ok(
    (route.match(/assertMatchingCredentialIds\(response,/g) ?? []).length >= 2,
    "registration and MFA passkey authentication must both validate id/rawId"
  );
  assert.match(route, /equalBytes\(userHandle, passkey\.webauthn_user_id\)/);
  assert.match(route, /Number\.isSafeInteger\(previousCounter\)/);
  assert.match(route, /Number\.isSafeInteger\(newCounter\)/);
});

test("the standalone reproduction rejects every modeled attack", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-passkey-direct-login.mjs", import.meta.url))],
    { encoding: "utf8" }
  );
  const report = JSON.parse(output);

  assert.equal(report.schemaVersion, 2);
  assert.equal(report.cryptographicVerification.validP256AssertionAccepted, true);
  assert.equal(report.cryptographicVerification.counterAdvanced, true);
  assert.equal(report.cryptographicVerification.tamperedSignatureRejected, true);
  assert.equal(report.allPassed, true);
  for (const [name, passed] of Object.entries(report.attackReproductions)) {
    assert.equal(passed, true, `${name} was not rejected`);
  }
  for (const [name, passed] of Object.entries(report.staticContract)) {
    assert.equal(passed, true, `${name} source invariant is missing`);
  }
});
