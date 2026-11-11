import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import express from "express";
import { WebSocket } from "ws";

process.env.NODE_ENV = "test";
const { NetworkMeasurementService, isSupportedMeasurementPath } = await import("../src/lib/network-verification.ts");
const { getClientIpAddressFromTrustedProxyRequest, isHttpsRequestFromTrustedProxy } = await import("../src/lib/reverse-proxy.ts");
const { readTrustedProxyTcpInfo } = await import("../src/lib/network-tcp-info.ts");
const origin = "http://localhost:4000";

async function harness({ throughProxy = false, ...options } = {}) {
  const service = new NetworkMeasurementService({ origins: [origin], secure: false, supported: true, minimumExcessMs: 50,
    resolveIp: (request) => throughProxy ? getClientIpAddressFromTrustedProxyRequest(request, ["127.0.0.1"])
      : String(request.headers["x-test-source"] ?? "8.8.8.8"),
    ...(throughProxy ? { proxyUncertaintyMs: 10, pathAllowed: (req) => isSupportedMeasurementPath(true, req.socket.remoteAddress, ["127.0.0.1"])
      && isHttpsRequestFromTrustedProxy(req, ["127.0.0.1"]) } : {}),
    // Explicit test seam for direct sockets; production must obtain real TCP_INFO.
    readTcpInfo: throughProxy ? (request, ip) => readTrustedProxyTcpInfo(request, ip, { enabled: true, proxyMode: true, trustedAddresses: ["127.0.0.1"] })
      : () => ({ observation: { rttMs: 1, variationMs: 0, source: "DIRECT_TCP_INFO" }, signal: "DIRECT_TCP_INFO" }), ...options });
  const app = express();
  app.use(express.json({ limit: "1kb" })); app.use("/api/network-verification", service.router());
  const server = createServer(app); service.attach(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  let proxy = null;
  if (throughProxy) {
    const forwardedHeaders = (req) => ({ ...req.headers, "x-forwarded-for": "8.8.8.8", "x-forwarded-proto": "https",
      "x-brainvault-tcp-peer-ip": "8.8.8.8", "x-brainvault-tcp-rtt-us": "1000", "x-brainvault-tcp-rttvar-us": "0" });
    proxy = createServer((req, res) => {
      const upstream = httpRequest({ host: "127.0.0.1", port: server.address().port, path: req.url, method: req.method, headers: forwardedHeaders(req) }, (response) => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on("error", () => { res.statusCode = 502; res.end(); }); req.pipe(upstream);
    });
    proxy.on("upgrade", (req, socket, head) => {
      const upstream = connect(server.address().port, "127.0.0.1");
      upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
      upstream.once("connect", () => {
        const headers = Object.entries(forwardedHeaders(req)).map(([key, value]) => `${key}: ${value}`).join("\r\n");
        upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(socket); socket.pipe(upstream);
      });
    });
    proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  }
  const base = `http://127.0.0.1:${(proxy ?? server).address().port}`;
  const post = (path = "/", body = {}, headers = {}) => fetch(base + "/api/network-verification" + path, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const measure = async ({ delayMs = 0, headers = {}, cookie = "" } = {}) => {
    const ticket = await (await post("/", {}, headers)).json(); assert.equal(ticket.available, true);
    const ws = new WebSocket(base.replace("http:", "ws:") + ticket.path, ticket.protocols,
      { autoPong: delayMs === 0, headers: { Origin: origin, ...headers } });
    if (delayMs) ws.on("ping", (data) => setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.pong(data); }, delayMs));
    const [data] = await once(ws, "message"); const receipt = JSON.parse(data.toString()).receipt;
    const result = await post("/complete", { receipt }, { ...headers, ...(cookie ? { Cookie: cookie } : {}) });
    assert.equal(result.status, 200);
    const setCookie = result.headers.get("set-cookie"); assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /SameSite=Strict/i);
    const pair = setCookie.split(";")[0];
    return { cookie: pair, context: pair.split("=")[1], receipt };
  };
  return { service, base, post, measure, close: async () => {
    await service.close();
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  } };
}

