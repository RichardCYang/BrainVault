import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

describe("Dark theme surface coverage", () => {
  it("recolors the authenticated page header instead of leaving the light translucent surface", () => {
    expect(styles).toMatch(
      /html\[data-theme="dark"\] \.app-mode \.page-view-header\s*\{[^}]*border-bottom-color:\s*var\(--chrome-line\);[^}]*background:\s*rgba\(23, 25, 29, 0\.9\);/s
    );
    expect(styles).toMatch(
      /html\[data-theme="dark"\] \.app-mode button\.page-view-path-segment:hover,[\s\S]*?background:\s*rgba\(255, 255, 255, 0\.06\);/
    );
  });

  it("builds the authentication screen from theme tokens so dark mode follows automatically", () => {
    const authStyles = styles.slice(styles.indexOf("/* Sign-in and sign-up:"));

    expect(authStyles).toMatch(/body\.auth-mode\s*\{[^}]*background:\s*var\(--bg\);[^}]*color:\s*var\(--ink\);/s);
    expect(authStyles).toMatch(/\.auth-mode \.auth-visual\s*\{[^}]*background:\s*var\(--sidebar\);/s);
    expect(authStyles).toMatch(/\.auth-card input\s*\{[^}]*border:\s*1px solid var\(--line-strong\);[^}]*background:\s*var\(--panel\);/s);
    expect(authStyles).toMatch(/\.auth-actions button\s*\{[^}]*background:\s*var\(--accent\);[^}]*color:\s*var\(--accent-ink\);/s);
    expect(authStyles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(styles).not.toContain('html[data-theme="dark"] .auth-mode');
  });

  it("no longer ships the retired login preview mockups", () => {
    expect(styles).not.toContain(".office-preview");
    expect(styles).not.toContain(".auth-preview");
  });
});
