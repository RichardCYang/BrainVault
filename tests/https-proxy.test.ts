import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  buildHttpsRedirectUrl,
  createHttpsEnforcementMiddleware,
  type HttpsEnforcementOptions
} from "../src/middleware/https.js";
import {
  createExpressTrustProxySetting,
  forwardedProtocol,
  isHttpsRequestFromTrustedProxy,
  isTrustedProxyRemoteAddress
} from "../src/lib/reverse-proxy.js";

function createTestApp(options: Partial<HttpsEnforcementOptions> = {}, trustProxy: false | string | number = "loopback") {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.use(
    createHttpsEnforcementMiddleware({
      enabled: true,
      publicOrigin: "https://notes.example.com",
      redirect: true,
      healthcheckBypass: true,
      ...options
    })
  );
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.all("/api/check", (req, res) => res.json({ secure: req.secure, method: req.method }));
  return app;
}

describe("HTTPS reverse-proxy enforcement", () => {
  it("accepts HTTPS reported by a trusted reverse proxy", async () => {
    const response = await request(createTestApp())
      .get("/api/check")
      .set("X-Forwarded-Proto", "https")
      .expect(200);

    expect(response.body).toEqual({ secure: true, method: "GET" });
  });

  it("does not accept a forged forwarded protocol when proxy trust is disabled", async () => {
    const response = await request(createTestApp({}, false))
      .get("/api/check?view=recent")
      .set("X-Forwarded-Proto", "https")
      .expect(308);

    expect(response.headers.location).toBe("https://notes.example.com/api/check?view=recent");
  });

  it("redirects plain HTTP to the fixed public origin without trusting Host", async () => {
    const response = await request(createTestApp())
      .get("/api/check?view=recent")
      .set("Host", "attacker.example")
      .expect(308);

    expect(response.headers.location).toBe("https://notes.example.com/api/check?view=recent");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("can reject HTTP instead of redirecting it", async () => {
    const response = await request(createTestApp({ redirect: false }))
      .post("/api/check")
      .expect(426);

    expect(response.body.error.code).toBe("HTTPS_REQUIRED");
  });

  it("allows a local HTTP health check when configured", async () => {
    await request(createTestApp()).get("/health").expect(200, { ok: true });
  });

  it("builds redirects only on the configured public origin", () => {
    expect(buildHttpsRedirectUrl("https://notes.example.com", "//attacker.example/escape?x=1")).toBe(
      "https://notes.example.com/escape?x=1"
    );
  });
});

describe("Express reverse-proxy trust setting", () => {
  it("prefers explicit proxy addresses over hop counts", () => {
    expect(createExpressTrustProxySetting(0, ["127.0.0.1", "172.18.0.2"])).toEqual([
      "127.0.0.1",
      "172.18.0.2"
    ]);
  });

  it("keeps the existing exact-hop mode available", () => {
    expect(createExpressTrustProxySetting(1, [])).toBe(1);
    expect(createExpressTrustProxySetting(0, [])).toBe(false);
  });

  it("matches exact addresses, CIDRs, and named private ranges", () => {
    expect(isTrustedProxyRemoteAddress("::ffff:127.0.0.1", ["loopback"])).toBe(true);
    expect(isTrustedProxyRemoteAddress("172.18.0.12", ["172.18.0.0/24"])).toBe(true);
    expect(isTrustedProxyRemoteAddress("172.18.1.12", ["172.18.0.0/24"])).toBe(false);
    expect(isTrustedProxyRemoteAddress("fd00::12", ["uniquelocal"])).toBe(true);
  });

  it("requires both a trusted peer and forwarded HTTPS for raw WebSocket upgrades", () => {
    const headers = { "x-forwarded-proto": "https, http" };
    const request = {
      headers,
      socket: { remoteAddress: "127.0.0.1" }
    } as unknown as Parameters<typeof isHttpsRequestFromTrustedProxy>[0];

    expect(forwardedProtocol(headers)).toBe("https");
    expect(isHttpsRequestFromTrustedProxy(request, 0, ["loopback"])).toBe(true);
    expect(isHttpsRequestFromTrustedProxy(request, 0, ["10.0.0.1"])).toBe(false);
  });
});
