import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

describe("Sidebar bottom actions", () => {
  it("keeps collection creation in the pinned footer and moves account actions into settings", () => {
    const footerStart = index.indexOf('class="sidebar-footer"');
    const addCollection = index.indexOf('id="add-collection-button"');
    const accountLayer = index.indexOf('id="account-settings-layer"');
    const logout = index.indexOf('id="logout-button"');

    expect(footerStart).toBeGreaterThan(index.indexOf('class="sidebar-nav"'));
    expect(addCollection).toBeGreaterThan(footerStart);
    expect(accountLayer).toBeGreaterThan(addCollection);
    expect(logout).toBeGreaterThan(accountLayer);
    expect(index.slice(footerStart, accountLayer)).not.toContain('id="logout-button"');
  });

  it("pins the compact footer while allowing page navigation to scroll", () => {
    expect(styles).toMatch(/\.sidebar-footer\s*\{[^}]*margin-top:\s*auto;/s);
    expect(styles).toMatch(/\.sidebar-nav\s*\{[^}]*flex:\s*1 1 auto;[^}]*align-content:\s*start;[^}]*overflow-y:\s*auto;/s);
    expect(styles).toMatch(/\.nav-section\s*\{[^}]*align-content:\s*start;[^}]*grid-auto-rows:\s*max-content;/s);
    expect(styles).toContain(".account-settings-logout:hover");
  });

  it("creates a folder-style collection page and keeps account actions localized", () => {
    expect(client).toContain("async function createCollection()");
    expect(client).toContain('icon: "📁"');
    expect(client).toContain('elements.addCollectionButton.addEventListener("click"');
    expect(client).toMatch(/elements\.logoutButton\.addEventListener\("click", \(\) => \{[\s\S]*logout\(\)\.catch/);
    expect(i18n).toContain('addCollection: "컬렉션 추가"');
    expect(i18n).toContain('signOut: "로그아웃"');
  });

  it("renders user collections beside the default collection instead of inside it", () => {
    const defaultSection = index.indexOf('class="nav-section default-collection"');
    const defaultSectionEnd = index.indexOf("</section>", defaultSection);
    const collectionList = index.indexOf('id="collection-list"', defaultSectionEnd);
    const navigationEnd = index.indexOf("</nav>", collectionList);

    expect(collectionList).toBeGreaterThan(defaultSectionEnd);
    expect(collectionList).toBeLessThan(navigationEnd);
    expect(client).toContain("function isCollectionPage(page)");
    expect(client).toContain("elements.collectionList.replaceChildren()");
    expect(client).toContain("elements.collectionList.append(renderCollectionSection");
    expect(client).toContain('elements.collectionList.addEventListener("click", handleSidebarPageClick)');
    expect(styles).toContain(".collection-list");
    expect(styles).toContain(".custom-collection .collection-title-button.active");
  });
});
