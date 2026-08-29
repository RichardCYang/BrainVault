import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const authRoutes = readFileSync(new URL("../src/routes/auth.routes.ts", import.meta.url), "utf8");
const directRoutes = readFileSync(new URL("../src/routes/passkey-login.routes.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/040_passkey_direct_login.sql", import.meta.url), "utf8");

describe("direct passkey login UI contract", () => {
  it("offers passkey-first login without requiring an ID or password", () => {
    expect(index).toContain('autocomplete="username webauthn"');
    expect(index).toContain('id="auth-passkey-login"');
    expect(index).toContain('data-i18n="auth.passkeyLogin"');
    expect(client).toContain('api("/api/auth/passkey/options"');
    expect(client).toContain('api("/api/auth/passkey/verify"');
    expect(client).toContain("getWebAuthnCredential(optionsData.options, { trigger: elements.authPasskeyLogin })");
    expect(client).toContain("await completeAuthenticatedLogin(data)");
    expect(styles).toContain(".auth-passkey-login-section");
  });

  it("keeps the native WebAuthn hand-off foreground-coupled and removes avoidable pre-prompt STUN waits", () => {
    expect(client).toContain("function assertWebAuthnForeground(trigger)");
    expect(client).toContain('document.visibilityState === "visible"');
    expect(client).toContain("document.hasFocus()");
    expect(client).toContain('trigger.focus({ preventScroll: true })');
    expect(client).toContain('t("mfa.passkeyForegroundRequired")');
    expect(client).toContain('skipClientNetworkVerification = false');
    expect(client).toMatch(/api\("\/api\/auth\/passkey\/options"[\s\S]*?skipClientNetworkVerification: true/);
    expect(client).toMatch(/api\("\/api\/auth\/me"[\s\S]*?skipClientNetworkVerification: true/);
    expect(client).toContain("getWebAuthnCredential(optionsData.options, { trigger: elements.mfaLoginPasskey })");
    expect(styles).toContain('.auth-passkey-login[aria-disabled="true"]');
    expect(i18n).toContain("passkeyForegroundRequired:");
  });

  it("hides the passkey action during registration and serializes userHandle", () => {
    expect(client).toContain('elements.authPasskeyLoginSection.classList.toggle("hidden", isRegister)');
    expect(client).toContain('elements.username.autocomplete = isRegister ? "username" : "username webauthn"');
    expect(client).toContain("if (response.userHandle) serialized.response.userHandle");
  });

  it("provides localized UI and a generic passkey-login failure message", () => {
    expect((i18n.match(/passkeyDivider:/g) ?? []).length).toBe(7);
    expect((i18n.match(/passkeyLogin:/g) ?? []).length).toBe(7);
    expect((i18n.match(/PASSKEY_LOGIN_FAILED:/g) ?? []).length).toBe(7);
    expect(i18n).toContain('passkeyLogin: "패스키로 바로 로그인"');
  });

  it("mounts a dedicated anonymous ceremony backed by its own migration", () => {
    expect(authRoutes).toContain('authRouter.use("/passkey", passkeyLoginRouter)');
    expect(directRoutes).toContain('allowCredentials: []');
    expect(directRoutes).toContain('userVerification: "required"');
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS passkey_login_challenges");
    expect(migration).toContain("binding_hash CHAR(64) NOT NULL");
    expect(migration).toContain("used_at DATETIME(3) NULL");
  });
});
