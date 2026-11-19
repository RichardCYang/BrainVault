import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import jwt from "jsonwebtoken";

process.env.NODE_ENV ??= "test";
const { getAuthTokenExpiresAt, getAuthTokenLifetimeMs, signAuthToken, verifyAuthToken } = await import("../src/lib/auth.ts");
const { extendAuthSession, maxAuthSessionLifetimeMs } = await import("../src/lib/auth-sessions.ts");

const middlewareSource = readFileSync(new URL("../src/middleware/auth.ts", import.meta.url), "utf8");
const routesSource = readFileSync(new URL("../src/routes/auth.routes.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

function fakeSessionClient(createdAt) {
  const updates = [];
  return {
    updates,
    async queryOne(sql) {
      assert.match(sql, /FOR UPDATE/);
      assert.match(sql, /revoked_at IS NULL/);
      return createdAt === null ? null : { created_at: createdAt };
    },
    async execute(sql, params) {
      updates.push({ sql, params });
      return { affectedRows: 1 };
    }
  };
}

test("an explicit expiry keeps the session id and is honored by verification", () => {
  const expiresAt = new Date(Math.floor((Date.now() + 60 * 60_000) / 1000) * 1000);
  const token = signAuthToken({ sub: "usr_1", username: "user", authVersion: 3, sessionId: "ses_keep" }, { expiresAt });
  assert.equal(getAuthTokenExpiresAt(token)?.getTime(), expiresAt.getTime());
  assert.equal(verifyAuthToken(token).sessionId, "ses_keep");
  assert.throws(() => signAuthToken({ sub: "usr_1", username: "user", authVersion: 3 }, { expiresAt: new Date(Date.now() - 1000) }));

  const relative = jwt.decode(signAuthToken({ sub: "usr_1", username: "user", authVersion: 3 }));
  assert.ok(Math.abs((relative.exp - relative.iat) * 1000 - getAuthTokenLifetimeMs()) <= 1000);
});

test("extending moves the expiry forward by one token lifetime", async () => {
  const db = fakeSessionClient(new Date(Date.now() - 60 * 60_000));
  const current = new Date(Date.now() + 2 * 60_000);
  const lifetime = 12 * 60 * 60_000;
  const next = await extendAuthSession("usr_1", "ses_1", current, lifetime, db);
  assert.ok(next && Math.abs(next.getTime() - (Date.now() + lifetime)) < 2_000);
  assert.equal(next.getTime() % 1000, 0);
  assert.equal(db.updates.length, 1);
  assert.match(db.updates[0].sql, /SET expires_at = GREATEST\(expires_at, \?\)/);
});

test("a session never outlives its maximum lifetime from first sign-in", async () => {
  const lifetime = 12 * 60 * 60_000;
  const createdAt = new Date(Date.now() - maxAuthSessionLifetimeMs + 60 * 60_000);
  const capped = await extendAuthSession("usr_1", "ses_1", new Date(Date.now() + 60_000), lifetime, fakeSessionClient(createdAt));
  assert.ok(capped);
  assert.ok(capped.getTime() <= createdAt.getTime() + maxAuthSessionLifetimeMs);

  const atCap = fakeSessionClient(new Date(Date.now() - maxAuthSessionLifetimeMs + 60_000));
  const reached = await extendAuthSession("usr_1", "ses_1", new Date(Date.now() + 60_000), lifetime, atCap);
  assert.equal(reached, null);
  assert.equal(atCap.updates.length, 0);

  await assert.rejects(
    extendAuthSession("usr_1", "ses_1", new Date(Date.now() + 60_000), lifetime, fakeSessionClient(null)),
    (error) => error.code === "SESSION_REVOKED"
  );
});

test("only an authenticated cookie session can be extended, inside the session boundary", () => {
  const start = routesSource.indexOf('authRouter.post("/session/extend", requireAuth');
  assert.ok(start > 0);
  const handler = routesSource.slice(start, routesSource.indexOf("authRouter.get(\"/sessions\"", start));
  assert.match(handler, /credentialSource !== "cookie"/);
  assert.match(handler, /assertCurrentAuthSession\(currentUser\.id, authScope, client\)/);
  assert.match(handler, /sessionId: authScope\.sessionId/);
  assert.match(handler, /setAuthSessionCookie\(res, token\)/);
  assert.match(middlewareSource, /X-BrainVault-Session-Expires/);
});

test("the browser warns before expiry and extends for an active person", () => {
  assert.match(client, /const sessionExpiryHeaderName = "X-BrainVault-Session-Expires"/);
  assert.match(client, /if \(startedAuthenticated\) noteSessionExpiry\(response\.headers\.get\(sessionExpiryHeaderName\)\);\s*onResponse\?\.\(response\);\s*return data;/);
  assert.match(client, /api\("\/api\/auth\/session\/extend", \{ method: "POST"/);
  assert.match(client, /dismissAfter: 0,\s*action: \{ label: t\("session\.extend"\)/);
  assert.match(client, /function setAuthenticated\(value\) \{[\s\S]*?stopSessionExpiryMonitor\(\);/);
  for (const key of ["session.expiringSoon", "session.extend", "session.extended", "session.lifetimeLimit", "errors.SESSION_EXTENSION_UNSUPPORTED"]) {
    assert.equal(i18n.split(`"${key}"`).length - 1, 7, `${key} is translated for every language`);
  }
});

test("database checkboxes are at least 24px on touch screens", () => {
  assert.match(
    styles,
    /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]*?\.database-value-input\[type="checkbox"\] \{\s*width: 1\.5rem;\s*height: 1\.5rem;/
  );
});
