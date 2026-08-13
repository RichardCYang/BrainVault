import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => readFileSync(join(rootDir, relativePath), "utf8").replace(/\r\n/g, "\n");

test("the patched lockfile excludes vulnerable ip-address releases", () => {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const installed = packageLock.packages?.["node_modules/ip-address"];

  assert.equal(packageJson.overrides?.["ip-address"], "10.3.1");
  assert.equal(installed?.version, "10.3.1");
  assert.equal(installed?.resolved, "https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz");
  assert.equal(
    installed?.integrity,
    "sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g=="
  );
  assert.notEqual(installed?.version, "10.2.0");
});


test("dependency installation rejects Node releases below the July 2026 security floor", () => {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const npmrc = read(".npmrc");
  const expectedRange = "^22.23.2 || ^24.18.1 || >=26.5.1";

  assert.equal(packageJson.engines?.node, expectedRange);
  assert.equal(packageLock.packages?.[""]?.engines?.node, expectedRange);
  assert.match(npmrc, /^engine-strict=true$/m);
});

test("the collaboration runtime is same-origin and the import map matches its CSP hash", () => {
  const appSource = read("src/app.ts");
  const collaborationSource = read("public/collaboration.js");
  const indexSource = read("public/index.html");
  const importMapMatch = indexSource.match(/<script type="importmap">([\s\S]*?)<\/script>/);

  assert.ok(importMapMatch, "index.html must include an import map");
  const importMap = JSON.parse(importMapMatch[1]);
  assert.deepEqual(importMap, {
    imports: {
      "lib0/": "/vendor/yjs/lib0/",
      "isomorphic.js": "/vendor/yjs/isomorphic/browser.mjs"
    }
  });

  const digest = createHash("sha256").update(importMapMatch[1], "utf8").digest("base64");
  assert.equal(digest, "AQrGHmNf2ToDPODxkNyXldxWl9tWr2pnwbahY0pFneE=");
  assert.ok(appSource.includes(`'sha256-${digest}'`));
  assert.ok(collaborationSource.includes('const YJS_MODULE_URL = "/vendor/yjs/yjs.mjs";'));
  assert.ok(appSource.includes('app.get("/vendor/yjs/yjs.mjs"'));
  assert.ok(appSource.includes('app.get("/vendor/yjs/isomorphic/browser.mjs"'));
  assert.ok(appSource.includes('"/vendor/yjs/lib0"'));
  assert.ok(!appSource.includes("https://cdn.jsdelivr.net/npm/yjs@"));
  assert.ok(!collaborationSource.includes("https://cdn.jsdelivr.net/npm/yjs@"));
});

test("the documented advisory hostname canonicalizes to the private IPv4 target", () => {
  const parsed = new URL("http://012.0.0.1/");
  assert.equal(parsed.hostname, "10.0.0.1");
});

test("collaboration updates are semantically validated before durable persistence", () => {
  const source = read("src/lib/collaboration-server.ts");
  const applyIndex = source.indexOf("const candidate = applyValidatedYjsUpdate(");
  const semanticIndex = source.indexOf("readCollaborationMaterialization(candidate.document);", applyIndex);
  const insertIndex = source.indexOf("INSERT INTO page_yjs_updates", applyIndex);

  assert.ok(applyIndex >= 0);
  assert.ok(semanticIndex > applyIndex);
  assert.ok(insertIndex > semanticIndex);
  assert.match(source.slice(applyIndex, insertIndex), /CollaborationDocumentError/);
  assert.match(source.slice(applyIndex, insertIndex), /client\.socket\.close\(1008, "Invalid collaboration update"\)/);
});

test("collaboration tickets are bound to the authenticated browser session", () => {
  const tokenSource = read("src/lib/collaboration-token.ts");
  const routeSource = read("src/routes/collaboration.routes.ts");
  const serverSource = read("src/lib/collaboration-server.ts");

  assert.match(tokenSource, /sessionBinding: string/);
  assert.match(tokenSource, /createHash\("sha256"\).*?authSessionToken/s);
  assert.match(routeSource, /const authSessionToken = readAuthSessionCookie\(req\)/);
  assert.match(routeSource, /sessionBinding: createCollaborationSessionBinding\(authSessionToken\)/);
  assert.match(serverSource, /const authSessionToken = readUniqueCookieValue\(request\.headers\.cookie, authSessionCookieName\)/);
  assert.match(serverSource, /authPayload\.sub !== payload\.sub/);
  assert.match(serverSource, /createCollaborationSessionBinding\(authSessionToken\) !== payload\.sessionBinding/);
});

test("failed password logins are padded after both existing and nonexistent account paths", () => {
  const source = read("src/routes/auth.routes.ts");
  const loginStart = source.indexOf('authRouter.post(\n  "/login"');
  const paddingIndex = source.indexOf("await padFailedLoginResponse(startedAt);", loginStart);
  const invalidCredentialIndex = source.indexOf('new ApiError(401, "INVALID_CREDENTIALS"', loginStart);

  assert.ok(loginStart >= 0);
  assert.ok(paddingIndex > loginStart);
  assert.ok(invalidCredentialIndex > paddingIndex);
  assert.match(source, /const targetDurationMs = 500 \+ randomInt\(0, 101\)/);
});

