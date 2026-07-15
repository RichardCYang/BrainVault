import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

describe("Sidebar bottom actions", () => {
  it("places add collection immediately above logout at the bottom of the workspace sidebar", () => {
    const footerStart = index.indexOf('class="sidebar-footer"');
    const addCollection = index.indexOf('id="add-collection-button"');
    const logout = index.indexOf('id="logout-button"');
    const workspaceEnd = index.indexOf("</section>", logout);

    expect(footerStart).toBeGreaterThan(index.indexOf('class="sidebar-nav"'));
    expect(addCollection).toBeGreaterThan(footerStart);
    expect(logout).toBeGreaterThan(addCollection);
    expect(workspaceEnd).toBeGreaterThan(logout);
  });

  it("pins the footer while allowing a compact, non-stretched page navigation to scroll", () => {
    expect(styles).toMatch(/\.sidebar-footer\s*\{[^}]*margin-top:\s*auto;/s);
    expect(styles).toMatch(/\.sidebar-nav\s*\{[^}]*flex:\s*1 1 auto;[^}]*align-content:\s*start;[^}]*overflow-y:\s*auto;/s);
    expect(styles).toMatch(/\.nav-section\s*\{[^}]*align-content:\s*start;[^}]*grid-auto-rows:\s*max-content;/s);
    expect(styles).toContain(".sidebar-footer-button--danger:hover");
  });

  it("creates a folder-style collection page and keeps both actions localized", () => {
    expect(client).toContain("async function createCollection()");
    expect(client).toContain('icon: "📁"');
    expect(client).toContain('elements.addCollectionButton.addEventListener("click"');
    expect(i18n).toContain('addCollection: "컬렉션 추가"');
    expect(i18n).toContain('collectionCreated: "‘{name}’ 컬렉션을 만들었습니다."');
  });
});
