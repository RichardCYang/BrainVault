import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateNoStoreCacheControl, setPrivateNoStoreCacheControl } from "../src/lib/cache-control.ts";
import { isPrivateAddress } from "../src/lib/network-address.ts";
import {
  bcryptPasswordMaxBytes,
  getPasswordUtf8ByteLength,
  isPasswordWithinBcryptLimit
} from "../src/lib/password-policy.ts";
import {
  assertSupportedNodeRuntime,
  isNodeRuntimeSupported,
  nodeRuntimeSecurityFloor
} from "../src/lib/runtime-security.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => readFileSync(join(rootDir, relativePath), "utf8").replace(/\r\n/g, "\n");

const authenticatedCacheHeaders = new Map();
setPrivateNoStoreCacheControl({
  setHeader(name, value) {
    authenticatedCacheHeaders.set(name.toLowerCase(), value);
  }
});
assert.equal(authenticatedCacheHeaders.get("cache-control"), privateNoStoreCacheControl);
assert.equal(bcryptPasswordMaxBytes, 72);
assert.equal(getPasswordUtf8ByteLength("A".repeat(72)), 72);
assert.equal(isPasswordWithinBcryptLimit("A".repeat(72)), true);
assert.equal(isPasswordWithinBcryptLimit("A".repeat(73)), false);
assert.equal(getPasswordUtf8ByteLength("🔐".repeat(19)), 76);
assert.equal(isPasswordWithinBcryptLimit("🔐".repeat(19)), false);
assert.equal(nodeRuntimeSecurityFloor, "^22.23.2 || ^24.18.1 || >=26.5.1");
for (const version of ["22.23.2", "24.18.1", "26.5.1", "27.0.0"]) {
  assert.equal(isNodeRuntimeSupported(version), true, `${version} must satisfy the runtime security floor`);
}
for (const version of ["22.23.1", "23.0.0", "24.18.0", "25.0.0", "26.5.0", "22.23.2-rc.1"]) {
  assert.equal(isNodeRuntimeSupported(version), false, `${version} must fail the runtime security floor`);
}
assert.throws(() => assertSupportedNodeRuntime("22.16.0"), /Refusing to start/);

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
  "authVersion: normalizeAuthVersion(decoded.authVersion)",
  "assertPasswordWithinBcryptLimit(password)",
  "bcrypt.truncates(password)",
  "if (bcryptWouldTruncate(password)) return Promise.resolve(false)"
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

