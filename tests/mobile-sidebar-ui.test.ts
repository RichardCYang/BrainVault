import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

describe("Mobile workspace navigation drawer", () => {
  it("adds a header hamburger that controls the existing sidebar", () => {
    expect(index).toContain('id="app-sidebar"');
    expect(index).toContain('id="mobile-sidebar-toggle"');
    expect(index).toContain('aria-controls="app-sidebar"');
    expect(index).toContain('aria-expanded="false"');
    expect(index).toContain('id="mobile-sidebar-backdrop"');
    expect(index).toContain('id="mobile-sidebar-close"');
  });

  it("keeps the desktop sidebar and turns only the mobile app sidebar into an off-canvas drawer", () => {
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.app-mode \.sidebar\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?transform:\s*translateX\(-105%\);/);
    expect(styles).toContain("body.app-mode.mobile-sidebar-open .sidebar");
    expect(styles).toContain("body.app-mode.mobile-sidebar-open .mobile-sidebar-backdrop");
    expect(styles).toContain(".mobile-app-header");
    expect(styles).not.toMatch(/@media \(max-width: 760px\)[\s\S]*?\n  \.sidebar \{/);
  });

  it("supports toggle, backdrop, Escape, focus containment, and responsive cleanup", () => {
    expect(client).toContain("function openMobileSidebar()");
    expect(client).toContain("function closeMobileSidebar({ restoreFocus = false } = {})");
    expect(client).toContain('setAttribute("aria-expanded", String(open))');
    expect(client).toContain("elements.appSidebar.inert = mobileLayout && !open");
    expect(client).toContain("elements.main.inert = open");
    expect(client).toContain('event.key === "Escape"');
    expect(client).toContain('event.key !== "Tab"');
    expect(client).toContain("function suppressMobileSidebarTransition()");
    expect(client).toContain('mobileSidebarMedia.addEventListener("change"');
  });

  it("localizes the mobile navigation controls in Korean", () => {
    expect(i18n).toContain('openAria: "탐색 메뉴 열기"');
    expect(i18n).toContain('closeAria: "탐색 메뉴 닫기"');
  });
});
