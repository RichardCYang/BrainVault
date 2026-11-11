import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { Router } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { env, corsOrigins } from "../config/env.js";
import { getClientIpAddressFromTrustedProxyRequest, isTrustedProxyRemoteAddress, isHttpsRequestFromTrustedProxy } from "./reverse-proxy.js";
import { readUniqueCookieValue } from "./session-cookie-policy.js";
import { isCountryPolicyLocalNetworkIp } from "./geo-country.js";
import { normalizeMeasurementIp, readTrustedProxyTcpInfo, type TcpInfoReadResult } from "./network-tcp-info.js";
import { evaluateLatencyEvidence, unavailableLatencyAssessment, type LatencyAssessment } from "./vpn-latency.js";

export const networkProbePath = "/api/network-verification/probe";
export const networkProbeProtocol = "brainvault.measure.v1";
export function isSupportedMeasurementPath(proxyMode: boolean, peer: string, trustedAddresses: readonly string[]) {
  return !proxyMode || isCountryPolicyLocalNetworkIp(normalizeMeasurementIp(peer) ?? "") && isTrustedProxyRemoteAddress(peer, trustedAddresses);
}
const ticketPrefix = "brainvault.measure.ticket.";
const evidenceLifetimeMs = 5 * 60_000;
const maxRecords = 4_096;
type Timed<T> = T & { expiresAt: number; ipAddress: string };
type Receipt = Timed<{ assessment: LatencyAssessment }>;

export type NetworkMeasurementOptions = {
  origins: readonly string[];
  secure: boolean;
  supported: boolean;
  minimumExcessMs: number;
  resolveIp: (request: IncomingMessage) => string;
  pathAllowed?: (request: IncomingMessage) => boolean;
  proxyUncertaintyMs?: number;
  readTcpInfo?: (request: IncomingMessage, clientIp: string) => TcpInfoReadResult;
};

