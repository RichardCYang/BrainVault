import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderBlockHtml } from "../src/lib/markdown.js";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const collaborationSource = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8");
const dataTransferSource = readFileSync(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../src/utils/schemas.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/032_blocks_toggle_type.sql", import.meta.url), "utf8");

describe("toggle block", () => {
  it("renders a native disclosure with Markdown content", () => {
    const html = renderBlockHtml(
      "TOGGLE",
      "Implementation notes\n**Bold detail** and [safe link](https://example.com)",
      false,
      { toggleOpen: true }
    );

    expect(html).toMatch(/<details class="rendered-toggle" open(?:="")?>/);
    expect(html).toContain('<summary class="rendered-toggle-summary">Implementation notes</summary>');
    expect(html).toContain("<strong>Bold detail</strong>");
    expect(html).toContain('href="https://example.com"');
  });

  it("persists collapsed state and sanitizes title and body markup", () => {
    const html = renderBlockHtml(
      "TOGGLE",
      '<img src=x onerror=alert(1)>\n<script>alert(1)</script>Safe body',
      false,
      '{"toggleOpen":false}'
    );

    expect(html).toMatch(/<details class="rendered-toggle">/);
    expect(html).not.toMatch(/<details class="rendered-toggle" open(?:="")?>/);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).toContain("Safe body");
  });

  it("registers UI, collaboration, backup, migration, styling, and translations", () => {
    expect(appSource).toContain('{ type: "TOGGLE", command: "/toggle", icon: "toggle" }');
    expect(appSource).toContain("createToggleBlockEditor(row, block)");
    expect(appSource).toContain("metadata.toggleOpen = row.dataset.toggleOpen !== \"false\"");
    expect(appSource).toContain('event.target.closest(".rendered-toggle-summary")');
    expect(appSource).toContain("expandToggleDetailsForPdf()");
    expect(collaborationSource).toContain('  "TOGGLE",');
    expect(dataTransferSource).toContain('"CALLOUT", "TOGGLE", "TABLE"');
    expect(schema).toContain('  "TOGGLE",');
    expect(migration).toContain("'CALLOUT', 'TOGGLE', 'TABLE'");
    expect(styles).toContain('.editor-block-row[data-block-type="TOGGLE"]');
    expect(styles).toContain(".rendered-toggle-summary");
    expect(i18n).toContain('titlePlaceholder: "토글 제목"');
  });
});
