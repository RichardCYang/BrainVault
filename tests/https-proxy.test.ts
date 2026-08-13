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

function createTestApp(
  options: Partial<HttpsEnforcementOptions> = {},
  trustProxy: false | string | string[] | number = ["loopback"]
) {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.use(
    createHttpsEnforcementMiddleware({
      enabled: true,
      publicOrigin: "https://notes.example.com",
      redirect: true,
      healthcheckBypass: true,
      trustedProxyAddresses: ["loopback"],
      ...options
    })
  );
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.all("/api/check", (req, res) => res.json({ secure: req.secure, method: req.method }));
  return app;
}

describe("HTTPS reverse-proxy enforcement", () => {
  it("accepts HTTPS reported by an explicitly trusted reverse proxy", async () => {
    const response = await request(createTestApp())
      .get("/api/check")
      .set("X-Forwarded-Proto", "https")
      .expect(200);

    expect(response.body).toEqual({ secure: true, method: "GET" });
  });

  it("does not accept a forged forwarded protocol when proxy trust is disabled", async () => {
    const response = await request(createTestApp({ trustedProxyAddresses: [] }, false))
      .get("/api/check?view=recent")
      .set("X-Forwarded-Proto", "https")
      .expect(308);

    expect(response.headers.location).toBe("https://notes.example.com/api/check?view=recent");
  });

  it("does not rely on an unsafe numeric Express trust setting", async () => {
    const response = await request(createTestApp({ trustedProxyAddresses: [] }, 1))
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
  it("uses explicit proxy addresses", () => {
    expect(createExpressTrustProxySetting(0, ["127.0.0.1", "172.18.0.2"])).toEqual([
      "127.0.0.1",
      "172.18.0.2"
    ]);
    expect(createExpressTrustProxySetting(0, [])).toBe(false);
  });

  it("fails closed when numeric hop trust is configured", () => {
    expect(() => createExpressTrustProxySetting(1, [])).toThrow(/TRUST_PROXY_HOPS must remain 0/);
  });

  it("matches exact addresses, CIDRs, and loopback while rejecting broad named private ranges", () => {
    expect(isTrustedProxyRemoteAddress("::ffff:127.0.0.1", ["loopback"])).toBe(true);
    expect(isTrustedProxyRemoteAddress("172.18.0.12", ["172.18.0.0/24"])).toBe(true);
    expect(isTrustedProxyRemoteAddress("172.18.1.12", ["172.18.0.0/24"])).toBe(false);
    expect(isTrustedProxyRemoteAddress("fd00::12", ["uniquelocal"])).toBe(false);
  });

  it("requires a trusted peer and one canonical forwarded HTTPS value", () => {
    const validHeaders = { "x-forwarded-proto": "https" };
    const validRequest = {
      headers: validHeaders,
      socket: { remoteAddress: "127.0.0.1" }
    } as unknown as Parameters<typeof isHttpsRequestFromTrustedProxy>[0];
    const listRequest = {
      headers: { "x-forwarded-proto": "https, http" },
      socket: { remoteAddress: "127.0.0.1" }
    } as unknown as Parameters<typeof isHttpsRequestFromTrustedProxy>[0];

    expect(forwardedProtocol(validHeaders)).toBe("https");
    expect(forwardedProtocol(listRequest.headers)).toBeNull();
    expect(isHttpsRequestFromTrustedProxy(validRequest, ["loopback"])).toBe(true);
    expect(isHttpsRequestFromTrustedProxy(validRequest, ["10.0.0.1"])).toBe(false);
    expect(isHttpsRequestFromTrustedProxy(listRequest, ["loopback"])).toBe(false);
  });
});
