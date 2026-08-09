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

  it("supports an editable block title like the Kanban board", () => {
    expect(client).toContain('titleInput.className = "bookmark-title-input"');
    expect(client).toContain('titleInput.maxLength = bookmarkLimits.blockTitleLength');
    expect(client).toContain('titleInput.placeholder = t("bookmark.titlePlaceholder")');
    expect(client).toContain('const titleInput = row?.querySelector(".bookmark-title-input")');
    expect(client).toContain('title: titleInput ? titleInput.value : data.title');
    expect(client).toContain('const bookmarkTitle = event.target.closest(".bookmark-title-input")');
    expect(client).toContain('const titleInput = row.querySelector(".bookmark-title-input")');
    expect(styles).toMatch(/\.bookmark-title-input\s*\{[^}]*font-size:\s*clamp\(1\.32rem, 2\.3vw, 1\.72rem\);/s);
    expect(i18n).toContain('defaultTitle: "북마크"');
    expect(i18n).toContain('titlePlaceholder: "북마크 블록 제목"');
  });

  it("supports list and gallery modes", () => {
    expect(client).toContain('data.view = button.dataset.bookmarkView === "list" ? "list" : "gallery"');
    expect(client).toContain('items.className = `bookmark-items bookmark-items--${data.view}`');
    expect(styles).toContain(".bookmark-items--list");
    expect(styles).toContain(".bookmark-items--gallery");
  });

  it("supports one through five columns for list view while defaulting to one", () => {
    expect(client).toContain('view: "gallery", listColumns: 1, items: []');
    expect(client).toContain('maxListColumns: 5');
    expect(client).toContain('listColumnsSelect.className = "bookmark-list-columns-select"');
    expect(client).toContain('listColumnsControl.hidden = data.view !== "list"');
    expect(client).toContain('items.classList.add(`bookmark-items--list-columns-${data.listColumns}`)');
    expect(client).toContain('async function setBookmarkListColumns(row, value)');
    expect(client).toContain('data.listColumns = nextColumns');
    expect(styles).toContain('grid-template-columns: repeat(var(--bookmark-list-columns, 1), minmax(0, 1fr));');
    expect(styles).toContain('.bookmark-items--list-columns-5');
    expect(styles).toContain('.rendered-bookmarks--list-columns-5');
    expect(i18n).toContain('listColumnsLabel: "열"');
    expect(i18n).toContain('columnCount: "{count}열"');
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

  it("merges delayed bookmark previews into the live block without replaying stale metadata", () => {
    expect(client).toContain("function createBookmarkRequestContext(row)");
    expect(client).toContain("function resolveCurrentBookmarkRow(context)");

    const addStart = client.indexOf("async function addBookmarkToRow(row)");
    const addEnd = client.indexOf("async function handleBookmarkAction", addStart);
    const addBody = client.slice(addStart, addEnd);
    const addRequest = addBody.indexOf('await api("/api/bookmarks/preview"');
    const addResolve = addBody.indexOf("const currentRow = resolveCurrentBookmarkRow(context);", addRequest);
    const addLatestRead = addBody.indexOf("const data = extractBookmarkData(currentRow);", addResolve);
    expect(addResolve).toBeGreaterThan(addRequest);
    expect(addLatestRead).toBeGreaterThan(addResolve);
    expect(addBody).toContain("replaceBookmarkEditor(currentRow, data, { focusInput: true });");
    expect(addBody).toContain("await saveBlockRow(currentRow, { quiet: true });");

    const refreshStart = client.indexOf('if (action === "bookmark-refresh")');
    const refreshEnd = client.indexOf("function mountBlockEditor", refreshStart);
    const refreshBody = client.slice(refreshStart, refreshEnd);
    const refreshRequest = refreshBody.indexOf('await api("/api/bookmarks/preview"');
    const latestRead = refreshBody.indexOf("const latestData = extractBookmarkData(currentRow);", refreshRequest);
    expect(latestRead).toBeGreaterThan(refreshRequest);
    expect(refreshBody).toContain("latestData.items.findIndex((item) => item.id === current.id)");
    expect(refreshBody).toContain("!jsonValuesMatch(latestData.items[latestIndex], current)");
    expect(refreshBody).not.toContain("data.items[itemIndex] =");
  });

  it("keeps bookmark galleries responsive", () => {
    expect(styles).toMatch(/\.bookmark-items--gallery\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,/s);
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*\.bookmark-items--gallery,[\s\S]*grid-template-columns:\s*1fr;/s);
  });
});
