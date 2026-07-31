import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const searchRoutes = readFileSync(new URL("../src/routes/search.routes.ts", import.meta.url), "utf8");

describe("Workspace search dialog", () => {
  it("replaces the inline sidebar field with a menu-style dialog trigger", () => {
    expect(index).toContain('id="sidebar-search-shortcut"');
    expect(index).toContain('class="sidebar-utility-button"');
    expect(index).toContain('aria-controls="search-dialog"');
    expect(index).toContain('id="search-layer"');
    expect(index).toContain('id="search-dialog"');
    expect(index).toContain('role="dialog"');
    expect(index.indexOf('id="search-layer"')).toBeLessThan(index.indexOf('id="search-form"'));
    expect(index.indexOf('id="search-form"')).toBeGreaterThan(index.indexOf('id="sidebar-search-shortcut"'));
  });

  it("searches through the dedicated API and opens page or block results", () => {
    expect(client).toContain("function openSearchDialog()");
    expect(client).toContain("function closeSearchDialog({ restoreFocus = true } = {})");
    expect(client).toContain("function handleSearchDialogKeydown(event)");
    expect(client).toContain("getSearchDialogFocusableElements");
    expect(client).toContain('api(`/api/search?${params.toString()}`)');
    expect(client).toContain("function openSearchResult(index)");
    expect(client).toContain("revealSearchResultBlock");
    expect(searchRoutes).toContain('searchRouter.get("/"');
    expect(searchRoutes).toContain('kind: "block" as const');
  });

  it("includes responsive modal styling and localized Korean copy", () => {
    expect(styles).toContain(".search-dialog");
    expect(styles).toContain(".search-dialog-form");
    expect(styles).toContain(".search-result-item");
    expect(styles).toContain("body.search-dialog-open");
    expect(styles).toContain(".search-result-target");
    expect(i18n).toContain('open: "검색 열기"');
    expect(i18n).toContain('help: "페이지 제목과 블록 내용을 검색합니다."');
    expect(i18n).toContain('empty: "일치하는 페이지나 블록이 없습니다."');
  });
});
