import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { BoundedRateLimitStore } from "../src/lib/bounded-rate-limit-store.ts";

// Execute production functions with explicit, isolated dependencies. These tests
// do not substitute for the supported-runtime HTTP and live-MariaDB test suites.
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const erase = (name) => stripTypeScriptTypes(read(name))
  .replace(/^import[\s\S]*?;\r?$/gm, "").replace(/^export /gm, "");
function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
  return source.slice(first, last);
}
function factory(source, globals, names) {
  return new Function(...Object.keys(globals), `${source}\nreturn {${names.join(",")}};`)(...Object.values(globals));
}
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const noop = () => {};

function store(capacity = 3) {
  let now = 1_000;
  const result = new BoundedRateLimitStore(capacity, () => now);
  result.init({ windowMs: 100 });
  return { result, time: (value) => { now = value; } };
}

test("BV-40: hostile key churn is bounded and cannot evict a live failure counter", async () => {
  const { result } = store();
  await result.increment("victim");
  await result.increment("victim");
  await result.increment("second");
  await result.increment("third");
  for (let index = 0; index < 20_000; index++) {
    const rejected = await result.increment(`untrusted-${index}`);
    assert.equal(rejected.totalHits, Number.MAX_SAFE_INTEGER);
    assert.equal(rejected.resetTime.getTime(), 1_100);
  }
  assert.equal(result.size, 3);
  assert.equal((await result.increment("victim")).totalHits, 3);
  assert.equal(await result.get("untrusted-0"), undefined);
});

test("BV-40: fixed-window expiry admits new keys without extending existing windows", async () => {
  const { result, time } = store(1);
  await result.increment("one");
  time(1_050);
  assert.equal((await result.increment("one")).resetTime.getTime(), 1_100);
  time(1_100);
  assert.equal((await result.increment("two")).totalHits, 1);
  assert.equal(await result.get("one"), undefined);
  assert.equal(result.size, 1);
});

test("BV-40: a successful request refunds only its increment, not earlier failures", async () => {
  const { result } = store();
  for (let i = 0; i < 3; i++) await result.increment("shared-ip");
  await result.increment("shared-ip");
  await result.decrement("shared-ip");
  assert.equal((await result.get("shared-ip")).totalHits, 3);
  await result.decrement("unknown");
  assert.equal(result.size, 1);
  const copy = await result.get("shared-ip");
  copy.resetTime.setTime(0);
  assert.equal((await result.get("shared-ip")).resetTime.getTime(), 1_100);
});

test("BV-40: clocks, zero counters, and independent stores do not reset active budgets", async () => {
  const { result, time } = store(2);
  await result.increment("one");
  await result.decrement("one");
  await result.decrement("one");
  assert.equal((await result.get("one")).totalHits, 0);
  time(900);
  assert.equal((await result.increment("two")).resetTime.getTime(), 1_100);
  assert.equal(store().result.size, 0);
  await result.resetKey("two");
  assert.equal(result.size, 1);
  await result.resetAll();
  assert.equal(result.size, 0);
  assert.throws(() => new BoundedRateLimitStore(0), RangeError);
  assert.throws(() => result.init({ windowMs: NaN }), RangeError);
});

