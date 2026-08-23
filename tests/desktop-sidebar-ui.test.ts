import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

describe("Desktop workspace sidebar toggle", () => {
  it("adds a desktop-only control for the existing sidebar", () => {
    expect(index).toContain('id="desktop-sidebar-toggle"');
    expect(index).toContain('aria-controls="app-sidebar"');
    expect(index).toContain('aria-expanded="true"');
  });

  it("slides the sidebar away while expanding the desktop content column", () => {
    expect(styles).toMatch(/@media \(min-width: 761px\)[\s\S]*?\.app-mode \.shell\s*\{[\s\S]*?transition:\s*grid-template-columns 220ms/);
    expect(styles).toContain("body.app-mode.desktop-sidebar-collapsed .shell");
    expect(styles).toMatch(/body\.app-mode\.desktop-sidebar-collapsed \.sidebar\s*\{[\s\S]*?transform:\s*translateX\(-100%\);/);
    expect(styles).toContain("body.app-mode.desktop-sidebar-collapsed .desktop-sidebar-toggle");
  });

  it("keeps desktop state separate from the existing mobile drawer behavior", () => {
    expect(client).toContain('const desktopSidebarMedia = window.matchMedia("(min-width: 761px)")');
    expect(client).toContain("function toggleDesktopSidebar()");
    expect(client).toContain('document.body.classList.toggle("desktop-sidebar-collapsed")');
    expect(client).toContain('elements.desktopSidebarToggle.addEventListener("click", toggleDesktopSidebar)');
    expect(client).toContain("function openMobileSidebar()");
    expect(client).toContain("function closeMobileSidebar({ restoreFocus = false } = {})");
  });

  it("updates accessibility state and respects reduced-motion preferences", () => {
    expect(client).toContain("function syncDesktopSidebarAccessibility()");
    expect(client).toContain('elements.appSidebar.inert = collapsed');
    expect(client).toContain('elements.desktopSidebarToggle.setAttribute("aria-expanded", String(!collapsed))');
    expect(styles).toContain("@media (prefers-reduced-motion: reduce) and (min-width: 761px)");
  });
});
