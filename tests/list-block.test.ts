import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderBlockHtml } from "../src/lib/markdown.js";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const collaborationSource = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8");
const dataTransferSource = readFileSync(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../src/utils/schemas.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/048_blocks_list_types.sql", import.meta.url), "utf8");

describe("list blocks", () => {
  it("renders unordered list items with inline Markdown", () => {
    const html = renderBlockHtml("UNORDERED_LIST", "- Alpha\n- **Beta**\n- [Docs](https://example.com)");

    expect(html).toContain('<ul class="rendered-list rendered-list--unordered">');
    expect(html).toContain("<li>Alpha</li>");
    expect(html).toContain("<strong>Beta</strong>");
    expect(html).toContain('href="https://example.com"');
  });

  it("renders ordered list items and normalizes plain lines", () => {
    const html = renderBlockHtml("ORDERED_LIST", "First\nSecond\nThird");

    expect(html).toContain('<ol class="rendered-list rendered-list--ordered">');
    expect(html).toContain("<li>First</li>");
    expect(html).toContain("<li>Second</li>");
    expect(html).toContain("<li>Third</li>");
  });

  it("keeps list rendering sanitized", () => {
    const html = renderBlockHtml("UNORDERED_LIST", "- Safe\n- <script>alert(1)</script>Still safe");

    expect(html).toContain("Safe");
    expect(html).toContain("Still safe");
    expect(html).not.toContain("<script");
  });

  it("registers menu commands, editor behavior, persistence, migration, styling, and translations", () => {
    expect(appSource).toContain('{ type: "UNORDERED_LIST", command: "/bullet", icon: "unordered-list" }');
    expect(appSource).toContain('{ type: "ORDERED_LIST", command: "/number", icon: "ordered-list" }');
    expect(appSource).toContain('const listBlockTypes = new Set(["UNORDERED_LIST", "ORDERED_LIST"]);');
    expect(appSource).toContain("async function handleListBlockEnter(event, textarea, row)");
    expect(collaborationSource).toContain('  "UNORDERED_LIST",');
    expect(collaborationSource).toContain('  "ORDERED_LIST",');
    expect(dataTransferSource).toContain('"TODO", "UNORDERED_LIST", "ORDERED_LIST", "QUOTE"');
    expect(schema).toContain('  "UNORDERED_LIST",');
    expect(schema).toContain('  "ORDERED_LIST",');
    expect(migration).toContain("'UNORDERED_LIST', 'ORDERED_LIST'");
    expect(styles).toContain('.editor-block-row[data-block-type="UNORDERED_LIST"]');
    expect(styles).toContain('.rendered-list--ordered');
    expect(i18n).toContain('unorderedBlockType: "순서 없는 리스트"');
    expect(i18n).toContain('orderedBlockType: "순서 있는 리스트"');
  });
});
