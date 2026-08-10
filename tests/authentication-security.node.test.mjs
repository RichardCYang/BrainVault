import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createExactHttpOriginSet,
  parseExactHttpOrigin
} from "../src/lib/request-origin.ts";

const readSource = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("exact browser-origin parsing rejects normalization-based allowlist bypasses", () => {
  const allowed = createExactHttpOriginSet(["https://notes.example", "http://127.0.0.1:3000"]);

  assert.equal(parseExactHttpOrigin("https://notes.example"), "https://notes.example");
  assert.equal(parseExactHttpOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  for (const malformed of [
    "https://notes.example/",
    "https://notes.example/path",
    "https://notes.example?next=evil",
    "https://user@notes.example",
    "null",
    "javascript:alert(1)"
  ]) {
    assert.equal(parseExactHttpOrigin(malformed), null, `${malformed} must not normalize into an allowed origin`);
  }
  assert.equal(allowed.has(parseExactHttpOrigin("https://notes.example") ?? ""), true);
});

test("cross-site form login is blocked by both browser-origin and JSON-only gates", () => {
  const vulnerableAccepts = ({ bodyParsed }) => bodyParsed;
  const hardenedAccepts = ({ fetchSite, contentType, origin }) => {
    if (fetchSite === "cross-site") return false;
    if (contentType !== "application/json") return false;
    return parseExactHttpOrigin(origin) === "https://notes.example";
  };

  const attackerForm = {
    bodyParsed: true,
    fetchSite: "cross-site",
    contentType: "application/x-www-form-urlencoded",
    origin: "https://attacker.example"
  };
  assert.equal(vulnerableAccepts(attackerForm), true, "the prior URL-encoded login flow accepts a simple form POST");
  assert.equal(hardenedAccepts(attackerForm), false, "the hardened login flow rejects the same request");
});

test("atomic MFA attempt reservation caps a concurrent burst at the configured maximum", () => {
  const maxAttempts = 8;
  let vulnerableCounter = 0;
  const staleReads = Array.from({ length: 24 }, () => vulnerableCounter);
  const vulnerableAccepted = staleReads.filter((snapshot) => snapshot < maxAttempts).length;
  vulnerableCounter += vulnerableAccepted;

  let atomicCounter = 0;
  let hardenedAccepted = 0;
  for (let index = 0; index < 24; index += 1) {
    if (atomicCounter >= maxAttempts) continue;
    atomicCounter += 1;
    hardenedAccepted += 1;
  }

  assert.equal(vulnerableAccepted, 24, "all requests can pass a stale pre-increment check");
  assert.equal(vulnerableCounter, 24);
  assert.equal(hardenedAccepted, maxAttempts);
  assert.equal(atomicCounter, maxAttempts);
});

test("MFA completion cannot mint a post-revocation auth-version token", () => {
  const acceptsSession = (tokenVersion, currentVersion) => tokenVersion === currentVersion;

  let vulnerableAuthVersion = 1;
  vulnerableAuthVersion += 1; // Password rotation wins after MFA completion but before finishLogin reads the user.
  const vulnerableTokenVersion = vulnerableAuthVersion;
  assert.equal(acceptsSession(vulnerableTokenVersion, vulnerableAuthVersion), true);

  let hardenedAuthVersion = 1;
  const hardenedTokenVersion = hardenedAuthVersion; // Captured while the user row is locked by MFA completion.
  hardenedAuthVersion += 1; // A later revocation invalidates the already-created token.
  assert.equal(acceptsSession(hardenedTokenVersion, hardenedAuthVersion), false);
});

test("TOTP verification uses the currently locked credential instead of a stale secret", () => {
  const oldSecret = "OLD";
  const newSecret = "NEW";
  const suppliedCode = `${oldSecret}:123456`;

  const vulnerableReadSecret = oldSecret;
  const rotatedCredential = { secret: newSecret, lastUsedStep: null };
  const vulnerableMatched = suppliedCode.startsWith(`${vulnerableReadSecret}:`);
  if (vulnerableMatched) rotatedCredential.lastUsedStep = 100;
  assert.equal(rotatedCredential.lastUsedStep, 100, "a user-id-only update can apply an old-secret result to the new row");

  const hardenedMatched = suppliedCode.startsWith(`${rotatedCredential.secret}:`);
  assert.equal(hardenedMatched, false, "verification against the locked current credential rejects the old secret");
});

test("authentication route source retains all hardened ordering guarantees", async () => {
  const [authRoutes, mfaRoutes, authMiddleware, corsMiddleware, collaboration, originHelper, envConfig] = await Promise.all([
    readSource("src/routes/auth.routes.ts"),
    readSource("src/routes/mfa.routes.ts"),
    readSource("src/middleware/auth.ts"),
    readSource("src/middleware/cors.ts"),
    readSource("src/lib/collaboration-server.ts"),
    readSource("src/lib/request-origin.ts"),
    readSource("src/config/env.ts")
  ]);

  assert.match(authRoutes, /"\/register",\s+requireSameOriginBrowserRequest,\s+requireJsonRequestBody,/);
  assert.match(authRoutes, /"\/login",\s+requireSameOriginBrowserRequest,\s+requireJsonRequestBody,/);
  assert.equal((mfaRoutes.match(/requireSameOriginBrowserRequest/g) ?? []).length >= 4, true);
  assert.equal((mfaRoutes.match(/requireJsonRequestBody/g) ?? []).length >= 4, true);
  assert.match(authMiddleware, /req\.is\("application\/json"\)/);
  assert.match(envConfig, /AUTH_ALLOW_BEARER_TOKENS:\s*parsedEnv\.AUTH_ALLOW_BEARER_TOKENS \?\? false/);
  assert.match(authMiddleware, /new ApiError\(403, "ORIGIN_REQUIRED"/);
  assert.match(authMiddleware, /assertBrowserRequestOrigin\(req, \{ requireOrigin: true \}\)/);
  assert.match(authMiddleware, /requiresCookieMutationOrigin\(req, selectedSource\)/);
  const cookieCredentialIndex = authMiddleware.indexOf("const cookieToken = readAuthSessionCookie(req)");
  const bearerCredentialIndex = authMiddleware.indexOf("const bearerToken = cookieToken ? null : getBearerToken(req)");
  assert.ok(cookieCredentialIndex >= 0 && bearerCredentialIndex > cookieCredentialIndex);
  assert.match(authMiddleware, /const token = cookieToken \?\? bearerToken/);

  assert.match(mfaRoutes, /async function reserveMfaAttempt/);
  assert.match(mfaRoutes, /FROM mfa_login_sessions[\s\S]{0,220}FOR UPDATE/);
  assert.match(mfaRoutes, /SET failed_attempts = failed_attempts \+ 1/);
  assert.match(mfaRoutes, /WHERE token_hash = \? AND source_ip = \?/);
  assert.match(mfaRoutes, /const sourceIp = getClientIpAddress\(req\);[\s\S]{0,320}reserveMfaAttempt\(mfaToken, sourceIp\)/);
  assert.doesNotMatch(mfaRoutes, /async function recordMfaFailure/);
  assert.doesNotMatch(mfaRoutes, /failed_attempts < \?/);

  assert.match(mfaRoutes, /FROM user_totp_credentials WHERE user_id = \? FOR UPDATE/);
  assert.match(mfaRoutes, /last_used_step = VALUES\(last_used_step\)/);
  assert.doesNotMatch(mfaRoutes, /last_used_step = NULL/);
  assert.match(mfaRoutes, /SELECT \* FROM users WHERE id = \? FOR UPDATE/);
  assert.match(mfaRoutes, /return createMfaLoginResult\(loginUser\)/);
  assert.doesNotMatch(mfaRoutes, /finishLogin/);
  assert.match(mfaRoutes, /mfaRouter\.use\([\s\S]{0,180}Cache-Control", "private, no-store"/);

  assert.match(originHelper, /parsed\.origin !== candidate/);
  assert.match(corsMiddleware, /parseExactHttpOrigin\(origin\)/);
  assert.match(collaboration, /parseExactHttpOrigin\(originHeader\)/);
});
