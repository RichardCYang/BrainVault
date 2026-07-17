import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const authRoutes = readFileSync(new URL("../src/routes/auth.routes.ts", import.meta.url), "utf8");
const mfaRoutes = readFileSync(new URL("../src/routes/mfa.routes.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/010_two_factor_auth.sql", import.meta.url), "utf8");

describe("Two-step verification UI and persistence", () => {
  it("offers TOTP and passkey verification during login and in security settings", () => {
    expect(index).toContain('id="mfa-login-panel"');
    expect(index).toContain('id="mfa-login-totp-form"');
    expect(index).toContain('id="mfa-login-passkey"');
    expect(index).toContain('id="account-totp-setup"');
    expect(index).toContain('id="account-passkey-register-form"');
    expect(index).toContain('id="account-passkey-list"');
    expect(styles).toContain(".mfa-login-panel");
    expect(styles).toContain(".passkey-list-item");
  });

  it("serializes browser WebAuthn responses and completes the MFA challenge before login", () => {
    expect(client).toContain("navigator.credentials.create");
    expect(client).toContain("navigator.credentials.get");
    expect(client).toContain("serializeRegistrationCredential");
    expect(client).toContain("serializeAuthenticationCredential");
    expect(client).toContain('api("/api/auth/mfa/login/totp"');
    expect(client).toContain('api("/api/auth/mfa/login/passkey/verify"');
    expect(authRoutes).toContain("createMfaLoginSession");
    expect(authRoutes).toContain("mfaRequired: true");
    expect(authRoutes).toContain('authRouter.use("/mfa", mfaRouter)');
  });

  it("stores multiple passkeys per user and one-time expiring challenges", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS user_passkeys");
    expect(migration).toContain("KEY idx_user_passkeys_user_id (user_id)");
    expect(migration).not.toContain("UNIQUE KEY uq_user_passkeys_user_id");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS webauthn_challenges");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS mfa_login_sessions");
    expect(mfaRoutes).toContain("excludeCredentials: existingPasskeys.map");
    expect(mfaRoutes).toContain("allowCredentials: passkeys.map");
    expect(mfaRoutes).toContain("last_used_step");
    expect(mfaRoutes).toContain("used_at = CURRENT_TIMESTAMP(3)");
  });
});
