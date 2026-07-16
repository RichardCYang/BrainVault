import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

describe("Page and collection deletion menus", () => {
  it("adds an accessible shared context menu with a destructive delete action", () => {
    expect(index).toContain('id="navigation-context-menu"');
    expect(index).toContain('role="menu"');
    expect(index).toContain('data-action="delete-navigation-item"');
    expect(index).toContain('class="danger-menu-item" role="menuitem"');
  });

  it("renders vertical three-dot buttons beside pages and custom collections", () => {
    expect(client).toContain('button.className = "navigation-more-button"');
    expect(client).toContain('button.textContent = "⋮"');
    expect(client).toContain('button.setAttribute("aria-haspopup", "menu")');
    expect(client).toContain('button.setAttribute("aria-expanded", "false")');
    expect(client).toContain('kind: "page"');
    expect(client).toContain('kind: "collection"');
    expect(client).toContain('row.className = "home-document-row"');
    expect(client).toContain('kind: isCollectionPage(page) ? "collection" : "page"');
  });

  it("supports click, touch-generated click, keyboard focus, outside dismissal, and permanent deletion", () => {
    expect(client).toContain("function openNavigationContextMenu");
    expect(client).toContain("function closeNavigationContextMenu");
    expect(client).toContain('{ focusFirst: event.detail === 0 }');
    expect(client).toContain('["ArrowDown", "ArrowUp", "Home", "End"]');
    expect(client).toContain('event.key === "Escape"');
    expect(client).toContain('api(`/api/pages/${target.id}?permanent=true`, { method: "DELETE" })');
    expect(styles).toContain("touch-action: manipulation;");
    expect(styles).toContain("@media (hover: none), (pointer: coarse)");
  });

  it("localizes the Korean menu, confirmation, progress, and completion messages", () => {
    expect(i18n).toContain('openPage: "“{title}” 페이지 메뉴 열기"');
    expect(i18n).toContain('deletePage: "페이지 삭제"');
    expect(i18n).toContain('deleteCollection: "컬렉션 삭제"');
    expect(i18n).toContain('deletingCollection: "컬렉션을 삭제하는 중입니다..."');
    expect(i18n).toContain('collectionDeleted: "컬렉션을 삭제했습니다."');
  });
});