function loginHarness({ existing = true, approved = true, matches = true, rotate = noop } = {}) {
  const row = existing ? { id: "usr_owner", username: "owner", password_hash: "snapshot-hash",
    auth_version: 3, registration_approved: approved ? 1 : 0 } : null;
  let locked = row ? { ...row } : null;
  const state = { inTransaction: false, comparisons: 0, decisions: [], signed: 0, padded: 0 };
  let handler;
  const source = section(erase("src/routes/auth.routes.ts"), 'authRouter.post(\n  "/login",', 'authRouter.post("/logout",');
  factory(source, {
    ApiError, authRouter: { post: (_path, ...handlers) => { handler = handlers.at(-1); } },
    requireSameOriginBrowserRequest: noop, requireJsonRequestBody: noop,
    loginIpRateLimit: noop, loginAccountRateLimit: noop, validate: noop, loginSchema: {},
    getClientIpAddress: () => "203.0.113.7", normalizeAuthVersion: (value) => Number(value ?? 0),
    db: { queryOne: async (sql) => { assert.equal(state.inTransaction, false); assert.doesNotMatch(sql, /FOR UPDATE/); return row; } },
    verifyPassword: async (_password, hash) => {
      assert.equal(state.inTransaction, false, "bcrypt must not hold a connection or row lock");
      state.comparisons++; state.hash = hash;
      locked = rotate(locked) ?? locked;
      return matches;
    },
    dummyPasswordHash: Promise.resolve("dummy-hash"), syntheticLoginUserId: "usr_synthetic",
    transaction: async (callback) => {
      state.inTransaction = true;
      try { return await callback({ queryOne: async (sql) => { assert.match(sql, /FOR UPDATE/); return locked; } }); }
      finally { state.inTransaction = false; }
    },
    evaluatePasswordLogin: async (_client, id, valid) => {
      assert.equal(state.inTransaction, true); state.decisions.push({ id, valid });
      return valid ? "ALLOWED" : "DENIED";
    },
    recordLoginAttempt: noop, padLoginResponse: async () => { state.padded++; },
    enforceCountryLoginPolicy: noop, enforceVpnAccessPolicy: noop,
    getClientTimeZone: noop, getClientWebRtcSignal: noop, isPreAuthLoginPolicyDenial: () => false,
    getMfaMethods: async () => ({ totp: false, passkey: false }),
    signAuthToken: () => { state.signed++; return "session-token"; },
    clearMfaCeremonyBinding: noop, setAuthSessionCookie: noop, toPublicUser: (user) => ({ id: user.id })
  }, []);
  return { state, run: async () => {
    let error, body;
    await handler({ body: { username: "owner", password: "test-password" } },
      { locals: {}, setHeader: noop, json: (value) => { body = value; } }, (value) => { error = value; });
    return { error, body };
  } };
}

test("BV-41: password verification precedes the short locked decision transaction", async () => {
  const h = loginHarness();
  assert.equal((await h.run()).error, undefined);
  assert.equal(h.state.comparisons, 1);
  assert.equal(h.state.hash, "snapshot-hash");
  assert.equal(h.state.signed, 1);
});
for (const [name, options] of [
  ["unknown username", { existing: false }], ["unapproved account", { approved: false }],
  ["wrong password", { matches: false }],
  ["password rotation", { rotate: (row) => ({ ...row, password_hash: "new-hash" }) }],
  ["session revocation", { rotate: (row) => ({ ...row, auth_version: 4 }) }],
  ["approval revocation", { rotate: (row) => ({ ...row, registration_approved: 0 }) }],
  ["deleted/recreated account", { rotate: (row) => ({ ...row, id: "usr_replacement" }) }]
]) test(`BV-41: ${name} cannot authenticate from a stale credential snapshot`, async () => {
  const h = loginHarness(options);
  assert.equal((await h.run()).error?.code, "INVALID_CREDENTIALS");
  assert.equal(h.state.signed, 0);
  assert.equal(h.state.padded, 1);
  assert.equal(h.state.comparisons, 1);
  if (options.existing === false || options.approved === false) assert.equal(h.state.hash, "dummy-hash");
  if (options.rotate) assert.equal(h.state.decisions[0].id, "usr_synthetic");
});

