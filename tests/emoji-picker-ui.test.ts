import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");
const dataSource = fs.readFileSync(path.join(root, "public/emoji-data.js"), "utf8");
const iconDataSource = fs.readFileSync(path.join(root, "public/icon-data.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations/009_pages_collection_kind.sql"), "utf8");
const customIconMigration = fs.readFileSync(path.join(root, "migrations/026_page_custom_icons.sql"), "utf8");

function readGeneratedEmojiRecords() {
  const prefix = "export const emojiRecords = Object.freeze(";
  const start = dataSource.indexOf(prefix);
  const end = dataSource.indexOf(");", start);
  if (start < 0 || end < 0) throw new Error("Unable to parse generated emoji data");
  const json = dataSource.slice(start + prefix.length, end).replace(/,\s*]\s*$/, "]");
  return JSON.parse(json) as Array<[string, number, string, string, string, string]>;
}

describe("page and collection emoji picker", () => {
  it("renders page, collection, search, category, and result controls", () => {
    expect(index).toContain('id="page-icon-button"');
    expect(index).toContain('id="collection-icon-button"');
    expect(index).toContain('id="emoji-search-input"');
    expect(index).toContain('id="emoji-random-button"');
    expect(index).toContain('id="emoji-skin-tone-button"');
    expect(index).toContain('id="emoji-skin-tone-menu"');
    expect(index).toContain('id="emoji-category-list"');
    expect(index).toContain('id="emoji-recent-grid"');
    expect(index).toContain('id="emoji-grid"');
    expect(index).toContain('class="emoji-picker-tabs"');
    expect(index).toContain('data-icon-picker-tab="icons"');
    expect(index).toContain('data-icon-picker-tab="custom"');
    expect(index).not.toMatch(/id="emoji-tab-(?:icons|custom)"[^>]*disabled/);
    expect(index).toContain('id="emoji-custom-url-input"');
    expect(index).toContain('id="emoji-custom-file-input"');
    expect(index).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(styles).toContain(".emoji-picker");
    expect(styles).toContain(".emoji-picker-tab.active::after");
    expect(styles).toContain(".emoji-picker-toolbar");
    expect(styles).toContain(".emoji-category-button");
    expect(styles).toContain(".emoji-skin-tone-menu");
    expect(styles).toContain(".emoji-custom-panel");
    expect(styles).toContain(".emoji-option.icon-option");
    expect(styles).toContain(".app-icon-image");
    expect(app).toContain('const emojiSkinToneStorageKey = "brainvault.emojiSkinTone"');
    expect(app).toContain("Math.random() * state.emojiPickerResults.length");
    expect(app).toContain("saveEmojiSelection(null)");
    expect(app).toContain('const builtInIconPrefix = "icon:"');
    expect(app).toContain('const imageIconPrefix = "image:"');
    expect(app).toContain('event.target.closest("[data-icon-name]")');
    expect(app).toContain("new FileReader()");
    expect(app).toContain("new URL(source)");
    expect(app).toContain("handleIconPickerTabKeydown");
    expect(styles).toMatch(/\.emoji-picker\s*\{[^}]*border-radius:\s*var\(--radius-lg\);/s);
    expect(styles).toMatch(/\.emoji-search-label\s*\{[^}]*border-radius:\s*var\(--radius-md\);/s);
    expect(styles).toContain("border-radius: var(--radius-lg);");
  });

  it("ships a broad Unicode 17 dataset with Korean and English search metadata", () => {
    const records = readGeneratedEmojiRecords();
    expect(records.length).toBeGreaterThan(3900);
    expect(records.some(([emoji, , ko, en]) => emoji === "😀" && ko.includes("웃") && en.includes("grinning"))).toBe(true);
    expect(records.some(([emoji]) => emoji === "🧑🏻‍🩰")).toBe(true);
    expect(dataSource).toContain("Unicode Emoji 17");
  });


  it("ships searchable built-in icons and custom image persistence", () => {
    const iconNames = [...iconDataSource.matchAll(/\{ name: "([^"]+)", category:/g)].map((match) => match[1]);
    expect(iconNames.length).toBeGreaterThanOrEqual(50);
    expect(new Set(iconNames).size).toBe(iconNames.length);
    expect(iconDataSource).toContain('labelKo: "폴더"');
    expect(iconDataSource).toContain('labelEn: "Folder"');
    expect(app).toContain('body: { icon: emoji, expectedVersion: currentPage?.version }');
    expect(app).toContain('body: { defaultCollectionIcon: emoji }');
    expect(app).toContain('renderIconValue(elements.pageIconButton, page.icon, "📄")');
    expect(customIconMigration).toMatch(/default_collection_icon MEDIUMTEXT/i);
    expect(customIconMigration).toMatch(/icon MEDIUMTEXT/i);
  });

  it("persists selected emojis and keeps collection identity separate from the icon", () => {
    expect(app).toContain('body: { icon: emoji, expectedVersion: currentPage?.version }');
    expect(app).toContain('body: { defaultCollectionIcon: emoji }');
    expect(app).toContain('isCollection: true');
    expect(app).toContain('page?.isCollection === true');
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS is_collection");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS default_collection_icon");
    expect(migration).toContain("SET is_collection = 1");
  });
});