/** A completed probe is bound to a random browser cookie AND its exact public IP. */
export class NetworkMeasurementService {
  private readonly tickets = new Map<string, Timed<object>>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly evidence = new Map<string, Receipt>();
  private readonly budgets = new Map<string, { startedAt: number; count: number }>();
  private readonly clients = new Set<WebSocket>();
  private readonly activeIps = new Map<string, number>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256, perMessageDeflate: false,
    handleProtocols: (protocols) => protocols.has(networkProbeProtocol) ? networkProbeProtocol : false });
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  private detach: (() => void) | null = null;
  readonly cookieName: string;

  constructor(private readonly options: NetworkMeasurementOptions) {
    this.cookieName = options.secure ? "__Host-brainvault_network" : "brainvault_network";
    this.timer = setInterval(() => this.prune(), 30_000);
    this.timer.unref();
  }

  private prune() {
    const now = Date.now();
    for (const map of [this.tickets, this.receipts, this.evidence]) {
      for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
    }
    for (const [key, value] of this.budgets) if (now - value.startedAt > 60_000) this.budgets.delete(key);
  }

  private ip(request: IncomingMessage) {
    return normalizeMeasurementIp(this.options.resolveIp(request)) ?? "unknown";
  }

  private originAllowed(request: IncomingMessage) {
    return typeof request.headers.origin === "string" && this.options.origins.includes(request.headers.origin);
  }

  private pathAllowed(request: IncomingMessage) {
    return this.options.supported && (this.options.pathAllowed?.(request) ?? true);
  }

  private readId(request: IncomingMessage) {
    const value = readUniqueCookieValue(request.headers.cookie, this.cookieName);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
  }

  context(request: IncomingMessage) { return this.pathAllowed(request) ? this.readId(request) : null; }

  assessment(ipAddress: string, context: string | null): LatencyAssessment {
    if (!this.options.supported) return unavailableLatencyAssessment("UNSUPPORTED_PROXY_PATH", this.options.minimumExcessMs);
    const value = context ? this.evidence.get(context) : null;
    if (!value || value.ipAddress !== normalizeMeasurementIp(ipAddress) || value.expiresAt <= Date.now()) {
      return unavailableLatencyAssessment("MEASUREMENT_REQUIRED", this.options.minimumExcessMs);
    }
    return value.assessment;
  }

  router() {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
    router.post("/", (req, res) => {
      if (!this.originAllowed(req)) { res.sendStatus(403); return; }
      if (this.closed || !this.pathAllowed(req)) { res.json({ available: false, retryAfterMs: 60_000 }); return; }
      const ipAddress = this.ip(req);
      if (ipAddress === "unknown") { res.sendStatus(400); return; }
      // Intentional direct LAN access remains exempt.
      if (env.VPN_ALLOW_PRIVATE_NETWORK && isCountryPolicyLocalNetworkIp(ipAddress)) {
        res.json({ available: false, retryAfterMs: 60_000 }); return;
      }
      this.prune();
      const existing = this.budgets.get(ipAddress);
      const budget = existing && Date.now() - existing.startedAt < 60_000 ? existing : { startedAt: Date.now(), count: 0 };
      if (budget.count >= 30 || this.budgets.size >= maxRecords && !existing || this.tickets.size >= 128) { res.sendStatus(429); return; }
      budget.count += 1;
      this.budgets.set(ipAddress, budget);
      const ticket = randomBytes(32).toString("hex");
      this.tickets.set(ticket, { ipAddress, expiresAt: Date.now() + 20_000 });
      res.json({ available: true, path: networkProbePath, protocols: [networkProbeProtocol, ticketPrefix + ticket] });
    });
    router.post("/complete", (req, res) => {
      if (!this.originAllowed(req)) { res.sendStatus(403); return; }
      const receiptId = req.body?.receipt;
      const receipt = typeof receiptId === "string" && /^[a-f0-9]{64}$/.test(receiptId) ? this.receipts.get(receiptId) : null;
      if (!receipt || receipt.expiresAt <= Date.now() || receipt.ipAddress !== this.ip(req)) { res.sendStatus(400); return; }
      this.receipts.delete(receiptId);
      const oldId = this.readId(req);
      const old = oldId ? this.evidence.get(oldId) : null;
      const id = old && old.ipAddress === receipt.ipAddress && oldId ? oldId : randomBytes(32).toString("hex");
      this.prune();
      if (!this.evidence.has(id) && this.evidence.size >= maxRecords) { res.sendStatus(503); return; }
      this.evidence.set(id, { ...receipt, expiresAt: Date.now() + evidenceLifetimeMs });
      res.cookie(this.cookieName, id, { httpOnly: true, secure: this.options.secure, sameSite: "strict", path: "/", maxAge: evidenceLifetimeMs });
      // Keep thresholds and measurement outcomes off the pre-authentication API.
      res.json({ ok: true, refreshAfterMs: 60_000 });
    });
    return router;
  }

  attach(server: HttpServer | HttpsServer) {
    const handler = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
      if (request.url?.split("?")[0] !== networkProbePath) return;
      socket.on("error", () => socket.destroy());
      const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
      if (this.closed || !this.pathAllowed(request) || !this.originAllowed(request)) { reject(403); return; }
      const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim());
      const tickets = protocols.filter((value) => value.startsWith(ticketPrefix));
      const ticket = tickets.length === 1 ? tickets[0].slice(ticketPrefix.length) : "";
      const entry = this.tickets.get(ticket);
      const ipAddress = this.ip(request);
      if (!entry || entry.expiresAt <= Date.now() || entry.ipAddress !== ipAddress || !protocols.includes(networkProbeProtocol)) { reject(401); return; }
      this.tickets.delete(ticket);
      if (this.clients.size >= 32 || (this.activeIps.get(ipAddress) ?? 0) >= 4 || this.receipts.size >= maxRecords) { reject(429); return; }
      const tcpInfo = this.options.readTcpInfo?.(request, ipAddress) ?? { observation: null, signal: "TCP_INFO_UNAVAILABLE" };
      this.wss.handleUpgrade(request, socket, head, (ws) => this.measure(ws, ipAddress, tcpInfo));
    };
    server.on("upgrade", handler);
    this.detach = () => server.off("upgrade", handler);
  }

  private measure(ws: WebSocket, ipAddress: string, tcpInfo: TcpInfoReadResult) {
    this.clients.add(ws);
    this.activeIps.set(ipAddress, (this.activeIps.get(ipAddress) ?? 0) + 1);
    const app: number[] = [];
    let nonce: Buffer | null = null;
    let sentAt = 0n;
    let settled = false;
    let next: NodeJS.Timeout | null = null;
    const deadline = setTimeout(() => { settled = true; ws.terminate(); }, 12_000);
    const sendPing = () => {
      if (settled || ws.readyState !== WebSocket.OPEN) return;
      nonce = randomBytes(16); sentAt = process.hrtime.bigint(); ws.ping(nonce);
    };
    ws.on("error", () => ws.terminate());
    ws.on("ping", () => ws.terminate());
    ws.on("message", () => ws.terminate());
    ws.on("pong", (payload) => {
      if (settled || !nonce || !payload.equals(nonce)) { ws.terminate(); return; }
      app.push(Number(process.hrtime.bigint() - sentAt) / 1e6);
      nonce = null;
      if (app.length < 12) { next = setTimeout(sendPing, 40); return; }
      settled = true;
      const proxyUncertaintyMs = this.options.proxyUncertaintyMs ?? 0;
      const assessment = evaluateLatencyEvidence({
        applicationRttMs: app, tcp: tcpInfo.observation, uncertaintyMs: proxyUncertaintyMs, missingTcpSignal: tcpInfo.signal
      }, this.options.minimumExcessMs);
      if (proxyUncertaintyMs) assessment.supportingSignals.push("LOCAL_TRUSTED_PROXY");
      const receipt = randomBytes(32).toString("hex");
      if (this.receipts.size >= maxRecords) { ws.terminate(); return; }
      this.receipts.set(receipt, { ipAddress, expiresAt: Date.now() + 20_000, assessment });
      ws.send(JSON.stringify({ receipt }), (error) => { if (error) ws.terminate(); else ws.close(1000); });
    });
    ws.once("close", () => {
      settled = true; clearTimeout(deadline); if (next) clearTimeout(next);
      this.clients.delete(ws);
      const remaining = (this.activeIps.get(ipAddress) ?? 1) - 1;
      if (remaining) this.activeIps.set(ipAddress, remaining); else this.activeIps.delete(ipAddress);
    });
    next = setTimeout(sendPing, 20);
  }

  async close() {
    this.closed = true; clearInterval(this.timer); this.detach?.();
    for (const ws of this.clients) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.tickets.clear(); this.receipts.clear(); this.evidence.clear(); this.budgets.clear();
    this.activeIps.clear();
  }
}

