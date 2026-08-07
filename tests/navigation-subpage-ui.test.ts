import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

describe("Nested page creation from navigation menus", () => {
  it("offers an add-subpage action from the shared vertical-three-dot menu", () => {
    expect(index).toContain('id="navigation-add-subpage-button"');
    expect(index).toContain('data-action="add-navigation-subpage"');
    expect(index).toContain('data-i18n="navigationMenu.addSubpage"');
    expect(client).toContain('elements.navigationAddSubpageButton.classList.toggle("hidden", kind !== "page")');
    expect(client).toContain('!item.classList.contains("hidden")');
  });

  it("creates the new page with the selected page as parent and opens it", () => {
    expect(client).toContain("async function createNavigationSubpage()");
    expect(client).toContain("const parentPageId = target.id;");
    expect(client).toContain('{ title: t("newDocumentTitle"), icon: "📄", parentPageId }');
    expect(client).toContain('{ creatingKey: "status.creatingSubpage", createdKey: "status.subpageCreated" }');
    expect(client).toContain('if (button.dataset.action === "add-navigation-subpage")');
    expect(client).toContain("await createNavigationSubpage();");
  });

  it("localizes the new action and status in Korean", () => {
    expect(i18n).toContain('addSubpage: "하위 페이지 추가"');
    expect(i18n).toContain('creatingSubpage: "하위 페이지를 만드는 중입니다..."');
    expect(i18n).toContain('subpageCreated: "하위 페이지를 만들었습니다."');
  });
});
