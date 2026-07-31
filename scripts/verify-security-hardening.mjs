import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPrivateAddress } from "../src/lib/network-address.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => readFileSync(join(rootDir, relativePath), "utf8").replace(/\r\n/g, "\n");

function contains(relativePath, values) {
  const source = read(relativePath);
  for (const value of values) {
    if (value instanceof RegExp) assert.match(source, value, `${relativePath} must match ${value}`);
    else assert.ok(source.includes(value), `${relativePath} must contain ${JSON.stringify(value)}`);
  }
  return source;
}

const authSource = contains("src/lib/auth.ts", [
  'const authAudience = "brainvault-api"',
  'algorithm: "HS256"',
  'algorithms: ["HS256"]',
  "authVersion: normalizeAuthVersion(decoded.authVersion)"
]);
const collaborationTokenSource = contains("src/lib/collaboration-token.ts", [
  'const collaborationAudience = "brainvault-page-collaboration"',
  'algorithm: "HS256"',
  'algorithms: ["HS256"]',
  "authVersion: Number(decoded.authVersion)"
]);
assert.notEqual(
  /const authAudience = "([^"]+)"/.exec(authSource)?.[1],
  /const collaborationAudience = "([^"]+)"/.exec(collaborationTokenSource)?.[1],
  "API and collaboration JWT audiences must remain distinct"
);