let service: NetworkMeasurementService | null = null;
export function getNetworkVerificationContext(request: IncomingMessage) { return service?.context(request) ?? null; }
export function getNetworkAssessment(ipAddress: string, context: string | null) {
  return service?.assessment(ipAddress, context) ?? unavailableLatencyAssessment("MEASUREMENT_NOT_RUNNING", env.VPN_MIN_EXCESS_RTT_MS);
}
export async function initializeNetworkVerification() {
  service = new NetworkMeasurementService({ origins: corsOrigins, secure: env.HTTPS_MODE !== "off" || new URL(env.PUBLIC_ORIGIN).protocol === "https:",
    supported: true, minimumExcessMs: env.VPN_MIN_EXCESS_RTT_MS,
    readTcpInfo: (request, clientIp) => readTrustedProxyTcpInfo(request, clientIp, {
      enabled: env.VPN_TRUST_PROXY_TCP_INFO, proxyMode: env.HTTPS_MODE === "proxy",
      trustedAddresses: env.TRUST_PROXY_ADDRESSES, allowPrivateClients: env.TRUST_PROXY_ALLOW_PRIVATE_CLIENTS
    }),
    // Synology/nginx -> Docker bridge -> BrainVault is a supported path. The
    // normal proxy-chain verifier still requires an explicitly trusted peer
    // and a valid public client address. Never mistake the private proxy peer
    // for the client's source IP or exempt the public client as a LAN visitor.
    pathAllowed: (request) => isSupportedMeasurementPath(env.HTTPS_MODE === "proxy", request.socket.remoteAddress ?? "", env.TRUST_PROXY_ADDRESSES)
      && (env.HTTPS_MODE !== "proxy" || isHttpsRequestFromTrustedProxy(request, env.TRUST_PROXY_ADDRESSES)),
    proxyUncertaintyMs: env.HTTPS_MODE === "proxy" ? env.VPN_PROXY_RTT_MARGIN_MS : 0,
    resolveIp: (request) => env.HTTPS_MODE === "proxy" && !isTrustedProxyRemoteAddress(request.socket.remoteAddress, env.TRUST_PROXY_ADDRESSES) ? "unknown"
      : getClientIpAddressFromTrustedProxyRequest(request, env.HTTPS_MODE === "proxy" ? env.TRUST_PROXY_ADDRESSES : [], env.TRUST_PROXY_ALLOW_PRIVATE_CLIENTS) });
  serviceRouter = null;
  return service;
}
export const networkVerificationRouter = Router();
networkVerificationRouter.use((req, res, next) => {
  if (!service) { res.setHeader("Cache-Control", "private, no-store"); res.json({ available: false, retryAfterMs: 60_000 }); return; }
  serviceRouter ??= service.router(); serviceRouter(req, res, next);
});
let serviceRouter: ReturnType<NetworkMeasurementService["router"]> | null = null;