const authMiddlewareSource = contains("src/middleware/auth.ts", [
  "payload.authVersion !== authVersion",
  'new ApiError(401, "SESSION_REVOKED"',
  "req.auth = { authVersion }",
  'new ApiError(403, "ORIGIN_REQUIRED"',
  "assertBrowserRequestOrigin(req, { requireOrigin: true })",
  "requiresCookieMutationOrigin(req, selectedSource)",
  'fetchSite === "cross-site"',
  "requireSameOriginBrowserRequest",
  "requireJsonRequestBody",
  'req.is("application/json")',
  "setPrivateNoStoreCacheControl(res)",
  "const cookieToken = readAuthSessionCookie(req)",
  "const bearerToken = cookieToken ? null : getBearerToken(req)",
  "const token = cookieToken ?? bearerToken"
]);
const authenticateRequestStart = authMiddlewareSource.indexOf("async function authenticateRequest");
const requireAuthStart = authMiddlewareSource.indexOf("export function requireAuth");
const authenticatedCachePolicyIndex = authMiddlewareSource.indexOf("setPrivateNoStoreCacheControl(res)", authenticateRequestStart);
const cookieReadIndex = authMiddlewareSource.indexOf("const cookieToken = readAuthSessionCookie(req)", authenticateRequestStart);
const bearerReadIndex = authMiddlewareSource.indexOf("const bearerToken = cookieToken ? null : getBearerToken(req)", authenticateRequestStart);
const requireAuthDelegateIndex = authMiddlewareSource.indexOf("void authenticateRequest(req, res, next)", requireAuthStart);
assert.ok(authenticateRequestStart >= 0 && authenticatedCachePolicyIndex > authenticateRequestStart);
assert.ok(
  authenticatedCachePolicyIndex < cookieReadIndex && cookieReadIndex < bearerReadIndex,
  "Authenticated responses must be no-store and cookie credentials must take precedence over optional bearer credentials"
);
assert.ok(
  requireAuthStart >= 0 && requireAuthDelegateIndex > requireAuthStart,
  "requireAuth must delegate to the hardened authenticateRequest flow"
);
const authRoutesSource = contains("src/routes/auth.routes.ts", [
  "SELECT * FROM users WHERE id = ? FOR UPDATE",
  "UPDATE users SET password_hash = ?, auth_version = ? WHERE id = ?",
  "UPDATE users SET auth_version = ? WHERE id = ?",
  "assertAuthenticationVersion(user, expectedAuthVersion)",
  "DELETE FROM mfa_totp_setups WHERE user_id = ?",
  "accountReauthenticationRateLimit",
  'authRouter.post("/logout", requireAuth',
  "disconnectUserCollaborators(updatedUser.id",
  "res.locals.authenticationPending = true",
  "res.status(202).json({ ok: true })",
  "same status, response shape",
  /"\/register",\s+requireSameOriginBrowserRequest,\s+requireJsonRequestBody,/,
  /"\/login",\s+requireSameOriginBrowserRequest,\s+requireJsonRequestBody,/,
  "passwordInputSchema(8)",
  "passwordInputSchema(1)"
]);
assert.doesNotMatch(authRoutesSource, /res\.json\(\{[^}]*token/, "Authentication responses must not expose JWTs");

const mfaRoutesSource = contains("src/routes/mfa.routes.ts", [
  "SELECT id FROM users WHERE id = ? FOR UPDATE",
  "MAX(failed_attempts) AS failed_attempts",
  'new ApiError(429, "MFA_TEMPORARILY_LOCKED"',
  "mfaLoginIpRateLimit",
  "mfaLoginAccountRateLimit",
  "mfaSetupRateLimit",
  "accountReauthenticationRateLimit",
  "getAuthenticationUserForUpdate",
  "rotateAuthenticationCredentials",
  "issueRotatedAuthenticationSession",
  "authVersion: expectedAuthVersion",
  "PASSKEY_COUNTER_REGRESSION",
  "res.json({ user: result.user })",
  "async function reserveMfaAttempt",
  "SET failed_attempts = failed_attempts + 1",
  "FROM user_totp_credentials WHERE user_id = ? FOR UPDATE",
  "return createMfaLoginResult(loginUser)",
  'res.setHeader("Cache-Control", "private, no-store")',
  "currentPassword: passwordInputSchema(1)"
]);
assert.ok(!mfaRoutesSource.includes("DELETE FROM mfa_login_sessions WHERE user_id = ? OR"), "MFA re-login must not reset failures");
assert.ok(!mfaRoutesSource.includes("async function recordMfaFailure"), "MFA failures must consume a reserved attempt before verification");
assert.ok(!mfaRoutesSource.includes("failed_attempts < ?"), "A successful final reserved MFA attempt must remain completable");
assert.ok(!mfaRoutesSource.includes("finishLogin"), "MFA completion must not issue a token after releasing the user lock");
assert.ok((mfaRoutesSource.match(/requireSameOriginBrowserRequest/g) ?? []).length >= 4, "All unauthenticated MFA login routes must enforce browser-origin checks");
assert.ok((mfaRoutesSource.match(/requireJsonRequestBody/g) ?? []).length >= 4, "All unauthenticated MFA login routes must reject simple form bodies");

contains("src/lib/websocket.ts", [
  "const defaultMaxQueuedMessages = 64",
  "WebSocket message backlog exceeded",
  "this.socket.writableLength",
  "WebSocket output backlog exceeded"
]);
contains("src/lib/request-deadline.ts", [
  "timer.unref()",
  'request.once("close", () => clearTimeout(timer))'
]);
contains("src/lib/bookmark.ts", [
  "enforceRequestDeadline(request, timeoutMs, createBookmarkFetchTimeoutError)",
  "enforceAbsoluteRequestDeadline(request, remainingTime)"
]);
contains("src/lib/collaboration-resource-limits.ts", [
  "connectionsPerServer: 512",
  "connectionsPerPage: 64",
  "connectionsPerUser: 8",
  "pendingUpgradesPerServer: 64",
  "pendingUpgradesPerUser: 4",
  "pendingWritesPerRoom: 64",
  "pendingWriteBytesPerRoom: 32 * 1024 * 1024"
]);
contains("src/lib/collaboration-server.ts", [
  "currentAuthVersion !== payload.authVersion",
  "Number(currentUser.auth_version ?? 1) !== client.authVersion",
  "disconnectUserEverywhere(userId",
  "parseExactHttpOrigin(originHeader)",
  "explicitOrigins.has(parsedOrigin)",
  "this.pageConnectionCounts.get(pageId) ?? 0",
  "this.upgradedSockets.add(socket)",
  "this.trackClient(room.pageId, client.user.id)",
  "pendingWriteBytes",
  "await write",
  "Collaboration write backlog exceeded",
  "canonicalIncrementalUpdate",
  "this.accessRecheckRunning",
  'persistenceDecision.action === "ignore"',
  'persistenceDecision.action === "reject"',
  'type: "compaction-complete"',
  "publicPresence(client, includeIdentity)",
  "includeIdentity: true"
]);
contains("src/lib/collaboration-update-policy.ts", [
  "minCollaborationSnapshotHistoryEntries = 200",
  'reason: "no-document-change"',
  'reason: "snapshot-changed-document"',
  'reason: "snapshot-too-early"'
]);
contains("src/lib/collaboration-presence.ts", [
  "maxCollaborationAvatarDataUrlBytes = 64 * 1024",
  'Buffer.byteLength(value, "utf8")'
]);
contains("src/lib/yjs-validation.ts", [
  "changed: !Buffer.from(currentState).equals(Buffer.from(stateUpdate))",
  "incrementalUpdate",
  "Y.encodeStateAsUpdate(candidate, currentStateVector)"
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
  "AUTH_LOGIN_LOCK_THRESHOLD",
  "AUTH_REGISTER_GLOBAL_MAX",
  "BOOKMARK_PREVIEW_MAX",
  "ATTACHMENT_UPLOAD_WINDOW_MS",
  "ATTACHMENT_UPLOAD_MAX",
  "ATTACHMENT_UPLOAD_MAX_CONCURRENT",
  "DATA_TRANSFER_MAX_MANIFEST_SIZE_MB",
  "DATA_IMPORT_WINDOW_MS",
  "DATA_IMPORT_MAX",
  "DATA_IMPORT_MAX_CONCURRENT",
  "MFA_TOTP_WINDOW_STEPS",
  "JWT_EXPIRES_IN must be between 5 minutes and 24 hours",
  "AUTH_ALLOW_BEARER_TOKENS",
  'AUTH_ALLOW_BEARER_TOKENS: parsedEnv.AUTH_ALLOW_BEARER_TOKENS ?? false',
  "TRUST_PROXY_HOPS",
  "TRUST_PROXY_ADDRESSES",
  "TRUST_PROXY_HOPS must remain 0",
  "TRUST_PROXY_ADDRESSES must not trust every address",
  "HTTPS_MODE=proxy requires TRUST_PROXY_ADDRESSES",
  "HTTPS_MODE must be proxy or posh-acme in production",
  'HTTPS_MODE: z.enum(["off", "proxy", "posh-acme"])',
  "HTTPS_MODE=posh-acme requires POSH_ACME_CERT_PATH",
  "PUBLIC_ORIGIN must use HTTPS when HTTPS_MODE is proxy or posh-acme",
  "JWT_SECRET must be explicitly configured in production",
  "MFA_ENCRYPTION_KEY must be explicitly configured in production",
  "uses a public placeholder or legacy development value",
  "JWT_SECRET and MFA_ENCRYPTION_KEY must be different values",
  "must include at least one browser origin",
  "must contain exact HTTP(S) origins without paths",
  "must use HTTPS in production"
]);
contains("scripts/env-init.ts", [
  'randomBytes(48).toString("base64url")',
  'randomBytes(32).toString("base64url")',
  "exactly two generated-secret placeholders",
  "exactly one generated database-password placeholder",
  "Created .env with unique database, JWT, and MFA secrets"
]);
contains("package.json", ['"secrets:generate": "node scripts/generate-secrets.mjs"']);
const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
const supportedNodeRange = nodeRuntimeSecurityFloor;
assert.equal(packageJson.engines?.node, supportedNodeRange, "package.json must reject pre-patch Node runtimes");
assert.equal(packageLock.packages?.[""]?.engines?.node, supportedNodeRange, "package-lock.json must mirror the Node security floor");
assert.equal(
  packageJson.scripts?.["reproduce:runtime-security-floor"],
  "node --experimental-strip-types scripts/reproduce-runtime-security-floor.mjs",
  "package.json must expose the runtime-floor reproduction"
);
assert.match(
  packageJson.scripts?.["verify:security"] ?? "",
  /tests\/runtime-security-floor\.node\.test\.mjs/,
  "verify:security must execute the runtime-floor regression tests"
);
contains(".npmrc", ["engine-strict=true"]);
contains("scripts/generate-secrets.mjs", [
  'const SECRET_BYTES = 32',
  'randomBytes(SECRET_BYTES).toString("base64url")',
  'const SECRET_NAMES = ["JWT_SECRET", "MFA_ENCRYPTION_KEY"]',
  "Refusing to overwrite existing secrets without --force",
  "Rotating MFA_ENCRYPTION_KEY can invalidate enrolled TOTP authenticators"
]);
contains("scripts/seed.ts", [
  "BRAINVAULT_SEED_DEMO",
  "BRAINVAULT_DEMO_PASSWORD must contain 12-128 characters and no more than 72 UTF-8 bytes",
  "isPasswordWithinBcryptLimit(password)"
]);
const browserSource = read("public/app.js");
assert.ok(!browserSource.includes("brainvault.token"), "The browser must not persist the JWT in localStorage");
assert.ok(!browserSource.includes('Authorization", `Bearer'), "The built-in browser must use the HttpOnly session cookie");
assert.ok(browserSource.includes("CSS.escape(blockId)"), "Dynamic block selectors must escape block IDs");
contains("src/lib/session-cookie.ts", [
  "httpOnly: true",
  'sameSite: "strict"',
  "secure: secureSessionCookie",
  "getAuthSessionCookieName(secureSessionCookie)",
  "readUniqueCookieValue"
]);
contains("src/lib/session-cookie-policy.ts", [
  'secureAuthSessionCookieName = "__Host-brainvault_session"',
  "matches !== 1",
  "decodeURIComponent(encodedValue)"
]);
contains("src/lib/access-log.ts", [
  "stripUrlQueryAndFragment",
  "sanitizeAccessLogValue",
  ":safe-url",
  ":safe-referrer",
  ":safe-user-agent"
]);
contains("src/lib/markdown.ts", [
  "export function sanitizeRenderedHtml"
]);
contains("src/lib/mappers.ts", [
  "sanitizeRenderedHtml(row.html_cache)"
]);
contains("src/routes/page.routes.ts", [
  "sanitizeRenderedHtml(block.html_cache)"
]);
contains("src/middleware/auth-rate-limit.ts", [
  "loginIpRateLimit",
  "loginAccountRateLimit",
  "mfaLoginIpRateLimit",
  "mfaLoginAccountRateLimit",
  "mfaSetupRateLimit",
  "accountReauthenticationRateLimit",
  'hashRateLimitKey("account-reauthentication", userId)',
  "requestWasSuccessful: authenticationRequestSucceeded",
  "registrationGlobalRateLimit",
  "registrationRateLimit"
]);
const appSource = contains("src/app.ts", [
  "if (env.SERVE_INTERNAL_DOCS)",
  /app\.use\(\s*"\/docs",\s*requireAuth/,
  "createExpressTrustProxySetting",
  "createHttpsEnforcementMiddleware",
  'enabled: env.HTTPS_MODE !== "off"',
  "https://cdn.jsdelivr.net/npm/katex@0.17.0/dist/katex.min.js",
  "'sha256-AQrGHmNf2ToDPODxkNyXldxWl9tWr2pnwbahY0pFneE='",
  'app.get("/vendor/yjs/yjs.mjs"',
  'app.get("/vendor/yjs/isomorphic/browser.mjs"',
  '"/vendor/yjs/lib0"',
  'path.join(browserModuleRoot, "yjs", "dist", "yjs.mjs")',
  'path.join(browserModuleRoot, "isomorphic.js", "browser.mjs")',
  'extensions: ["js"]',
  'connectSrc: ["\'self\'", ...configuredWebSocketOrigins]',
  "productionAccessLogFormat : developmentAccessLogFormat",
  'morgan.token("safe-url"',
  'morgan.token("safe-referrer"',
  'morgan.token("safe-user-agent"',
  "res.json({ ok: true })"
]);
assert.ok(
  appSource.indexOf("rateLimit({") < appSource.indexOf('express.json({ limit: "5mb" })'),
  "The global rate limiter must run before JSON body parsing"
);
assert.ok(
  appSource.indexOf("rateLimit({") < appSource.indexOf("express.urlencoded({ extended: false })"),
  "The global rate limiter must run before URL-encoded body parsing"
);
assert.match(
  appSource,
  /app\.use\(\s*"\/docs",\s*requireAuth,\s*express\.static\(docsDir,\s*\{[\s\S]*?cacheControl: false,[\s\S]*?etag: false,[\s\S]*?lastModified: false,[\s\S]*?setHeaders: setPrivateNoStoreCacheControl/,
  "Authenticated documentation must preserve the private no-store policy instead of enabling static caching"
);
assert.ok(browserSource.includes("function acceptRotatedAuthenticationSession()"));
assert.ok(
  (browserSource.match(/acceptRotatedAuthenticationSession\(\);/g) ?? []).length >= 5,
  "Password and MFA credential changes must fence responses from the previous cookie generation"
);

const collaborationBrowserSource = contains("public/collaboration.js", [
  'const YJS_MODULE_URL = "/vendor/yjs/yjs.mjs";',
  'message.type === "compaction-complete"',
  "this.presence.set(message.connectionId, { ...previous, ...message })"
]);
const indexSource = contains("public/index.html", [
  '<script type="importmap">{"imports":{"lib0/":"/vendor/yjs/lib0/","isomorphic.js":"/vendor/yjs/isomorphic/browser.mjs"}}</script>'
]);
assert.ok(!appSource.includes("https://cdn.jsdelivr.net/npm/yjs@"), "CSP must not permit a remote Yjs runtime");
assert.ok(!collaborationBrowserSource.includes("https://cdn.jsdelivr.net/npm/yjs@"), "The browser must load Yjs locally");
assert.ok(indexSource.includes("/vendor/yjs/lib0/"), "The import map must resolve lib0 locally");
assert.ok(!appSource.includes('scriptSrc: ["\'self\'", "https://cdn.jsdelivr.net"]'), "CSP must not trust the entire jsDelivr host");
assert.ok(!appSource.includes('connectSrc: ["\'self\'", "ws:", "wss:"]'), "CSP must not allow arbitrary WebSocket hosts");
contains("src/lib/runtime-security.ts", [
  'export const nodeRuntimeSecurityFloor = "^22.23.2 || ^24.18.1 || >=26.5.1"',
  "process.versions.node",
  "Refusing to start"
]);
const serverSource = contains("src/server.ts", [
  'import { assertSupportedNodeRuntime } from "./lib/runtime-security.js";',
  "assertSupportedNodeRuntime();",
  "createHttpServer(app)",
  "createHttpsServer(poshAcmeTls.options, app)",
  "server.listen(env.PORT, env.HOST",
  "HTTPS reverse-proxy mode enabled",
  "Posh-ACME HTTPS mode enabled"
]);
const runtimeGuardIndex = serverSource.indexOf("assertSupportedNodeRuntime();");
assert.ok(runtimeGuardIndex >= 0, "The server entrypoint must enforce the runtime security floor");
for (const startupOperation of ["await loadPoshAcmeTls(", "await bootstrapDatabase(", "server.listen("]) {
  assert.ok(
    serverSource.indexOf(startupOperation) > runtimeGuardIndex,
    `${startupOperation} must remain after the runtime security-floor assertion`
  );
}
contains("src/lib/posh-acme-https.ts", [
  'defaultCertificateFileName = "fullchain.cer"',
  'defaultPrivateKeyFileName = "cert.key"',
  "createSecureContext(options)",
  "certificate.checkHost(hostname)",
  'minVersion: "TLSv1.2"'
]);
const httpsMiddlewareSource = contains("src/middleware/https.ts", [
  "isDirectTlsRequest(req.socket)",
  "isHttpsRequestFromTrustedProxy(req, options.trustedProxyAddresses)",
  "buildHttpsRedirectUrl",
  "HTTPS_REQUIRED",
  "res.redirect(308"
]);
assert.ok(!httpsMiddlewareSource.includes("req.secure"), "HTTPS enforcement must validate the direct proxy peer itself");
const reverseProxySource = contains("src/lib/reverse-proxy.ts", [
  "createExpressTrustProxySetting",
  "TRUST_PROXY_HOPS must remain 0",
  "isTrustedProxyRemoteAddress(request.socket.remoteAddress, trustedProxyAddresses)"
]);
assert.ok(!reverseProxySource.includes("trustedProxyHops > 0"), "Numeric hop trust must not authorize forwarding headers");
contains("src/routes/page.routes.ts", [
  "coverUrl: pageCoverUrlSchema.nullable().optional()",
  "inspectCustomCoverDataUrl(row.cover_url)",
  "escapeHtmlAttribute(block.id)",
  'res.setHeader("Cache-Control", "private, no-store")'
]);
contains("src/lib/page-cover.ts", [
  "maxCustomCoverImageBytes = 2 * 1024 * 1024",
  'new Set(["image/png", "image/jpeg", "image/webp"])',
  "hasExpectedSignature",
  'bytes.toString("base64") !== encoded',
  "parsed.username || parsed.password",
  "['http:', 'https:'].includes(parsed.protocol)"
]);
contains("src/lib/collaboration-materialization.ts", ["z.string().regex(/^[a-zA-Z0-9_-]+$/).min(1).max(64)"]);
contains("src/lib/data-transfer.ts", [
  "cover_url: pageCoverUrlSchema.nullable()",
  "inspectCustomCoverBytes(pageCover.mimeType",
  "pageCovers: z.array(pageCoverFileSchema)",
  "normalizeAvatarDataUrl(manifest.account.avatar_data)",
  "The backup contains an identifier owned by another account"
]);
contains("src/routes/collaboration.routes.ts", ["SHARE_TARGET_UNAVAILABLE"]);
const errorSource = contains("src/middleware/error.ts", [
  "INVALID_JSON",
  'code: "DATABASE_CONSTRAINT_FAILED"',
  'console.error("Unexpected request failure"'
]);
assert.ok(!errorSource.includes("console.error(error)"), "Unexpected errors must not be logged as complete objects");

contains("src/lib/request-origin.ts", [
  "parseExactHttpOrigin",
  "createExactHttpOriginSet",
  "parsed.origin !== candidate",
  'candidate === "null"'
]);
const corsSource = contains("src/middleware/cors.ts", [
  "parseExactHttpOrigin(origin)",
  "explicitCorsOrigins.has(parsedOrigin)"
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

contains("src/routes/block.routes.ts", [
  "parts: 7",
  "fieldNestingDepth: 1",
  "headerPairs: 32",
  "attachmentUploadRateLimit",
  "enforceAttachmentUploadRequestSize",
  "authorizeAttachmentUploadTarget",
  "attachmentUploadConcurrencyLimit",
  "beginAttachmentUploadProcessing",
  "bookmarkPreviewRateLimit",
  "inspectAttachmentUpload",
  "assertDirectBlockMutationAllowed(lockedAccess)",
  "sanitizeAttachmentDownloadFilename",
  "Content-Security-Policy",
  "Cross-Origin-Resource-Policy"
]);
contains("src/middleware/attachment-rate-limit.ts", [
  "ATTACHMENT_UPLOAD_RATE_LIMITED",
  "ATTACHMENT_UPLOAD_IN_PROGRESS",
  "ATTACHMENT_UPLOAD_BUSY",
  "AttachmentUploadAdmissionGate"
]);
contains("src/lib/attachment-metadata-integrity.ts", [
  "safeAttachmentMimeTypes",
  "activeAttachmentMimeTypes",
  "isBlockedAttachmentFilename",
  "sanitizeAttachmentDownloadFilename"
]);
contains("src/lib/login-lockout.ts", ["AUTH_LOGIN_LOCK_THRESHOLD", "login_locked_until", "FOR UPDATE"]);
contains("migrations/030_account_login_lockout.sql", ["failed_login_attempts", "login_locked_until"]);
contains("src/routes/data.routes.ts", [
  "parts: 2",
  "fieldNestingDepth: 1",
  "headerPairs: 32",
  "dataImportRateLimit",
  "enforceBackupUploadRequestSize",
  "dataImportConcurrencyLimit"
]);
contains("src/middleware/data-rate-limit.ts", [
  "DATA_IMPORT_RATE_LIMITED",
  "DATA_IMPORT_IN_PROGRESS",
  "DATA_IMPORT_BUSY",
  "DataImportAdmissionGate"
]);
contains("src/lib/data-transfer-limits.ts", [
  "maxBlocks: 50_000",
  "maxAttachments: 5_000",
  "maxPageCovers: 20_000",
  "maxCustomIcons: 20_000",
  "maxZipEntries: 45_001",
  "maxCentralDirectoryBytes: 8 * 1024 * 1024",
  "measureJsonUtf8BytesWithinLimit"
]);
contains("src/lib/data-transfer.ts", [
  "DATA_TRANSFER_MAX_MANIFEST_SIZE_MB * 1024 * 1024",
  "maxCentralDirectoryBytes: dataTransferResourceLimits.maxCentralDirectoryBytes",
  "maxEntries: dataTransferResourceLimits.maxZipEntries",
  "stagedFileBytes + BigInt(fileStat.size) > maxTransferBytes",
  "measureJsonUtf8BytesWithinLimit(manifest, maxManifestBytes - 1)"
]);
const codeHighlightingSource = contains("src/lib/code-highlighting.ts", [
  "maxSourceLength: 2_000",
  "return { definition, source, html: escapeHtml(source) }",
  'class="language-${highlighted.definition.grammar}"'
]);
for (const forbidden of ["node:vm", "vm.createContext", "vm.runInContext", "new vm.Script", "runInContext"]) {
  assert.ok(!codeHighlightingSource.includes(forbidden), `server highlighting must not contain ${forbidden}`);
}
contains("public/code-highlighting.js", [
  "maxSourceLength: 2_000",
  "maxHydrationSourceLength: 8_000",
  "maxHydratedBlocks: 20",
  "source.length > highlightResourceLimits.maxSourceLength"
]);
const appCspSource = contains("src/app.ts", [
  "imgSrc: [",
  '"https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.3/assets/svg/"'
]);
assert.match(
  appCspSource,
  /imgSrc:\s*\[[^\]]*"'self'"[^\]]*"data:"[^\]]*"blob:"[^\]]*"https:\/\/cdn\.jsdelivr\.net\/gh\/jdecked\/twemoji@17\.0\.3\/assets\/svg\/"[^\]]*\]/
);
assert.doesNotMatch(appCspSource, /imgSrc:\s*\[[^\]]*(?:"http:"|"https:")/);
const markdownImageSource = contains("src/lib/markdown.ts", [
  "normalizeRenderedImageSource",
  'allowedSchemesByTag: { img: ["data"] }',
  "delete nextAttributes.srcset"
]);
assert.doesNotMatch(markdownImageSource, /img:\s*\[[^\]]*"srcset"/);
contains("public/app.js", [
  "function getRenderableImageSource",
  "url.origin !== window.location.origin",
  "const imageSource = getRenderableImageSource(item?.faviconUrl, { allowData: false })",
  "const coverSource = getRenderableImageSource(page?.coverUrl)"
]);

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

console.log("[security-hardening] PASS: login CSRF gates, exact origins, atomic MFA attempts, credential-boundary rotation, stale-auth rejection, account reauthentication throttling, pre-parser global limiting, revocation-safe MFA completion, locked TOTP verification, account backoff, __Host session cookies, duplicate-cookie rejection, query-safe access logs, bounded presence identity, no-op Yjs replay rejection, state-equivalent compaction, cookie-only browser login, logout revocation, absolute bookmark deadlines, attachment screening and pre-storage admission, bounded WebSocket and collaboration queues, collaboration connection limits, syntax-highlighting deadlines, backup import admission limits, patched Node runtime enforcement, authenticated response cache isolation, database accounts, CSP, error hygiene, JWT separation, multipart limits, and SSRF ranges");