test("NAS loopback and Docker bridge proxies are supported only when explicitly trusted", () => {
  for (const ip of ["127.0.0.1", "::1", "172.18.0.1", "192.168.1.10"]) assert.equal(isSupportedMeasurementPath(true, ip, [ip]), true, ip);
  assert.equal(isSupportedMeasurementPath(true, "172.18.0.1", []), false);
  assert.equal(isSupportedMeasurementPath(true, "8.8.8.8", ["8.8.8.8"]), false);
  assert.equal(isSupportedMeasurementPath(false, "8.8.8.8", []), true);
  const request = { headers: { "x-forwarded-for": "1.1.1.1", "x-forwarded-proto": "https" }, socket: { remoteAddress: "172.18.0.1" } };
  assert.equal(getClientIpAddressFromTrustedProxyRequest(request, ["172.18.0.1"]), "1.1.1.1");
});

test("a real WebSocket probe issues an IP-bound, browser-specific, one-time receipt", async () => {
  const h = await harness();
  try {
    const value = await h.measure();
    assert.equal(h.service.assessment("8.8.8.8", value.context).verdict, "CLEAR");
    assert.equal(h.service.assessment("8.8.8.8", null).verdict, "UNKNOWN");
    assert.equal(h.service.assessment("1.1.1.1", value.context).verdict, "UNKNOWN");
    assert.equal((await h.post("/complete", { receipt: value.receipt })).status, 400);
    assert.equal(h.service.context({ headers: { cookie: value.cookie + "; " + value.cookie } }), null);
    const originalNow = Date.now;
    try { Date.now = () => originalNow() + 6 * 60_000; assert.equal(h.service.assessment("8.8.8.8", value.context).verdict, "UNKNOWN"); }
    finally { Date.now = originalNow; }
  } finally { await h.close(); }
});

test("same-NAT direct and relayed connections do not overwrite one another's verdict", async () => {
  const h = await harness();
  try {
    const direct = await h.measure(); const relayed = await h.measure({ delayMs: 100 });
    assert.equal(h.service.assessment("8.8.8.8", direct.context).verdict, "CLEAR");
    assert.equal(h.service.assessment("8.8.8.8", relayed.context).verdict, "TUNNEL");
    const updated = await h.measure({ cookie: relayed.cookie });
    assert.equal(updated.context, relayed.context, "live collaboration keeps its opaque evidence handle across browser refreshes");
    assert.equal(h.service.assessment("8.8.8.8", updated.context).verdict, "CLEAR");
  } finally { await h.close(); }
});

test("local trusted reverse proxy paths measure normally with an additional error margin", async () => {
  const h = await harness({ proxyUncertaintyMs: 10, pathAllowed: (req) => isSupportedMeasurementPath(true, req.socket.remoteAddress, ["127.0.0.1"]) });
  try {
    const result = await h.measure(); const assessment = h.service.assessment("8.8.8.8", result.context);
    assert.equal(assessment.verdict, "CLEAR");
    assert.ok(assessment.supportingSignals.includes("LOCAL_TRUSTED_PROXY"));
    assert.equal(assessment.measurement.thresholdMs, 60);
  } finally { await h.close(); }
});

test("HTTP ticket, WebSocket probe and cookie redemption work through a real local reverse proxy", async () => {
  const h = await harness({ throughProxy: true });
  try {
    const value = await h.measure({ headers: { "x-brainvault-tcp-rtt-us": "9999999", "x-brainvault-tcp-peer-ip": "127.0.0.1" } });
    const assessment = h.service.assessment("8.8.8.8", value.context);
    assert.equal(assessment.verdict, "CLEAR");
    assert.equal(assessment.measurement.tcpRttMs, 1);
    assert.equal(assessment.measurement.tcpSource, "TRUSTED_PROXY_TCP_INFO");
    assert.ok(assessment.supportingSignals.includes("LOCAL_TRUSTED_PROXY"));
    assert.equal(assessment.measurement.thresholdMs, 60);
    assert.equal(h.service.assessment("127.0.0.1", value.context).verdict, "UNKNOWN", "the private proxy address is never substituted for the public client");
  } finally { await h.close(); }
});

