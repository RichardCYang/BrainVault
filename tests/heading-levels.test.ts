import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderBlockHtml } from "../src/lib/markdown.js";
import { blockTypeSchema } from "../src/utils/schemas.js";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const collaborationSource = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8");
const dataTransferSource = readFileSync(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/066_blocks_heading_4_5_types.sql", import.meta.url), "utf8");

function blockEnumValues(sql: string) {
  const match = sql.match(/(?:type\s+|MODIFY\s+COLUMN\s+type\s+)ENUM\s*\(([^)]*)\)/i);
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]) : null;
}

describe("Heading 4 and Heading 5 blocks", () => {
  it("renders semantic h4 and h5 elements and strips pasted heading markers", () => {
    expect(renderBlockHtml("HEADING_4", "#### Project details")).toContain("<h4>Project details</h4>");
    expect(renderBlockHtml("HEADING_5", "##### Edge cases")).toContain("<h5>Edge cases</h5>");
  });

  it("keeps text alignment metadata for both heading levels", () => {
    const h4 = renderBlockHtml("HEADING_4", "Centered", false, { textAlign: "center" });
    const h5 = renderBlockHtml("HEADING_5", "Right", false, { textAlign: "right" });

    expect(h4).toContain("rendered-text-alignment--center");
    expect(h5).toContain("rendered-text-alignment--right");
  });

  it("registers slash commands, collaboration, backup/restore, PDF styling, and translations", () => {
    expect(appSource).toContain('{ type: "HEADING_4", command: "/h4", icon: "heading-4" }');
    expect(appSource).toContain('{ type: "HEADING_5", command: "/h5", icon: "heading-5" }');
    expect(appSource).toContain('HEADING_4: "blocks.types.HEADING_4"');
    expect(appSource).toContain('HEADING_5: "blocks.types.HEADING_5"');
    expect(collaborationSource).toContain('  "HEADING_4",');
    expect(collaborationSource).toContain('  "HEADING_5",');
    expect(dataTransferSource).toContain('"HEADING_3", "HEADING_4", "HEADING_5", "TODO"');
    expect(styles).toContain('.editor-block-row[data-block-type="HEADING_4"]');
    expect(styles).toContain('.editor-block-row[data-block-type="HEADING_5"]');
    expect(styles).toContain(".block-rendered-preview h4");
    expect(styles).toContain(".block-rendered-preview h5");
    expect(i18n).toContain('HEADING_4: "제목 4"');
    expect(i18n).toContain('HEADING_5: "제목 5"');
    expect(i18n).toContain('HEADING_4: { label: "Heading 4"');
    expect(i18n).toContain('HEADING_5: { label: "Heading 5"');
  });

  it("accepts both new types in API validation and every replayable block enum migration", () => {
    expect(blockTypeSchema.safeParse("HEADING_4").success).toBe(true);
    expect(blockTypeSchema.safeParse("HEADING_5").success).toBe(true);
    expect(migration).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE|UPDATE\s+blocks)\b/i);

    const expected = [...blockTypeSchema.options];
    const migrationsDir = new URL("../migrations/", import.meta.url);
    const enumMigrations = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(new URL(name, migrationsDir), "utf8"))
      .filter((sql) => /\b(?:type\s+|MODIFY\s+COLUMN\s+type\s+)ENUM\s*\(/i.test(sql));

    for (const sql of enumMigrations) {
      expect(blockEnumValues(sql)).toEqual(expected);
    }
  });
});
