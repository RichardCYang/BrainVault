import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { signAuthToken, verifyAuthToken } from "../src/lib/auth.js";
import { signCollaborationToken, verifyCollaborationToken } from "../src/lib/collaboration-token.js";
import { isAllowedCorsOrigin } from "../src/middleware/cors.js";

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
      authVersion: 3,
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
});
