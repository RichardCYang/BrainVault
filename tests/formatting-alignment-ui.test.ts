import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderBlockHtml } from "../src/lib/markdown.js";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

describe("Formatting toolbar text alignment", () => {
  it("offers left, center, right, and justify controls", () => {
    for (const alignment of ["left", "center", "right", "justify"]) {
      expect(index).toContain(`data-format="align" data-align="${alignment}"`);
    }
    expect(index).toContain('data-i18n-title="toolbar.alignJustify"');
  });

  it("applies and persists alignment through block metadata", () => {
    expect(client).toContain('row.dataset.textAlign = textAlign');
    expect(client).toContain('textarea.style.textAlign = textAlign');
    expect(client).toContain('metadata.textAlign = textAlign');
    expect(client).toContain('delete metadata.textAlign');
  });

  it("marks the active alignment and keeps the toolbar usable on narrow screens", () => {
    expect(client).toContain('button.setAttribute("aria-pressed", String(button.dataset.align === alignment))');
    expect(styles).toMatch(/\.inline-toolbar\s*\{[^}]*flex-wrap:\s*wrap;[^}]*max-width:\s*calc\(100vw - 24px\);/s);
    expect(styles).toContain('.inline-toolbar button[aria-pressed="true"]');
  });

  it("includes Korean labels for all four alignment actions", () => {
    expect(i18n).toContain('alignLeft: "좌측 정렬"');
    expect(i18n).toContain('alignCenter: "중앙 정렬"');
    expect(i18n).toContain('alignRight: "우측 정렬"');
    expect(i18n).toContain('alignJustify: "폭 맞춤"');
  });

  it("keeps alignment in sanitized server-rendered HTML", () => {
    const centered = renderBlockHtml("MARKDOWN", "Centered text", false, { textAlign: "center" });
    const justified = renderBlockHtml("QUOTE", "Justified text", false, { textAlign: "justify" });
    const fromStoredJson = renderBlockHtml("MARKDOWN", "Stored text", false, '{"textAlign":"right"}');
    const invalid = renderBlockHtml("MARKDOWN", "Default text", false, { textAlign: "unsafe" });

    expect(centered).toContain('class="rendered-text-alignment rendered-text-alignment--center"');
    expect(justified).toContain('class="rendered-text-alignment rendered-text-alignment--justify"');
    expect(fromStoredJson).toContain('class="rendered-text-alignment rendered-text-alignment--right"');
    expect(invalid).not.toContain("rendered-text-alignment--unsafe");
  });
});
