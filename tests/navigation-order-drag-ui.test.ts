import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

describe("Sidebar navigation drag ordering", () => {
  it("uses persisted navigation rank only for sidebar tree ordering and keeps recent-first fallback", () => {
    expect(client).toContain("function sortByNavigationOrder(items)");
    expect(client).toContain("state.navigationPageOrder.get(a.id)");
    expect(client).toContain("if (aRanked !== bRanked) return aRanked ? 1 : -1;");
    expect(client).toContain("const sortChildren = useNavigationOrder ? sortByNavigationOrder : sortByRecent;");
    expect(client).toContain("buildPageTree(pages, { useNavigationOrder: true })");
    expect(client).toContain("buildPageTree(defaultPages, { useNavigationOrder: true })");
    expect(client).toContain("return sortByNavigationOrder(pages.filter(isCollectionPage));");
  });

  it("drags from the existing three-dot action button with Pointer Events on mouse and touch", () => {
    expect(client).toContain('button.setAttribute("aria-grabbed", "false")');
    expect(client).toContain('elements.appSidebar.addEventListener("pointerdown"');
    expect(client).toContain('elements.appSidebar.addEventListener("pointermove"');
    expect(client).toContain('elements.appSidebar.addEventListener("pointerup"');
    expect(client).toContain('elements.appSidebar.addEventListener("pointercancel"');
    expect(client).toContain('elements.appSidebar.addEventListener("lostpointercapture"');
    expect(client).toContain('handle.setPointerCapture?.(event.pointerId)');
    expect(client).toContain('const threshold = event.pointerType === "touch" ? 7 : 4;');
    expect(styles).toMatch(/\.app-mode \.navigation-more-button\s*\{[^}]*touch-action:\s*none;/s);
    expect(styles).toMatch(/@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.app-mode \.navigation-more-button\s*\{[^}]*opacity:\s*0\.72;/s);
  });

  it("persists only the sibling display order and rolls the UI back after a failed save", () => {
    expect(client).toContain('api("/api/auth/navigation-order"');
    expect(client).toContain('body: { pageIds: orderedIds }');
    expect(client).toContain("const previousOrder = snapshotNavigationPageOrder(orderedIds);");
    expect(client).toContain("applyNavigationPageOrder(orderedIds);");
    expect(client).toContain("restoreNavigationPageOrder(previousOrder);");
    expect(client).toContain("renderPages();");
    expect(client).toContain("suppressNavigationMenuClickUntil = Date.now() + 500;");
    expect(client).toContain("if (Date.now() < suppressNavigationMenuClickUntil) return;");
  });

  it("does not reorder from a filtered sidebar where hidden siblings could be omitted", () => {
    expect(client).toMatch(/state\.searchQuery\s*\n\s*\|\| state\.activeTag/);
  });
});