test("bookmark numeric entity decoding rejects invalid Unicode code points without throwing", () => {
  const source = read("src/lib/bookmark.ts");
  assert.match(source, /Number\.isSafeInteger\(codePoint\)/);
  assert.match(source, /codePoint <= 0x10ffff/);
  assert.match(source, /!\(codePoint >= 0xd800 && codePoint <= 0xdfff\)/);
});

test("password account-enumeration paths perform comparable cryptographic and database work", () => {
  const routes = read("src/routes/auth.routes.ts");
  const lockout = read("src/lib/login-lockout.ts");
  const history = read("src/lib/login-history.ts");

  const registerStart = routes.indexOf('authRouter.post(\n  "/register"');
  const loginStart = routes.indexOf('authRouter.post(\n  "/login"');
  assert.ok(registerStart >= 0 && loginStart > registerStart);
  const register = routes.slice(registerStart, loginStart);
  assert.ok(register.indexOf("await hashPassword(password)") < register.indexOf("INSERT IGNORE INTO users"));
  assert.doesNotMatch(register, /SELECT \* FROM users WHERE username/);

  const login = routes.slice(loginStart, routes.indexOf('authRouter.post("/logout"', loginStart));
  assert.match(login, /const result = await transaction/);
  assert.match(login, /lockedUser\?\.id \?\? syntheticLoginUserId/);
  assert.match(login, /evaluatePasswordLogin\(client, workingUserId/);
  assert.match(login, /recordLoginAttempt\(workingUserId/);
  assert.match(lockout, /UPDATE users SET failed_login_attempts = failed_login_attempts WHERE id = \?/);
  assert.match(history, /SELECT \?, id, \?, \? FROM users WHERE id = \?/);
});

test("bearer authentication enforces the same revocable session row as cookie authentication", () => {
  const source = read("src/middleware/auth.ts");
  assert.match(source, /const authSessionId = await ensureAuthSessionForRequest\(token, payload, req\)/);
  assert.doesNotMatch(source, /source === "cookie"[\s\S]{0,120}ensureAuthSessionForRequest/);
});

test("restore journals are authenticated before startup recovery can derive destructive paths", () => {
  const transfer = read("src/lib/data-transfer.ts");
  const recoveryStart = transfer.indexOf("export async function recoverInterruptedDataRestores");
  const recovery = transfer.slice(recoveryStart, transfer.indexOf("export async function cleanupStaleDataTransferTempFiles", recoveryStart));
  assert.match(transfer, /createHmac\("sha256", env\.MFA_ENCRYPTION_KEY\)/);
  assert.match(transfer, /timingSafeEqual\(actual, expected\)/);
  assert.match(transfer, /JSON\.stringify\(signRestoreJournal\(journal\)\)/);
  assert.ok(recovery.indexOf("verifyRestoreJournalEnvelope") < recovery.indexOf("getRestorePaths(journal)"));
  assert.match(recovery, /Ignoring unauthenticated data restore journal/);
});

test("data-transfer temp cleanup and collaboration lifecycle defenses are active", () => {
  const transfer = read("src/lib/data-transfer.ts");
  const server = read("src/server.ts");
  const collaboration = read("src/lib/collaboration-server.ts");

  assert.match(transfer, /export async function cleanupStaleDataTransferTempFiles/);
  assert.match(transfer, /env\.ATTACHMENT_TEMP_MAX_AGE_MS/);
  assert.match(server, /await cleanupStaleDataTransferTempFiles\(\)/);
  assert.match(collaboration, /const bootstrapLeaderTimeoutMs = 15_000/);
  assert.match(collaboration, /ensureBootstrapLeaderTimeout\(room\)/);
  assert.match(collaboration, /const idleRoomTtlMs = 30_000/);
  assert.match(collaboration, /idleRemovalTimer/);
  assert.match(collaboration, /requiresDurableRecheck/);
  assert.match(collaboration, /SELECT COALESCE\(MAX\(id\), 0\) AS max_update_id FROM page_yjs_updates/);
});

test("page sharing has dedicated account and IP abuse ceilings", () => {
  const routes = read("src/routes/collaboration.routes.ts");
  const limiter = read("src/middleware/auth-rate-limit.ts");
  const env = read("src/config/env.ts");

  const start = routes.indexOf('collaborationRouter.post(\n  "/pages/:pageId/shares"');
  const end = routes.indexOf("collaborationRouter.delete(", start);
  assert.ok(start >= 0 && end > start);
  const route = routes.slice(start, end);
  assert.match(route, /collaborationShareIpRateLimit/);
  assert.match(route, /collaborationShareAccountRateLimit/);
  assert.match(limiter, /keyGenerator: \(req\) => authenticatedAccountKey\("page-share-account", req\)/);
  assert.match(limiter, /keyGenerator: clientIpKey/);
  assert.match(env, /COLLABORATION_SHARE_ACCOUNT_MAX:[\s\S]*?default\(30\)/);
  assert.match(env, /COLLABORATION_SHARE_IP_MAX:[\s\S]*?default\(60\)/);
});

test("navigation order writes are request-bounded, single-statement, and account-rate-limited", () => {
  const routes = read("src/routes/auth.routes.ts");
  const limiter = read("src/middleware/auth-rate-limit.ts");
  const start = routes.indexOf('authRouter.patch(\n  "/navigation-order"');
  const end = routes.indexOf('authRouter.get("/sessions"', start);
  assert.ok(start >= 0 && end > start);
  const route = routes.slice(start, end);

  assert.match(routes, /const navigationOrderMaxPageIds = 4_096/);
  assert.match(routes, /\.max\(navigationOrderMaxPageIds\)/);
  assert.match(route, /navigationOrderRateLimit/);
  assert.match(route, /const values = pageIds\.map\(\(\) => "\(\?, \?, \?\)"\)\.join\(", "\)/);
  assert.doesNotMatch(route, /for \(let offset = 0; offset < pageIds\.length/);
  assert.equal((route.match(/INSERT INTO user_navigation_page_order/g) ?? []).length, 1);
  assert.match(limiter, /authenticatedAccountKey\("navigation-order-account", req\)/);
});

test("block reorder validates block and parent identifiers before request hashing", () => {
  const routes = read("src/routes/block.routes.ts");
  const schemaStart = routes.indexOf("const reorderSchema = z.object({");
  const routeStart = routes.indexOf('blockRouter.post(\n  "/pages/:pageId/blocks/reorder"');
  assert.ok(schemaStart >= 0 && routeStart > schemaStart);
  const schema = routes.slice(schemaStart, routes.indexOf("const attachmentFormSchema", schemaStart));
  const route = routes.slice(routeStart, routes.indexOf("blockRouter", routeStart + 20));

  assert.match(schema, /id: routeIdSchema/);
  assert.match(schema, /parentBlockId: routeIdSchema\.nullable\(\)\.optional\(\)/);
  assert.match(route, /validate\(\{ params: idParamSchema, body: reorderSchema \}\)/);
  assert.match(route, /createMutationRequestHash\(\{ pageId, items \}\)/);
});



test("archived pages reject direct REST mutations while preserving the restore-only path", () => {
  const access = read("src/lib/page-access.ts");
  const blocks = read("src/routes/block.routes.ts");
  const pages = read("src/routes/page.routes.ts");

  assert.match(access, /export function assertPageNotArchived/);
  assert.match(access, /throw new ApiError\(409, "PAGE_ARCHIVED"/);
  assert.equal((blocks.match(/assertPageNotArchived\(/g) ?? []).length, 4);
  assert.match(blocks, /assertDirectBlockMutationAllowed\(lockedAccess\);\n\s*assertPageNotArchived\(lockedAccess\.page\);/);
  assert.match(blocks, /return \{ block: existing, pageContentVersion:[\s\S]*?\}\;\n\s*\}\n\n\s*assertPageNotArchived\(lockedPage\);/);
  assert.match(pages, /updates\.isArchived === false && tags === undefined && Object\.keys\(updates\)\.length === 1/);
  assert.match(pages, /if \(existingPage\.is_archived && !isArchivedRestoreOnly\)/);
  assert.match(pages, /pageRouter\.put\("\/:pageId\/tags"[\s\S]*?assertPageNotArchived\(existingPage\);/);
});

test("password login account limiter bounds attacker-controlled username key cardinality", () => {
  const limiter = read("src/middleware/auth-rate-limit.ts");

  assert.match(limiter, /const maxDistinctLoginAccountKeysPerIpWindow = 50;/);
  assert.match(limiter, /const maxTrackedLoginAccountIpNamespaces = 1_024;/);
  assert.match(limiter, /const loginAccountKeysByIp = new Map<string, LoginAccountKeyNamespace>\(\);/);
  assert.match(limiter, /expiresAt: now \+ env\.AUTH_LOGIN_ACCOUNT_WINDOW_MS/);
  assert.match(limiter, /pruneExpiredLoginAccountKeyNamespaces\(now\)/);
  assert.match(limiter, /namespace\.accountKeys\.size >= maxDistinctLoginAccountKeysPerIpWindow/);
  assert.match(limiter, /Math\.floor\(now \/ Math\.max\(1, env\.AUTH_LOGIN_IP_WINDOW_MS\)\)/);
  assert.equal((limiter.match(/return loginAccountOverflowKey\(ip, now\);/g) ?? []).length, 2);
  assert.match(limiter, /keyGenerator: usernameKey/);
});
