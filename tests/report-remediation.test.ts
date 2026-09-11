import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ queryOne: vi.fn(), execute: vi.fn(), transaction: vi.fn(), session: true, version: 1, generation: 1, owned: true }));
vi.mock("../src/lib/db.js", () => {
  const client = { queryOne: state.queryOne, execute: state.execute, query: vi.fn(async () => []) };
  return { db: client, transaction: async (fn: any) => { state.transaction(); return fn(client); } };
});
// Test-only interface fixture; these tests do not exercise outbound networking.
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, default: { ...actual, networkInterfaces: () => ({}) } };
});
import { env } from "../src/config/env.js";
import { loginAccountRateLimit, registrationRateLimit, registrationGlobalRateLimit } from "../src/middleware/auth-rate-limit.js";
import { authRouter } from "../src/routes/auth.routes.js";
import { mfaRouter } from "../src/routes/mfa.routes.js";
import { hashPassword } from "../src/lib/auth.js";
import { assertLosslessBackupBlockMetadata } from "../src/lib/structured-metadata-integrity.js";
import { pruneExpiredAuthSessions } from "../src/lib/auth-sessions.js";
function request(ip: string, body: any = {}) {
  return { ip, socket: { remoteAddress: ip }, body, params: {}, headers: {}, app: { get: () => false }, header: () => undefined, method: "POST" } as any;
}
function response() {
  const res = new EventEmitter() as any;
  res.statusCode = 200; res.locals = {}; res.headers = new Map();
  res.setHeader = (k: string, v: any) => res.headers.set(k.toLowerCase(), v);
  res.getHeader = (k: string) => res.headers.get(k.toLowerCase()); res.append = res.setHeader;
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (body: any) => { res.body = body; res.emit("finish"); return res; }; return res;
}
async function invoke(handler: any, req: any, res: any) {
  let continued = false; let failure: any;
  await handler(req, res, (error: any) => { continued = true; failure = error; });
  if (failure) throw failure; return continued;
}
function route(router: any, path: string, method: string) {
  return router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack.map((layer: any) => layer.handle);
}
it("isolates the long login budget across IPs while throttling repeat failures", async () => {
  for (let i = 1; i <= env.AUTH_LOGIN_ACCOUNT_MAX; i++) {
    const res = response();
    expect(await invoke(loginAccountRateLimit, request(`198.51.100.${i}`, { username: "victim" }), res)).toBe(true);
    res.status(401).json({});
  }
  expect(await invoke(loginAccountRateLimit, request("203.0.113.200", { username: "victim" }), response())).toBe(true);
  for (let i = 0; i < env.AUTH_LOGIN_ACCOUNT_MAX; i++) {
    const res = response(); await invoke(loginAccountRateLimit, request("203.0.113.201", { username: "victim" }), res); res.status(401).json({});
  }
  const blocked = response();
  expect(await invoke(loginAccountRateLimit, request("203.0.113.201", { username: " VICTIM " }), blocked)).toBe(false);
  expect(blocked.statusCode).toBe(429);
});
it("actual registration middleware stops one source exhausting the global budget", async () => {
  const handlers = route(authRouter, "/register", "post");
  const first = handlers.indexOf(registrationRateLimit), last = handlers.indexOf(registrationGlobalRateLimit);
  expect(first).toBeLessThan(last);
  async function admit(ip: string, body = { username: "new-user", password: "long-test-password" }) {
    const req = request(ip, body), res = response();
    for (const handler of handlers.slice(first, last + 1)) if (!await invoke(handler, req, res)) return res.statusCode;
    res.status(202).json({}); return 202;
  }
  for (let i = 0; i < env.AUTH_REGISTER_GLOBAL_MAX + 5; i++) expect(await admit("192.0.2.1")).toBe(i < env.AUTH_REGISTER_MAX ? 202 : 429);
  expect(await admit("192.0.2.2")).toBe(202);
  await expect(admit("192.0.2.3", { username: "", password: "" })).rejects.toThrow();
});
function accordion(icon: string) {
  return { id: "block-test", type: "ACCORDION" as const, metadata: JSON.stringify({ accordion: { title: "Imported", showOrder: false, items: [{ id: "item-1", icon, title: "One", content: "Body", open: true }] } }) };
}
it("restore rejects forged and oversized icons and accepts valid legacy icons", () => {
  expect(() => assertLosslessBackupBlockMetadata(accordion("image:data:image/png;base64,dGhpcyBpcyBub3QgYSBwbmc="))).toThrow();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(() => assertLosslessBackupBlockMetadata(accordion(`image:data:image/png;base64,${png.toString("base64")}`))).not.toThrow();
  const oversized = Buffer.concat([png, Buffer.alloc(512 * 1024)]);
  expect(() => assertLosslessBackupBlockMetadata(accordion(`image:data:image/png;base64,${oversized.toString("base64")}`))).toThrow();
  expect(() => assertLosslessBackupBlockMetadata(accordion("icon:star"))).not.toThrow();
});
it("cleanup is bounded and retains unexpired revocation tombstones", async () => {
  state.execute.mockClear(); await pruneExpiredAuthSessions();
  const sql = state.execute.mock.calls[0][0];
  expect(sql).toMatch(/WHERE expires_at <= CURRENT_TIMESTAMP\(3\)/);
  expect(sql).toContain("LIMIT 1000"); expect(sql).not.toMatch(/revoked_at|auth_version/);
});
beforeEach(async () => {
  const passwordHash = await hashPassword("current-password");
  state.session = true; state.version = 1; state.generation = 1; state.owned = true;
  state.execute.mockReset(); state.transaction.mockClear(); state.execute.mockResolvedValue({ affectedRows: 1 });
  state.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM users")) return { id: "usr_test", auth_version: state.version, attachment_generation: state.generation, password_hash: passwordHash };
    if (sql.includes("FROM user_auth_sessions")) return state.session ? { id: "ses_test" } : undefined;
    if (sql.includes("FROM user_passkeys")) return state.owned ? { id: "key_test" } : undefined;
    return undefined;
  });
});
async function rename(body: any) {
  const handlers = route(mfaRouter, "/passkeys/:id", "patch");
  const req = request("198.51.100.100", body), res = response();
  req.user = { id: "usr_test" }; req.auth = { authVersion: 1, workspaceGeneration: 1, sessionId: "ses_test" }; req.params = { id: "key_test" };
  // Supply authenticated admission, then exercise the real schema and transaction.
  await invoke(handlers.at(-2), req, res); await invoke(handlers.at(-1), req, res); return res;
}
it("rename requires the current password", async () => {
  await expect(rename({ name: "Renamed" })).rejects.toThrow();
  await expect(rename({ name: "Renamed", currentPassword: "wrong" })).rejects.toMatchObject({ code: "CURRENT_PASSWORD_INCORRECT" });
  expect(state.execute).not.toHaveBeenCalled();
});
it.each(["session", "version", "generation"])("rename rejects a stale %s before writing", async (boundary) => {
  if (boundary === "session") state.session = false;
  if (boundary === "version") state.version = 2;
  if (boundary === "generation") state.generation = 2;
  await expect(rename({ name: "Renamed", currentPassword: "current-password" })).rejects.toMatchObject({ code: boundary === "generation" ? "WORKSPACE_RESTORED" : "SESSION_REVOKED" });
  expect(state.execute).not.toHaveBeenCalled();
});
it("rename updates only an owned credential inside a transaction", async () => {
  expect((await rename({ name: "Renamed", currentPassword: "current-password" })).statusCode).toBe(200);
  expect(state.transaction).toHaveBeenCalledOnce();
  expect(state.execute).toHaveBeenCalledWith("UPDATE user_passkeys SET name = ? WHERE id = ? AND user_id = ?", ["Renamed", "key_test", "usr_test"]);
});
it("rename rejects foreign or missing credentials", async () => {
  state.owned = false;
  await expect(rename({ name: "Renamed", currentPassword: "current-password" })).rejects.toMatchObject({ code: "PASSKEY_NOT_FOUND" });
  expect(state.execute).not.toHaveBeenCalled();
});
