import { readFileSync } from "node:fs";
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { signAuthToken, verifyAuthToken } from "../src/lib/auth.js";
import { signCollaborationToken, verifyCollaborationToken } from "../src/lib/collaboration-token.js";
import { isAllowedCorsOrigin } from "../src/middleware/cors.js";
import { readAuthSessionCookie } from "../src/lib/session-cookie.js";
import { httpUrlSchema } from "../src/utils/schemas.js";
import { renderMarkdown, sanitizeRenderedHtml } from "../src/lib/markdown.js";

const pageAccessSource = readFileSync(new URL("../src/lib/page-access.ts", import.meta.url), "utf8");
const pageRoutesSource = readFileSync(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8");
const searchRoutesSource = readFileSync(new URL("../src/routes/search.routes.ts", import.meta.url), "utf8");
const collaborationRoutesSource = readFileSync(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../src/utils/schemas.ts", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");

function mockRequest(headers: Record<string, string>): Request {
  return {
    headers,
    header(name: string) {
      return headers[name.toLowerCase()];
    }
  } as unknown as Request;
}

describe("authentication token separation", () => {
  it("rejects a page-scoped collaboration ticket as an API bearer token", () => {
    const ticket = signCollaborationToken({
      sub: "usr_security",
      username: "security-user",
      pageId: "pag_security",
      documentEpoch: "epoch-security",
      shareGeneration: null,
      authVersion: 3,
      workspaceGeneration: 7,
      sessionBinding: "a".repeat(64),
      scope: "page:collaborate"
    });

    try {
      verifyAuthToken(ticket);
      throw new Error("Collaboration ticket unexpectedly passed API verification");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_TOKEN" });
    }
  });

  it("rejects an API bearer token as a collaboration ticket", () => {
    const token = signAuthToken({
      sub: "usr_security",
      username: "security-user",
      authVersion: 3
    });

    try {
      verifyCollaborationToken(token);
      throw new Error("API token unexpectedly passed collaboration verification");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_COLLABORATION_TICKET" });
    }
  });
});

describe("CORS proxy-header hardening", () => {
  it("does not authorize an origin from forgeable forwarding headers", () => {
    const request = mockRequest({
      host: "internal:4000",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "https"
    });

    expect(isAllowedCorsOrigin(request, "https://attacker.example")).toBe(false);
  });

  it("continues to allow explicitly configured origins", () => {
    expect(isAllowedCorsOrigin(mockRequest({}), "http://localhost:4000")).toBe(true);
  });

  it("fails closed when the Origin header is absent", () => {
    expect(isAllowedCorsOrigin(mockRequest({}), undefined)).toBe(false);
  });

  it("rejects unlisted loopback origins even outside production", () => {
    expect(isAllowedCorsOrigin(mockRequest({}), "http://localhost:9999")).toBe(false);
    expect(isAllowedCorsOrigin(mockRequest({}), "http://127.0.0.1:9999")).toBe(false);
  });
});


describe("explicit shared-edit authorization", () => {
  it("requires an EDIT grant instead of treating every share row as editor access", () => {
    expect(pageAccessSource).toContain("ps.permission = 'EDIT'");
    expect(pageRoutesSource).toContain("current_share.permission = 'EDIT'");
    expect(pageRoutesSource).toContain("child_share.permission = 'EDIT'");
    expect(searchRoutesSource).toContain("ps.permission = 'EDIT'");
    expect(collaborationRoutesSource).toContain("ps.permission = 'EDIT'");
  });

  it("uses the restricted generated-ID alphabet for route identifiers", () => {
    expect(schemaSource).toContain("/^[a-zA-Z0-9_-]{1,64}$/");
  });
});


describe("CSP configuration", () => {
  it("keeps Helmet default directives enabled while overriding application fetch sources", () => {
    expect(appSource).not.toContain("useDefaults: false");
    expect(appSource).toContain("contentSecurityPolicy");
    expect(appSource).toContain("imgSrc:");
    expect(appSource).toContain("scriptSrc:");
  });
});

describe("reported security hardening", () => {
  it("accepts only HTTP(S) page cover URLs", () => {
    const schema = httpUrlSchema(500);
    expect(schema.parse("https://example.com/cover.png")).toBe("https://example.com/cover.png");
    expect(() => schema.parse("javascript:alert(1)")).toThrow();
    expect(() => schema.parse("data:text/html,unsafe")).toThrow();
  });

  it("reads the HttpOnly session value from the Cookie header", () => {
    const request = mockRequest({ cookie: "theme=light; brainvault_session=header.payload.signature" });
    expect(readAuthSessionCookie(request)).toBe("header.payload.signature");
  });

  it("does not preserve third-party image loads in rendered content", () => {
    const remoteMarkdown = renderMarkdown("![tracker](https://attacker.example/p.png)");
    expect(remoteMarkdown).not.toContain("attacker.example");

    const sanitized = sanitizeRenderedHtml(
      '<img src="/img/default_cover/coverimg1.png" srcset="https://attacker.example/a.png 2x" alt="cover">'
    );
    expect(sanitized).toContain('src="/img/default_cover/coverimg1.png"');
    expect(sanitized).not.toContain("srcset");
    expect(sanitized).not.toContain("attacker.example");
  });
});