test("BV-42: anonymous token keys require no database and account keys require a verified session", () => {
  const source = erase("src/middleware/auth-rate-limit.ts");
  const keys = factory(section(source, "function clientIpKey(", "function mfaSetupAccountKey("),
    { createHash, ipKeyGenerator: (value) => value }, ["mfaTokenKey", "mfaAccountKey"]);
  const req = (token) => ({ ip: "203.0.113.1", socket: {}, body: { mfaToken: token, user_id: "forged" } });
  assert.equal(keys.mfaTokenKey(req("bad-one")), keys.mfaTokenKey(req("bad-two")));
  assert.notEqual(keys.mfaTokenKey(req("A".repeat(43))), keys.mfaTokenKey(req("B".repeat(43))));
  assert.throws(() => keys.mfaAccountKey(req("A".repeat(43)), { locals: {} }), /Verified MFA session/);
  assert.equal(keys.mfaAccountKey(req("A".repeat(43)), { locals: { mfaLoginSession: { user_id: "owner" } } }),
    keys.mfaAccountKey(req("B".repeat(43)), { locals: { mfaLoginSession: { user_id: "owner" } } }));
  assert.doesNotMatch(read("src/middleware/auth-rate-limit.ts"), /\bdb\.queryOne|from ["'][^"']*\/db\.js/);
});

test("BV-42: all MFA routes admit and validate tokens before lookup, then apply account limits", () => {
  const source = read("src/routes/mfa.routes.ts");
  for (const route of ["totp", "passkey/options", "passkey/verify"]) {
    const start = source.indexOf(`mfaRouter.post(\n  "/login/${route}",`);
    assert.ok(start >= 0);
    const middleware = source.slice(start, source.indexOf("async (req, res, next)", start));
    assert.match(middleware, /mfaLoginTokenRateLimit,\s+validate\([\s\S]*?requireActiveMfaLoginSession,\s+mfaLogin(?:Options)?AccountRateLimit,/);
  }
  assert.equal((source.match(/await getActiveMfaSession\(\s*token,/g) ?? []).length, 1);
});

test("BV-43: owner recovery revalidates the current session and clears only its account budget", async () => {
  const source = section(erase("src/routes/auth.routes.ts"), 'authRouter.post(\n  "/login-lockout/reset",', 'authRouter.get("/me",');
  let handler, rejectSession = false, commits = 0;
  const cleared = [], updated = [];
  const req = { user: { id: "usr_owner" }, body: { username: "victim" } };
  factory(source, {
    authRouter: { post: (_path, ...handlers) => { handler = handlers.at(-1); } },
    requireAuth: noop, requireJsonRequestBody: noop, loginLockoutRecoveryRateLimit: noop,
    requireUser: (value) => value, requireRequestAuthScope: () => ({ authVersion: 3 }), ApiError,
    assertCurrentAuthSession: async (id) => { assert.equal(id, "usr_owner"); if (rejectSession) throw new Error("revoked"); },
    assertAuthenticationVersion: (row, version) => assert.equal(row.auth_version, version),
    transaction: async (callback) => {
      const result = await callback({
        queryOne: async (_sql, [id]) => { assert.equal(id, "usr_owner"); return { id, username: "owner", auth_version: 3 }; },
        execute: async (sql, params) => { assert.match(sql, /login_locked_until = NULL/); updated.push(params); }
      }); commits++; return result;
    },
    clearPasswordLoginAccountLimit: async (username) => { assert.ok(commits > 0); cleared.push(username); }
  }, []);
  let error;
  const res = { status: (status) => { assert.equal(status, 204); return { end: noop }; } };
  await handler(req, res, (value) => { error = value; });
  assert.equal(error, undefined);
  assert.deepEqual(cleared, ["owner"]);
  assert.deepEqual(updated, [["usr_owner"]]);
  rejectSession = true;
  await handler(req, res, (value) => { error = value; });
  assert.equal(error.message, "revoked");
  assert.equal(cleared.length, 1);
  assert.doesNotMatch(read("src/middleware/auth-rate-limit.ts"), /loginIpRateLimit\.resetKey/);
  assert.match(read("src/routes/passkey-login.routes.ts"), /await clearPasswordLoginAccountLimit\(result\.user\.username\)/);
});

function publicationHarness() {
  const transfer = erase("src/lib/data-transfer.ts");
  const rows = [];
  const { restoreCustomIconPublications } = factory(section(transfer,
    "async function restoreCustomIconPublications(", "const restoreJournalIntegrityDomain"), {
    invalidBackup: (message) => { throw new ApiError(400, "INVALID_BACKUP", message); },
    customIconPublicPath: (owner, file) => `/upload/icons/${owner}/${file}`
  }, ["restoreCustomIconPublications"]);
  const client = { execute: async (sql, params) => { assert.match(sql, /INSERT INTO custom_icon_page_publications/); rows.push(params); } };
  return { rows, restore: (manifest) => restoreCustomIconPublications(client, "usr_destination", manifest) };
}
const publicationManifest = () => ({ version: 6, source: { userId: "usr_source" },
  data: { pages: [{ id: "page_owned" }] }, customIcons: [{ fileName: "cicon_owned.png", library: null }],
  customIconPublications: [{ page_id: "page_owned", fileName: "cicon_owned.png", created_at: "2026-09-17 00:00:00.000000" }] });

test("BV-45: restored publication rebinds owner/path, including retained icons outside the picker", async () => {
  const h = publicationHarness();
  await h.restore(JSON.parse(JSON.stringify(publicationManifest())));
  assert.deepEqual(h.rows, [["page_owned", "usr_destination", "/upload/icons/usr_destination/cicon_owned.png", "2026-09-17 00:00:00.000000"]]);
});
for (const field of ["page_id", "fileName"]) test(`BV-45: foreign publication ${field} is rejected`, async () => {
  const h = publicationHarness(), manifest = publicationManifest();
  manifest.customIconPublications[0][field] = "foreign";
  await assert.rejects(h.restore(manifest), (error) => error.code === "INVALID_BACKUP");
  assert.equal(h.rows.length, 0);
});

test("BV-45: older backups never invent publication grants", async () => {
  const h = publicationHarness(), manifest = publicationManifest();
  delete manifest.customIconPublications;
  manifest.version = 5;
  await h.restore(manifest);
  assert.equal(h.rows.length, 0);
  const source = read("src/lib/data-transfer.ts");
  assert.match(source, /manifest\.version >= backupVersion && !manifest\.customIconPublications/);
  assert.match(source, /manifest\.version < backupVersion && manifest\.customIconPublications !== undefined/);
  assert.match(source, /custom-icon-publication\\0/);
  assert.match(source, /customIconPublications: snapshot\.customIconPublications/);
  assert.match(source, /customIconPublications\.map\(\(item\) => `\$\{item\.page_id\}\\u0000\$\{item\.fileName\}`\)/);
});

test("BV-45: modeled restored grants still require a current page share to read an icon", async () => {
  const h = publicationHarness();
  await h.restore(publicationManifest());
  const source = erase("src/lib/custom-icons.ts");
  const pattern = source.match(/const localCustomIconPathPattern = [^\n]+/)[0];
  const { canUserReadCustomIcon } = factory(pattern + "\n"
    + section(source, "function safeStorageSegment(", "function hasValidIcoStructure(")
    + section(source, "async function canUserReadCustomIcon(", "async function publishCustomIconForPage("),
    { ApiError }, ["canUserReadCustomIcon"]);
  let shared = true;
  const client = { queryOne: async (sql, [owner, path, requester]) => {
    assert.match(sql, /p\.owner_id = cip\.owner_id/);
    assert.match(sql, /FROM page_shares ps/);
    assert.match(sql, /INNER JOIN collection_shares/);
    return shared && requester === "usr_collaborator" && h.rows.some((row) => row[1] === owner && row[2] === path) ? { allowed: 1 } : null;
  } };
  const path = "/upload/icons/usr_destination/cicon_owned.png";
  assert.equal(await canUserReadCustomIcon("usr_collaborator", path, client), true);
  assert.equal(await canUserReadCustomIcon("usr_outsider", path, client), false);
  shared = false;
  assert.equal(await canUserReadCustomIcon("usr_collaborator", path, client), false);
});
