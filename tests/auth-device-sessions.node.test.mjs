import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseUserAgent } from "../src/lib/user-agent.ts";

const authSource = readFileSync(new URL("../src/lib/auth.ts", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../src/lib/auth-sessions.ts", import.meta.url), "utf8");
const middlewareSource = readFileSync(new URL("../src/middleware/auth.ts", import.meta.url), "utf8");
const routesSource = readFileSync(new URL("../src/routes/auth.routes.ts", import.meta.url), "utf8");
const collaborationSource = readFileSync(new URL("../src/lib/collaboration-server.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/052_auth_device_sessions.sql", import.meta.url), "utf8");
const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const windowsChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const iphoneSafari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const linuxFirefox = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0";

test("browser display metadata is parsed without being used as an authorization primitive", () => {
  assert.deepEqual(parseUserAgent(windowsChrome), {
    browserName: "Chrome",
    browserVersion: "140.0.0.0",
    osName: "Windows 10/11",
    deviceType: "desktop"
  });
  assert.deepEqual(parseUserAgent(iphoneSafari), {
    browserName: "Safari",
    browserVersion: "18.6",
    osName: "iOS/iPadOS 18.6",
    deviceType: "mobile"
  });
  assert.deepEqual(parseUserAgent(linuxFirefox), {
    browserName: "Firefox",
    browserVersion: "141.0",
    osName: "Linux",
    deviceType: "desktop"
  });
  assert.match(sessionSource, /parseUserAgent\(req\.header\("user-agent"\)\)/);
  assert.doesNotMatch(middlewareSource, /browser_name|browserName/);
});

test("session migration is additive and stores active-device metadata", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_auth_sessions/i);
  assert.match(migration, /ip_address VARCHAR\(45\) NOT NULL/i);
  assert.match(migration, /browser_name VARCHAR\(64\) NOT NULL/i);
  assert.match(migration, /expires_at DATETIME\(3\) NOT NULL/i);
  assert.match(migration, /revoked_at DATETIME\(3\) NULL/i);
  assert.doesNotMatch(migration, /(?:^|\n)\s*(?:DELETE\s+FROM|DROP\b|TRUNCATE\b)/i);
});

test("new auth tokens have unique session ids while pre-upgrade cookies remain compatible", () => {
  assert.match(authSource, /payload\.sessionId \?\? createId\("ses"\)/);
  assert.match(sessionSource, /payload\.sessionId/);
  assert.match(sessionSource, /createHash\("sha256"\)\.update\(token/);
  assert.match(sessionSource, /INSERT IGNORE INTO user_auth_sessions/);
});

test("only active unexpired sessions are listed and one session can be revoked independently", () => {
  assert.match(sessionSource, /revoked_at IS NULL[\s\S]*expires_at > CURRENT_TIMESTAMP\(3\)/);
  assert.match(sessionSource, /SET revoked_at = CURRENT_TIMESTAMP\(3\)/);
  assert.match(routesSource, /authRouter\.get\("\/sessions", requireAuth/);
  assert.match(routesSource, /authRouter\.delete\("\/sessions\/:sessionId", requireAuth/);
  assert.doesNotMatch(routesSource, /\/sessions\/(?:all|logout-all|revoke-all)/i);

  const revokeStart = routesSource.indexOf('authRouter.delete("/sessions/:sessionId"');
  const revokeEnd = routesSource.indexOf('authRouter.get(\n  "/login-history"', revokeStart);
  const revokeHandler = routesSource.slice(revokeStart, revokeEnd);
  assert.doesNotMatch(revokeHandler, /UPDATE users SET auth_version/i);
  assert.match(revokeHandler, /revokeAuthSession/);

  const logoutStart = routesSource.indexOf('authRouter.post("/logout"');
  const logoutEnd = routesSource.indexOf('authRouter.get("/me"', logoutStart);
  const logoutHandler = routesSource.slice(logoutStart, logoutEnd);
  assert.match(logoutHandler, /auth_version = \?/);
});

test("cookie auth and collaboration both enforce an individually revoked session", () => {
  assert.match(middlewareSource, /source === "cookie"[\s\S]*ensureAuthSessionForRequest/);
  assert.match(collaborationSource, /isAuthSessionActive\(user\.id, authSessionId, currentAuthVersion\)/);
  assert.match(collaborationSource, /disconnectAuthSessionEverywhere/);
  assert.match(routesSource, /disconnectAuthSessionCollaborators\(user\.id, sessionId/);
});

test("security UI exposes device details and per-session logout without an all-sessions control", () => {
  assert.match(index, /data-security-panel="sessions"/);
  assert.match(index, /id="account-active-sessions-body"/);
  assert.match(index, /data-i18n="account.activeSessionsIp"/);
  assert.match(client, /api\("\/api\/auth\/sessions"\)/);
  assert.match(client, /method: "DELETE"/);
  assert.match(client, /session\.browserLabel/);
  assert.match(client, /session\.ipAddress/);
  assert.doesNotMatch(index, /active-sessions-(?:all|logout-all|revoke-all)/i);
});