test("ticket budgets bound unauthenticated attempts without reading transport metadata", async () => {
  let reads = 0;
  const h = await harness({ readTcpInfo: () => { reads += 1; return { observation: null, signal: "TCP_INFO_UNAVAILABLE" }; } });
  try {
    for (let count = 0; count < 30; count++) assert.equal((await h.post()).status, 200);
    assert.equal((await h.post()).status, 429); assert.equal(reads, 0);
  } finally { await h.close(); }
});

test("a cookie measured on an allowed path cannot authorize a later unsupported proxy path", async () => {
  let allowed = true;
  const h = await harness({ pathAllowed: () => allowed });
  try {
    const value = await h.measure();
    assert.equal(h.service.context({ headers: { cookie: value.cookie } }), value.context);
    allowed = false;
    assert.equal(h.service.context({ headers: { cookie: value.cookie } }), null);
  } finally { await h.close(); }
});

test("missing TCP_INFO, blocked measurement paths and client-asserted headers cannot claim CLEAR", async () => {
  const h = await harness({ readTcpInfo: () => ({ observation: null, signal: "TCP_INFO_UNAVAILABLE" }) });
  try {
    const result = await h.measure({ headers: { "X-BrainVault-TCP-RTT-Us": "1", "X-BrainVault-TCP-Peer-IP": "8.8.8.8", "X-Measured-RTT": "0" } });
    assert.equal(h.service.assessment("8.8.8.8", result.context).verdict, "UNKNOWN");
  } finally { await h.close(); }
  const blocked = await harness({ pathAllowed: () => false });
  try { assert.equal((await (await blocked.post()).json()).available, false); }
  finally { await blocked.close(); }
});

test("untrusted origins, oversized requests, and forged completion receipts are rejected", async () => {
  const h = await harness();
  try {
    assert.equal((await h.post("/", {}, { Origin: "https://attacker.example" })).status, 403);
    assert.equal((await h.post("/complete", { receipt: "0".repeat(64) })).status, 400);
    assert.equal((await h.post("/", { padding: "x".repeat(2_048) })).status, 413);
    const ticket = await (await h.post()).json();
    const ws = new WebSocket(h.base.replace("http:", "ws:") + ticket.path, ticket.protocols, { headers: { Origin: origin, "x-test-source": "1.1.1.1" } });
    const [error] = await once(ws, "error"); assert.match(error.message, /401/);
  } finally { await h.close(); }
});

test("network evidence remains enforced at password, MFA, passkey, cookie and collaboration boundaries", async () => {
  for (const path of ["src/routes/auth.routes.ts", "src/routes/mfa.routes.ts", "src/routes/passkey-login.routes.ts", "src/middleware/auth.ts", "src/lib/collaboration-server.ts"]) {
    const source = await readFile(new URL("../" + path, import.meta.url), "utf8");
    assert.match(source, /enforceVpnAccessPolicy/); assert.match(source, /getNetworkVerificationContext/);
    assert.doesNotMatch(source, /getClientWebRtcSignal|getClientTimeZone|webRtcSignal/);
  }
  const policy = await readFile(new URL("../src/lib/vpn-access-policy.ts", import.meta.url), "utf8");
  assert.doesNotMatch(policy, /fetch\(|api\.ipquery|api\.ipapi|vpngate|tor-exit-list|confidence/);
  const { resolveVpnAccessRisk, enforceVpnAccessPolicy } = await import("../src/lib/vpn-access-policy.ts");
  assert.equal((await resolveVpnAccessRisk("::ffff:127.0.0.1")).blocked, false);
  assert.equal((await resolveVpnAccessRisk("8.8.8.8")).reason, "VPN_VERIFICATION_UNAVAILABLE");
  assert.equal(await enforceVpnAccessPolicy("user", false, "8.8.8.8"), null);
});
