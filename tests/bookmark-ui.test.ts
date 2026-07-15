import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

describe("bookmark block UI", () => {
  it("registers the bookmark slash command and block editor", () => {
    expect(client).toContain('{ type: "BOOKMARK", command: "/bookmark", icon: "bookmark" }');
    expect(client).toContain('createBookmarkEditor(row, getBlockBookmarkData(block))');
    expect(client).toContain('api("/api/bookmarks/preview"');
  });

  it("supports list and gallery modes", () => {
    expect(client).toContain('data.view = button.dataset.bookmarkView === "list" ? "list" : "gallery"');
    expect(client).toContain('items.className = `bookmark-items bookmark-items--${data.view}`');
    expect(styles).toContain(".bookmark-items--list");
    expect(styles).toContain(".bookmark-items--gallery");
  });

  it("shows OpenGraph media and hides descriptions in list item construction", () => {
    expect(client).toContain('image.className = "bookmark-card-image"');
    expect(client).toContain('description.className = "bookmark-card-description"');
    expect(client).toMatch(/if \(view === "list"\) \{[\s\S]*link\.append\(createBookmarkFavicon\(item\)\);[\s\S]*\} else \{/);
  });

  it("includes Korean bookmark labels and status messages", () => {
    expect(i18n).toContain('BOOKMARK: "북마크"');
    expect(i18n).toContain('bookmarkFetching: "OpenGraph 북마크 정보를 불러오는 중입니다..."');
    expect(i18n).toContain('bookmarkAddedFallback: "미리보기를 불러오지 못해');
    expect(client).toContain('response.warning ? "status.bookmarkAddedFallback"');
  });

  it("keeps bookmark galleries responsive", () => {
    expect(styles).toMatch(/\.bookmark-items--gallery\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,/s);
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*\.bookmark-items--gallery,[\s\S]*grid-template-columns:\s*1fr;/s);
  });
});
