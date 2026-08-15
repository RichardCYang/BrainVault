import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const editor = readFileSync(new URL("../public/accordion-block.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const collaboration = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8");
const dataTransfer = readFileSync(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../src/utils/schemas.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/053_blocks_accordion_type.sql", import.meta.url), "utf8");

describe("Accordion block UI integration", () => {
  it("registers the accordion in the block menu, editor mount, collaboration, backup, and validation", () => {
    expect(app).toContain('{ type: "ACCORDION", command: "/accordion", icon: "accordion" }');
    expect(app).toContain('block.type === "ACCORDION"');
    expect(app).toContain("createAccordionEditor(row, getBlockAccordionData(block)");
    expect(app).toContain("metadata.accordion = accordion");
    expect(collaboration).toContain('"ACCORDION"');
    expect(dataTransfer).toContain('"ACCORDION"');
    expect(schema).toContain('"ACCORDION"');
  });

  it("supports item disclosures, per-item icons, drag ordering, and keyboard/mobile order controls", () => {
    expect(editor).toContain('setAttribute("aria-expanded", String(item.open))');
    expect(editor).toContain("dragHandle.draggable = true");
    expect(editor).toContain('event.dataTransfer?.setData("text/plain", draggedId)');
    expect(editor).toContain('moveUp.dataset.action = "accordion-move-up"');
    expect(editor).toContain('moveDown.dataset.action = "accordion-move-down"');
    expect(editor).toContain('iconButton.dataset.action = "accordion-pick-icon"');
    expect(app).toContain('type: "accordionItem"');
    expect(app).toContain("setAccordionItemIcon(row, target.itemId, emoji, renderIconValue)");
    expect(styles).toContain(".accordion-item-drag-handle");
    expect(styles).toContain(".rendered-accordion-summary");
  });

  it("renders accordion item content as Markdown in read mode through the standard HTML cache", () => {
    expect(app).toContain('previewHtml: block.htmlCache ?? ""');
    expect(editor).toContain('preview.innerHTML = previewHtml');
    const markdown = readFileSync(new URL("../src/lib/markdown.ts", import.meta.url), "utf8");
    expect(markdown).toContain('renderAccordionHtml(safeMetadata, renderMarkdown)');
  });

  it("exposes a block option for clean numeric order labels and read/PDF rendering", () => {
    expect(indexHtml).toContain('data-action="toggle-accordion-order"');
    expect(indexHtml).toContain('role="menuitemcheckbox"');
    expect(app).toContain("setAccordionShowOrder(row, !current)");
    expect(editor).toContain('editor.classList.toggle("show-order", data.showOrder)');
    expect(styles).toContain(".accordion-block-editor.show-order .accordion-item-order");
    expect(styles).toContain(".rendered-accordion-order");
    expect(app).toContain("details.rendered-toggle, details.rendered-accordion-item");
    expect(app).toContain("hydrateAccordionIcons(elements.pageView)");
  });

  it("ships Korean labels and a non-destructive enum migration", () => {
    expect(i18n).toContain('blockType: "아코디언"');
    expect(i18n).toContain('showOrder: "항목 순서 번호 표시"');
    expect(migration).toContain("'TOGGLE', 'ACCORDION', 'TABLE'");
    expect(migration).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/i);
  });
});