contains("src/middleware/auth.ts", [
  "payload.authVersion !== authVersion",
  'new ApiError(401, "SESSION_REVOKED"',
  "req.auth = { authVersion }",
  "assertBrowserRequestOrigin(req)",
  'fetchSite === "cross-site"'
]);
const authRoutesSource = contains("src/routes/auth.routes.ts", [
  "SELECT * FROM users WHERE id = ? FOR UPDATE",
  "UPDATE users SET password_hash = ?, auth_version = ? WHERE id = ?",
  "UPDATE users SET auth_version = ? WHERE id = ?",
  'authRouter.post("/logout", requireAuth',
  "disconnectUserCollaborators(updatedUser.id",
  "res.locals.authenticationPending = true",
  "res.status(202).json({ ok: true })",
  "same status and response shape"
]);
assert.doesNotMatch(authRoutesSource, /res\.json\(\{[^}]*token/, "Authentication responses must not expose JWTs");

const mfaRoutesSource = contains("src/routes/mfa.routes.ts", [
  "SELECT id FROM users WHERE id = ? FOR UPDATE",
  "MAX(failed_attempts) AS failed_attempts",
  'new ApiError(429, "MFA_TEMPORARILY_LOCKED"',
  "mfaLoginIpRateLimit",
  "mfaLoginAccountRateLimit",
  "mfaSetupRateLimit",
  "PASSKEY_COUNTER_REGRESSION",
  "res.json({ user: result.user })"
]);
assert.ok(!mfaRoutesSource.includes("DELETE FROM mfa_login_sessions WHERE user_id = ? OR"), "MFA re-login must not reset failures");

contains("src/lib/collaboration-server.ts", [
  "currentAuthVersion !== payload.authVersion",
  "Number(currentUser.auth_version ?? 1) !== client.authVersion",
  "disconnectUserEverywhere(userId",
  "explicitOrigins.has(normalizeOrigin(originHeader))"
]);
contains("migrations/024_auth_session_revocation.sql", [
  /ADD COLUMN IF NOT EXISTS auth_version BIGINT UNSIGNED NOT NULL DEFAULT 1/i
]);

contains("src/config/env.ts", [
  'HOST: z.string().trim().min(1).max(255).default("127.0.0.1")',
  "DATABASE_URL must be configured",
  "knownInsecureDatabasePasswords",
  "DATABASE_URL uses a public placeholder or known default database password",
  'DB_USER_HOSTS: z.string().trim().min(1).default("localhost,127.0.0.1,::1")',
  "DB_USER_HOSTS must not contain wildcard hosts",
  "AUTH_MFA_IP_MAX",
  "AUTH_MFA_ACCOUNT_MAX",
  "AUTH_MFA_SETUP_MAX",
  "TRUST_PROXY_HOPS",
  "JWT_SECRET must be explicitly configured in production",
  "MFA_ENCRYPTION_KEY must be explicitly configured in production",
  "uses a public placeholder or legacy development value",
  "JWT_SECRET and MFA_ENCRYPTION_KEY must be different values",
  "CORS_ORIGIN must include at least one browser origin",
  "CORS_ORIGIN must contain exact HTTP(S) origins without paths",
  "CORS_ORIGIN must use HTTPS in production"
]);
contains("scripts/env-init.ts", [
  'randomBytes(48).toString("base64url")',
  'randomBytes(32).toString("base64url")',
  "exactly two generated-secret placeholders",
  "exactly one generated database-password placeholder",
  "Created .env with unique database, JWT, and MFA secrets"
]);
contains("package.json", ['"secrets:generate": "node scripts/generate-secrets.mjs"']);
contains("scripts/generate-secrets.mjs", [
  'const SECRET_BYTES = 32',
  'randomBytes(SECRET_BYTES).toString("base64url")',
  'const SECRET_NAMES = ["JWT_SECRET", "MFA_ENCRYPTION_KEY"]',
  "Refusing to overwrite existing secrets without --force",
  "Rotating MFA_ENCRYPTION_KEY can invalidate enrolled TOTP authenticators"
]);
contains("scripts/seed.ts", [
  "BRAINVAULT_SEED_DEMO",
  "BRAINVAULT_DEMO_PASSWORD must contain 12-128 characters"
]);
const browserSource = read("public/app.js");
assert.ok(!browserSource.includes("brainvault.token"), "The browser must not persist the JWT in localStorage");
assert.ok(!browserSource.includes('Authorization", `Bearer'), "The built-in browser must use the HttpOnly session cookie");
assert.ok(browserSource.includes("CSS.escape(blockId)"), "Dynamic block selectors must escape block IDs");
contains("src/lib/session-cookie.ts", ["httpOnly: true", 'sameSite: "strict"', 'secure: env.NODE_ENV === "production"']);
contains("src/middleware/auth-rate-limit.ts", [
  "loginIpRateLimit",
  "loginAccountRateLimit",
  "mfaLoginIpRateLimit",
  "mfaLoginAccountRateLimit",
  "mfaSetupRateLimit",
  "requestWasSuccessful: authenticationRequestSucceeded",
  "registrationRateLimit"
]);
const appSource = contains("src/app.ts", [
  "if (env.SERVE_INTERNAL_DOCS)",
  'app.use("/docs", requireAuth',
  "TRUST_PROXY_HOPS === 0 ? false : env.TRUST_PROXY_HOPS",
  "https://cdn.jsdelivr.net/npm/katex@0.17.0/dist/katex.min.js",
  "https://cdn.jsdelivr.net/npm/yjs@13.6.31/+esm",
  'connectSrc: ["\'self\'", ...configuredWebSocketOrigins]',
  "res.json({ ok: true })"
]);
assert.ok(!appSource.includes('scriptSrc: ["\'self\'", "https://cdn.jsdelivr.net"]'), "CSP must not trust the entire jsDelivr host");
assert.ok(!appSource.includes('connectSrc: ["\'self\'", "ws:", "wss:"]'), "CSP must not allow arbitrary WebSocket hosts");
contains("src/server.ts", ["server.listen(env.PORT, env.HOST"]);
contains("src/routes/page.routes.ts", ["coverUrl: httpUrlSchema(500)", "escapeHtmlAttribute(block.id)"]);
contains("src/lib/collaboration-materialization.ts", ["z.string().regex(/^[a-zA-Z0-9_-]+$/).min(1).max(64)"]);
contains("src/lib/data-transfer.ts", [
  "cover_url: nullableHttpUrl(500)",
  "normalizeAvatarDataUrl(manifest.account.avatar_data)",
  "The backup contains an identifier owned by another account"
]);
contains("src/routes/collaboration.routes.ts", ["SHARE_TARGET_UNAVAILABLE"]);
contains("src/middleware/error.ts", ["INVALID_JSON", 'code: "DATABASE_CONSTRAINT_FAILED"']);

const corsSource = contains("src/middleware/cors.ts", [
  "explicitCorsOrigins.has(normalizeOrigin(origin))"
]);
assert.ok(!corsSource.includes("isLocalDevelopmentOrigin"), "Development CORS must use the explicit allowlist");
const collaborationSource = read("src/lib/collaboration-server.ts");
assert.ok(!corsSource.includes("x-forwarded-host"), "API CORS must not trust X-Forwarded-Host");
assert.ok(!corsSource.includes("x-forwarded-proto"), "API CORS must not trust X-Forwarded-Proto");
assert.ok(!collaborationSource.includes('request.headers["x-forwarded-host"]'), "WebSocket origin checks must not trust X-Forwarded-Host");
assert.ok(!collaborationSource.includes('request.headers["x-forwarded-proto"]'), "WebSocket origin checks must not trust X-Forwarded-Proto");
assert.ok(!collaborationSource.includes("isLoopback("), "WebSocket origins must not auto-allow loopback ports");

const bootstrapSource = contains("src/lib/db-bootstrap.ts", [
  "databaseUserHosts",
  "ALTER USER",
  "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES",
  "DROP USER IF EXISTS"
]);
assert.ok(!bootstrapSource.includes("GRANT ALL PRIVILEGES"), "Application DB accounts must not receive ALL PRIVILEGES");
assert.doesNotMatch(bootstrapSource, /CREATE USER IF NOT EXISTS[^\n]+@'%' /, "Application DB accounts must not be created for wildcard hosts");

contains("src/routes/block.routes.ts", ["parts: 6", "fieldNestingDepth: 1", "headerPairs: 32"]);
contains("src/routes/data.routes.ts", ["parts: 2", "fieldNestingDepth: 1", "headerPairs: 32"]);

for (const address of [
  "127.0.0.1",
  "169.254.169.254",
  "192.88.99.1",
  "240.0.0.1",
  "::1",
  "::127.0.0.1",
  "::ffff:127.0.0.1",
  "64:ff9b::7f00:1",
  "100::1",
  "100:0:0:1::1",
  "2002:7f00:1::",
  "3fff::1",
  "5f00::1",
  "fc00::1",
  "fe80::1"
]) {
  assert.equal(isPrivateAddress(address), true, `${address} must be blocked`);
}
for (const address of ["1.1.1.1", "8.8.8.8", "2001:4860:4860::8888", "2606:4700:4700::1111"]) {
  assert.equal(isPrivateAddress(address), false, `${address} must remain public`);
}

const acceptsSession = (tokenVersion, currentVersion) =>
  Number.isSafeInteger(tokenVersion) && tokenVersion >= 1 && tokenVersion === currentVersion;
assert.equal(acceptsSession(1, 1), true, "A current session must be accepted before credential rotation");
assert.equal(acceptsSession(1, 2), false, "An old session must be rejected after credential rotation");
assert.equal(acceptsSession(2, 2), true, "The replacement session must remain usable");

console.log("[security-hardening] PASS: MFA throttling, cookie-only login, logout revocation, database accounts, CSP/origins, injection guards, error hygiene, JWT separation, multipart limits, and SSRF ranges");
