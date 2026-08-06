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

  it("provides a complete dark palette for the Office-style authentication frame", () => {
    expect(styles).toMatch(
      /html\[data-theme="dark"\] body\.auth-mode\s*\{[^}]*--auth-office-panel:\s*#20242a;[^}]*--auth-office-sidebar:\s*#1a1e23;[^}]*--auth-office-text-strong:\s*#f4f7fa;/s
    );
    expect(styles).toMatch(
      /html\[data-theme="dark"\] \.auth-mode \.brand,[\s\S]*?\.auth-mode \.auth-visual\s*\{[^}]*background:\s*var\(--auth-office-sidebar\);/
    );
    expect(styles).toMatch(
      /html\[data-theme="dark"\] \.auth-mode \.auth-card\s*\{[^}]*background:\s*var\(--auth-office-panel\);[^}]*box-shadow:\s*none;/s
    );
    expect(styles).toMatch(
      /html\[data-theme="dark"\] \.auth-mode \.auth-header h2,[\s\S]*?\.auth-card \.form-field label\s*\{[^}]*color:\s*var\(--auth-office-text-strong\);/
    );
  });

  it("themes the nested login preview surfaces, separators, cards, tags, and database rows", () => {
    const requiredSelectors = [
      ".office-preview-page-heading",
      ".office-preview-page-icon",
      ".office-preview-view-tools b",
      ".office-preview-status-label--blue",
      ".office-preview-card--complete",
      ".office-preview-tag--purple",
      ".office-preview-database",
      ".office-preview-database-row > span",
      ".office-preview-database-row--head"
    ];

    for (const selector of requiredSelectors) {
      expect(styles).toContain(`html[data-theme="dark"] ${selector}`);
    }

    expect(styles).toMatch(
      /html\[data-theme="dark"\] \.office-preview-card\s*\{[^}]*background:\s*var\(--auth-office-panel-raised\);[^}]*box-shadow:\s*2px 2px 0 rgba\(0, 0, 0, 0\.16\);/s
    );
    expect(styles).not.toMatch(
      /html\[data-theme="dark"\][^{]*\.office-preview-card[^}]*box-shadow:\s*0 18px 48px/s
    );
  });
});
