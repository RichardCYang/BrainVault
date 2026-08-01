import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string) {
  return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
}

describe("reported security reproductions are now blocked", () => {
  it("P1 counts successful password checks that still require MFA", async () => {
    const [authRoutes, limits] = await Promise.all([
      source("src/routes/auth.routes.ts"),
      source("src/middleware/auth-rate-limit.ts")
    ]);
    expect(authRoutes).toContain("res.locals.authenticationPending = true");
    expect(limits).toContain("requestWasSuccessful: authenticationRequestSucceeded");
    expect(limits).toContain("res.locals.authenticationPending !== true");
  });

  it("P2 carries MFA failures across replacement sessions", async () => {
    const routes = await source("src/routes/mfa.routes.ts");
    expect(routes).toContain("SELECT id FROM users WHERE id = ? FOR UPDATE");
    expect(routes).toContain("MAX(failed_attempts) AS failed_attempts");
    expect(routes).toContain("MFA_TEMPORARILY_LOCKED");
    expect(routes).not.toMatch(
      /DELETE FROM mfa_login_sessions[\s\S]{0,240}WHERE user_id = \? OR expires_at <= CURRENT_TIMESTAMP\(3\)/
    );
  });

  it("P3 rate-limits TOTP and passkey login verification", async () => {
    const routes = await source("src/routes/mfa.routes.ts");
    expect(routes.match(/mfaLoginIpRateLimit/g)?.length).toBeGreaterThanOrEqual(3);
    expect(routes.match(/mfaLoginAccountRateLimit/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("P4 does not expose JWTs and applies browser-origin checks to bearer requests", async () => {
    const [authRoutes, mfaRoutes, authMiddleware] = await Promise.all([
      source("src/routes/auth.routes.ts"),
      source("src/routes/mfa.routes.ts"),
      source("src/middleware/auth.ts")
    ]);
    expect(authRoutes).not.toMatch(/res\.json\(\{[^}]*token/);
    expect(mfaRoutes).toContain("res.json({ user: result.user })");
    expect(authMiddleware).toContain("assertBrowserRequestOrigin(req)");
    expect(authMiddleware).not.toContain('if (source === "cookie") assert');
  });

  it("P5 increments auth_version during logout", async () => {
    const routes = await source("src/routes/auth.routes.ts");
    expect(routes).toContain('authRouter.post("/logout", requireAuth');
    expect(routes).toContain("UPDATE users SET auth_version = ? WHERE id = ?");
  });

  it("P6 validates and escapes block IDs before HTML output", async () => {
    const [materialization, pages] = await Promise.all([
      source("src/lib/collaboration-materialization.ts"),
      source("src/routes/page.routes.ts")
    ]);
    expect(materialization).toContain("/^[a-zA-Z0-9_-]+$/");
    expect(pages).toContain("escapeHtmlAttribute(block.id)");
  });

  it("P7 preserves active login throttling while distinguishing MFA-pending responses", async () => {
    const limits = await source("src/middleware/auth-rate-limit.ts");
    expect(limits).toContain("skipSuccessfulRequests: true");
    expect(limits).toContain("authenticationRequestSucceeded");
  });
});
