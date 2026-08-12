import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  normalizeAccordionData,
  summarizeAccordionData
} from "../public/accordion-block.js";
import { setLanguage, t } from "../public/i18n.js";
import { getIconPickerTargetKey } from "../public/icon-picker-operation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

test("accordion client metadata keeps order, icons, open state, and bounded derived markdown", () => {
  const data = normalizeAccordionData({
    title: "FAQ",
    showOrder: true,
    items: [
      { id: "second", icon: "🚀", title: "Deploy", content: "B", open: false },
      { id: "first", icon: "icon:star", title: "Verify", content: "A", open: true }
    ]
  });

  assert.equal(data.showOrder, true);
  assert.deepEqual(data.items.map((item) => item.id), ["second", "first"]);
  assert.deepEqual(data.items.map((item) => item.icon), ["🚀", "icon:star"]);
  assert.deepEqual(data.items.map((item) => item.open), [false, true]);

  const summary = summarizeAccordionData({
    title: "T".repeat(120),
    items: Array.from({ length: 50 }, (_, index) => ({
      id: `item-${index}`,
      icon: "📄",
      title: "Q".repeat(300),
      content: "A".repeat(8000),
      open: true
    }))
  });
  assert.equal(summary.length, 20_000);
});

test("accordion translations and item icon picker scope are complete", () => {
  for (const language of ["en", "ko", "ja", "fr", "de", "es", "pt"]) {
    setLanguage(language, { persist: false });
    for (const key of [
      "blocks.types.ACCORDION",
      "slash.ACCORDION.label",
      "menu.accordionOptions",
      "menu.accordionShowOrder",
      "accordion.defaultTitle",
      "accordion.addItem",
      "accordion.dragItem",
      "accordion.changeIcon",
      "accordion.moveUp",
      "accordion.moveDown",
      "accordion.removeItem",
      "accordion.iconSaved",
      "accordion.orderEnabled",
      "accordion.orderDisabled"
    ]) {
      assert.notEqual(t(key, { number: 1, title: "Item" }), key, `${language}:${key}`);
    }
  }

  assert.equal(
    getIconPickerTargetKey({ type: "accordionItem", pageId: "page", blockId: "block", itemId: "item" }),
    "accordion:page:block:item"
  );
});

test("accordion UI, persistence, collaboration, backup, and structured integrity hooks stay registered", () => {
  const app = read("public/app.js");
  const editor = read("public/accordion-block.js");
  const styles = read("public/styles.css");
  const index = read("public/index.html");
  const sources = [
    read("public/collaboration.js"),
    read("src/lib/data-transfer.ts"),
    read("src/types/domain.ts"),
    read("src/utils/schemas.ts"),
    read("src/lib/structured-metadata-integrity.ts"),
    read("src/lib/markdown.ts"),
    read("src/routes/block.routes.ts")
  ];

  assert.match(app, /\{ type: "ACCORDION", command: "\/accordion", icon: "accordion" \}/);
  assert.match(app, /createAccordionEditor\(row, getBlockAccordionData\(block\)/);
  assert.match(app, /setAccordionItemIcon\(row, target\.itemId, emoji, renderIconValue\)/);
  assert.match(app, /setAccordionShowOrder\(row, !current\)/);
  assert.match(app, /details\.rendered-toggle, details\.rendered-accordion-item/);
  assert.match(editor, /dragHandle\.draggable = true/);
  assert.match(editor, /dataTransfer\?\.setData\("text\/plain", draggedId\)/);
  assert.match(editor, /accordion-move-up/);
  assert.match(editor, /accordion-move-down/);
  assert.match(editor, /aria-expanded/);
  assert.match(index, /data-action="toggle-accordion-order"/);
  assert.match(index, /role="menuitemcheckbox"/);
  assert.match(styles, /\.accordion-block-editor\.show-order \.accordion-item-order/);
  assert.match(styles, /\.rendered-accordion-summary/);
  for (const source of sources) assert.match(source, /ACCORDION/);
});

test("all replayable blocks.type enum migrations include ACCORDION and migration 053 is non-destructive", () => {
  const schemas = read("src/utils/schemas.ts");
  const schemaMatch = schemas.match(/blockTypeSchema\s*=\s*z\.enum\(\[([\s\S]*?)\]\)/);
  assert.ok(schemaMatch);
  const expected = [...schemaMatch[1].matchAll(/"([A-Z0-9_]+)"/g)].map((entry) => entry[1]);
  assert.ok(expected.includes("ACCORDION"));

  let enumMigrationCount = 0;
  for (const name of fs.readdirSync(path.join(root, "migrations")).filter((entry) => entry.endsWith(".sql"))) {
    const sql = read(path.join("migrations", name));
    const match = sql.match(/(?:type\s+|MODIFY\s+COLUMN\s+type\s+)ENUM\s*\(([^)]*)\)/i);
    if (!match) continue;
    enumMigrationCount += 1;
    const values = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    assert.deepEqual(values, expected, name);
  }
  assert.ok(enumMigrationCount > 1);

  const migration = read("migrations/053_blocks_accordion_type.sql");
  assert.match(migration, /'TOGGLE', 'ACCORDION', 'TABLE'/);
  assert.doesNotMatch(migration, /\b(?:DELETE|DROP|TRUNCATE|UPDATE\s+blocks)\b/i);
});
