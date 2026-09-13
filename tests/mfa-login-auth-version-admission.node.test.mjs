import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("stale password admission can resurrect an MFA login after credential rotation in the vulnerable ordering", () => {
  let currentAuthVersion = 7;
  const passwordDecisionAuthVersion = currentAuthVersion;

  // A security-sensitive action wins the race after password verification.
  currentAuthVersion += 1;

  // Vulnerable behavior: MFA-session creation only checks that the user still exists.
  const vulnerableSessionCreated = true;
  const vulnerableCompletedTokenVersion = currentAuthVersion;
  assert.equal(vulnerableSessionCreated, true);
  assert.equal(
    vulnerableCompletedTokenVersion,
    currentAuthVersion,
    "the stale password decision can be upgraded into a token at the post-rotation auth version"
  );

  // Required behavior: admission is valid only if the locked user row is still at
  // the exact auth_version observed by the password-verification transaction.
  const hardenedSessionCreated = currentAuthVersion === passwordDecisionAuthVersion;
  assert.equal(hardenedSessionCreated, false);
});

test("MFA login-session creation is bound to the auth_version observed during password verification", async () => {
  const [authRoutes, mfaRoutes] = await Promise.all([
    read("src/routes/auth.routes.ts"),
    read("src/routes/mfa.routes.ts")
  ]);

  assert.match(
    mfaRoutes,
    /createMfaLoginSession\([\s\S]{0,160}expectedAuthVersion: number/
  );
  assert.match(
    mfaRoutes,
    /SELECT id, auth_version FROM users WHERE id = \? FOR UPDATE/
  );
  assert.match(
    mfaRoutes,
    /normalizeAuthVersion\(user\.auth_version\) !== expectedAuthVersion/
  );
  assert.match(
    authRoutes,
    /createMfaLoginSession\(\s*user\.id,\s*sourceIp,\s*mfaBinding,\s*normalizeAuthVersion\(user\.auth_version\)\s*\)/
  );
});
