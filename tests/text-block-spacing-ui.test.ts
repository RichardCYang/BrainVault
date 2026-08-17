import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

describe("Ordinary text block vertical spacing", () => {
  it("keeps a fixed outer vertical inset and removes line-count-dependent textarea padding", () => {
    expect(styles).toMatch(
      /\.editor-block-row\[data-block-type="MARKDOWN"\] \.text-block-editor\s*\{[^}]*padding-block:\s*0\.32rem;/s
    );
    expect(styles).toMatch(
      /\.editor-block-row\[data-block-type="MARKDOWN"\] \.block-row-input\s*\{[^}]*min-height:\s*1\.5rem;[^}]*padding-block:\s*0;/s
    );
  });

  it("lets plain text autosizing use its CSS minimum instead of the generic 30px floor", () => {
    expect(client).toContain('textarea.closest(\'.editor-block-row[data-block-type="MARKDOWN"]\')');
    expect(client).toContain("const cssMinimumHeight = Number.parseFloat(getComputedStyle(textarea).minHeight);");
    expect(client).toContain(
      "const minimumHeight = isPlainTextBlock && Number.isFinite(cssMinimumHeight) ? cssMinimumHeight : 30;"
    );
  });
});
