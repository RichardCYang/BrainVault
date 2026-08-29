import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderBlockHtml } from "../src/lib/markdown.js";
import { blockTypeSchema } from "../src/utils/schemas.js";

const root = process.cwd();

async function source(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("Mermaid block integration", () => {
  it("keeps Mermaid as a first-class persisted block type", async () => {
    expect(blockTypeSchema.options).toContain("MERMAID");
    expect(await source("src/types/domain.ts")).toContain('| "MERMAID"');
    expect(await source("src/lib/data-transfer.ts")).toContain('"MERMAID"');
    expect(await source("public/collaboration.js")).toContain('"MERMAID"');
    expect(await source("migrations/065_blocks_mermaid_type.sql")).toContain("'MERMAID'");
  });

  it("stores only escaped Mermaid source in the server html cache", () => {
    const rendered = renderBlockHtml("MERMAID", 'flowchart TD\nA[<img src=x onerror=alert(1)>] --> B');
    expect(rendered).toContain('class="rendered-mermaid-source"');
    expect(rendered).toContain('class="language-mermaid"');
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("onerror=");
    expect(rendered).not.toContain("<svg");
  });

  it("uses a pinned sandboxed Mermaid browser renderer", async () => {
    const renderer = await source("public/mermaid-block.js");
    expect(renderer).toContain('MERMAID_VERSION = "11.17.2"');
    expect(renderer).toContain('securityLevel: "sandbox"');
    expect(renderer).toContain("startOnLoad: false");
    expect(renderer).toContain('frame.setAttribute("sandbox", "")');
    expect(renderer).toContain("data:text\\/html");
  });

  it("exposes the slash command, live preview, translations, and CSP allowances", async () => {
    const [app, i18n, csp] = await Promise.all([
      source("public/app.js"),
      source("public/i18n.js"),
      source("src/app.ts")
    ]);
    expect(app).toContain('{ type: "MERMAID", command: "/mermaid", icon: "mermaid" }');
    expect(app).toContain('updateMermaidBlockPreview(row, textarea.value)');
    expect(i18n).toContain('catalog.blocks.types.MERMAID = addition.blockType');
    expect(i18n).toContain('blockType: "Mermaid 다이어그램"');
    expect(csp).toContain('https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/');
    expect(csp).toContain('frameSrc: ["\'self\'", "data:"');
  });
});
