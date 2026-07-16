import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");
const dataSource = fs.readFileSync(path.join(root, "public/emoji-data.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations/009_pages_collection_kind.sql"), "utf8");

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
    expect(index).toContain('id="emoji-category-list"');
    expect(index).toContain('id="emoji-grid"');
    expect(styles).toContain(".emoji-picker");
    expect(styles).toContain(".emoji-category-button");
  });

  it("ships a broad Unicode 17 dataset with Korean and English search metadata", () => {
    const records = readGeneratedEmojiRecords();
    expect(records.length).toBeGreaterThan(3900);
    expect(records.some(([emoji, , ko, en]) => emoji === "😀" && ko.includes("웃") && en.includes("grinning"))).toBe(true);
    expect(records.some(([emoji]) => emoji === "🧑🏻‍🩰")).toBe(true);
    expect(dataSource).toContain("Unicode Emoji 17");
  });

  it("persists selected emojis and keeps collection identity separate from the icon", () => {
    expect(app).toContain('body: { icon: emoji }');
    expect(app).toContain('body: { defaultCollectionIcon: emoji }');
    expect(app).toContain('isCollection: true');
    expect(app).toContain('page?.isCollection === true');
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS is_collection");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS default_collection_icon");
    expect(migration).toContain("SET is_collection = 1");
  });
});
