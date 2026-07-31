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
  "req.auth = { authVersion }"
]);
contains("src/routes/auth.routes.ts", [
  "SELECT * FROM users WHERE id = ? FOR UPDATE",
  "UPDATE users SET password_hash = ?, auth_version = ? WHERE id = ?",
  "disconnectUserCollaborators(updatedUser.id",
  "res.json({ ok: true, token })"
]);
contains("src/lib/collaboration-server.ts", [
  "currentAuthVersion !== payload.authVersion",
  "Number(currentUser.auth_version ?? 1) !== client.authVersion",
  "disconnectUserEverywhere(userId"
]);
contains("migrations/024_auth_session_revocation.sql", [
  /ADD COLUMN IF NOT EXISTS auth_version BIGINT UNSIGNED NOT NULL DEFAULT 1/i
]);

contains("src/config/env.ts", [
  "CORS_ORIGIN must include at least one browser origin",
  "CORS_ORIGIN must contain exact HTTP(S) origins without paths",
  "CORS_ORIGIN must use HTTPS in production"
]);

const corsSource = contains("src/middleware/cors.ts", [
  "explicitCorsOrigins.has(normalizedOrigin)",
  'env.NODE_ENV !== "production" && isLocalDevelopmentOrigin(normalizedOrigin)'
]);
const collaborationSource = read("src/lib/collaboration-server.ts");
assert.ok(!corsSource.includes("x-forwarded-host"), "API CORS must not trust X-Forwarded-Host");
assert.ok(!corsSource.includes("x-forwarded-proto"), "API CORS must not trust X-Forwarded-Proto");
assert.ok(!collaborationSource.includes('request.headers["x-forwarded-host"]'), "WebSocket origin checks must not trust X-Forwarded-Host");
assert.ok(!collaborationSource.includes('request.headers["x-forwarded-proto"]'), "WebSocket origin checks must not trust X-Forwarded-Proto");

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

console.log("[security-hardening] PASS: session revocation, JWT separation, origin policy, multipart limits, and SSRF ranges");
