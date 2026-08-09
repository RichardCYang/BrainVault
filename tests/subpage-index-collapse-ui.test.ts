import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

describe("Subpage index and collapsible page navigation", () => {
  it("shows a subpage index in the parent page view when children exist", () => {
    expect(index).toContain('id="subpage-index"');
    expect(index).toContain('id="subpage-index-list"');
    expect(index).toContain('data-i18n="page.subpagesTitle"');
    expect(client).toContain("function renderSubpageIndex(page = state.selectedPage)");
    expect(client).toContain("const children = groups.get(page.id) ?? [];");
    expect(client).toContain('button.dataset.subpageIndexPageId = page.id;');
    expect(client).toContain("await openPage(item.dataset.subpageIndexPageId);");
  });

  it("renders a left-side filled triangle disclosure button for parent pages", () => {
    expect(client).toContain('button.className = "doc-expand-button";');
    expect(client).toContain('button.setAttribute("aria-controls", controlsId);');
    expect(client).toContain('button.setAttribute("aria-expanded", String(expanded));');
    expect(client).toContain('button.classList.toggle("collapsed", !expanded);');
    expect(client).toContain('path.setAttribute("d", "M6.75 8.5 17.25 8.5 12 14.5Z");');
    expect(styles).toContain(".doc-expand-button");
    expect(styles).toMatch(/\.document-item-row\s*\{[\s\S]*grid-template-columns:\s*1\.75rem minmax\(0, 1fr\) 1\.75rem;/);
    expect(styles).toMatch(/\.document-item\s*\{[\s\S]*?grid-column:\s*2;[\s\S]*?grid-row:\s*1;/);
    expect(styles).toContain(".document-item-row > .navigation-more-button");
    expect(styles).toMatch(/\.doc-expand-button\s*\{[\s\S]*?grid-column:\s*1;[\s\S]*?grid-row:\s*1;/);
    expect(styles).toMatch(/\.doc-expand-button svg\s*\{[\s\S]*?fill:\s*currentColor;[\s\S]*?stroke:\s*none;/);
    expect(styles).toMatch(/\.document-item-row > \.navigation-more-button\s*\{[\s\S]*?grid-column:\s*3;[\s\S]*?grid-row:\s*1;/);
  });

  it("persists collapse state across navigation tree rerenders and keeps new subpages expanded", () => {
    expect(client).toContain("collapsedNavigationPageIds: new Set()");
    expect(client).toContain("function setNavigationSubpagesExpanded(pageId, expanded)");
    expect(client).toContain("state.collapsedNavigationPageIds.delete(pageId);");
    expect(client).toContain("state.collapsedNavigationPageIds.add(pageId);");
    expect(client).toContain("setNavigationSubpagesExpanded(parentPageId, true);");
    expect(client).toContain('const childrenToggle = event.target.closest("[data-page-children-toggle-id]");');
  });

  it("localizes the Korean subpage index and disclosure labels", () => {
    expect(i18n).toContain('expandSubpages: "“{title}” 하위 페이지 펼치기"');
    expect(i18n).toContain('collapseSubpages: "“{title}” 하위 페이지 접기"');
    expect(i18n).toContain('subpagesEyebrow: "페이지 목차"');
    expect(i18n).toContain('subpagesTitle: "하위 페이지"');
    expect(i18n).toContain('subpagesAria: "하위 페이지 목차"');
  });
});
