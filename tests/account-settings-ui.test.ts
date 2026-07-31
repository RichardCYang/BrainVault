import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const authRoutes = readFileSync(new URL("../src/routes/auth.routes.ts", import.meta.url), "utf8");
const dataRoutes = readFileSync(new URL("../src/routes/data.routes.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/008_user_account_settings.sql", import.meta.url), "utf8");
const loginHistoryMigration = readFileSync(new URL("../migrations/025_login_history.sql", import.meta.url), "utf8");

describe("Account settings layer", () => {
  it("opens from the sidebar identity card and groups profile, language, security, and logout", () => {
    expect(index).toContain('id="account-settings-trigger"');
    expect(index).toContain('role="dialog"');
    expect(index).toContain('aria-modal="true"');
    expect(index).toContain('data-account-panel="profile"');
    expect(index).toContain('data-account-panel="preferences"');
    expect(index).toContain('data-account-panel="security"');
    expect(index).toContain('data-account-panel="data"');
    expect(index).toContain('id="account-avatar-input"');
    expect(index).toContain('id="language-select"');
    expect(index).toContain('id="account-current-password"');
    expect(index).toContain('data-security-panel="history"');
    expect(index).toContain('id="account-login-history-months"');
    expect(index).toContain('id="account-login-history-body"');
    expect(index).toContain('id="account-data-export"');
    expect(index).toContain('id="account-data-input"');
    expect(index).toContain('id="account-data-import"');
    expect(index).toContain('id="logout-button"');
    expect(index).not.toContain('class="language-switcher"');
  });

  it("manages focus, keyboard dismissal, avatar resizing, and account API calls", () => {
    expect(client).toContain("function openAccountSettings");
    expect(client).toContain("function closeAccountSettings");
    expect(client).toContain('event.key === "Escape"');
    expect(client).toContain("getAccountSettingsFocusableElements");
    expect(client).toContain('canvas.toDataURL("image/webp", 0.86)');
    expect(client).toContain('api("/api/auth/profile"');
    expect(client).toContain('api("/api/auth/password"');
    expect(client).toContain('/api/auth/login-history?months=');
    expect(client).toContain("function renderLoginHistory");
    expect(client).toContain("applyUserPreferredLanguage");
    expect(client).toContain('fetch("/api/data/export"');
    expect(client).toContain('api("/api/data/import"');
  });

  it("includes responsive modal styling, localized copy, and persistent schema support", () => {
    expect(styles).toContain(".account-settings-layer");
    expect(styles).toContain(".account-settings-dialog");
    expect(styles).toContain("body.account-settings-open");
    expect(styles).toMatch(/\.account-settings-backdrop:hover,[\s\S]*background:\s*rgba\(29, 45, 57, 0\.36\);/);
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toContain(".login-history-table");
    expect(styles).toContain(".login-history-result.failure");
    expect(styles).toMatch(/\.account-settings-dialog\s*\{[^}]*border-radius:\s*var\(--radius-lg\);/s);
    expect(styles).toMatch(/\.account-preference-card\s*\{[^}]*border-radius:\s*8px;/s);
    expect(styles).toContain("border-radius: var(--radius-lg) var(--radius-lg) 0 0;");
    expect(i18n).toContain('open: "계정 설정 열기"');
    expect(i18n).toContain('passwordChanged: "비밀번호를 변경했습니다."');
    expect(i18n).toContain('loginHistoryTitle: "로그인 기록"');
    expect(i18n).toContain('loginHistorySummary: "최근 {months}개월 · 총 {count}건"');
    expect(i18n).toContain('exportTitle: "모든 데이터 내보내기"');
    expect(i18n).toContain('importTitle: "백업 복원"');
    expect(authRoutes).toContain('authRouter.patch("/profile"');
    expect(authRoutes).toContain('authRouter.post("/password"');
    expect(authRoutes).toContain('"/login-history"');
    expect(authRoutes).toContain('recordLoginAttempt(user.id, sourceIp, "FAILURE")');
    expect(authRoutes).toContain("verifyPassword(currentPassword");
    expect(dataRoutes).toContain('dataRouter.get("/export"');
    expect(dataRoutes).toContain('dataRouter.post("/import"');
    expect(migration).toContain("avatar_data MEDIUMTEXT");
    expect(migration).toContain("preferred_language VARCHAR(10)");
    expect(loginHistoryMigration).toContain("CREATE TABLE IF NOT EXISTS user_login_attempts");
    expect(loginHistoryMigration).toContain("outcome ENUM('SUCCESS', 'FAILURE')");
    expect(loginHistoryMigration).toContain("source_ip VARCHAR(45)");
  });
});
