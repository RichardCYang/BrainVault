import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderBlockHtml, renderMarkdown } from "../src/lib/markdown.js";

describe("LaTeX formula rendering", () => {
  it("renders formula blocks as safe client-side KaTeX placeholders", () => {
    const html = renderBlockHtml("MATH", String.raw`\frac{-b \pm \sqrt{b^2-4ac}}{2a}`);

    expect(html).toContain('class="math-expression math-expression--display"');
    expect(html).toContain('data-math-display="true"');
    expect(html).toContain(String.raw`\frac{-b \pm \sqrt{b^2-4ac}}{2a}`);
  });

  it("recognizes parenthesized, dollar-delimited, and display formulas in Markdown", () => {
    const html = renderMarkdown(String.raw`Inline \(E=mc^2\), also $a^2+b^2=c^2$.

$$\int_0^1 x^2\,dx$$`);

    expect(html.match(/math-expression--inline/g)).toHaveLength(2);
    expect(html).toContain("math-expression--display");
    expect(html).toContain('data-math-display="false"');
  });

  it("does not turn code spans into formulas or allow markup injection", () => {
    const html = renderMarkdown("Code: `$not_math$`. Formula: \\(<img src=x onerror=alert(1)>\\)");

    expect(html).toContain("$not_math$");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=");
    expect(html).toContain("&lt;img");
  });
});

describe("LaTeX editor integration", () => {
  it("includes the formula slash command, inline tool, KaTeX assets, CSP, and migration", async () => {
    const [app, index, styles, server, migration, dataTransfer] = await Promise.all([
      readFile("public/app.js", "utf8"),
      readFile("public/index.html", "utf8"),
      readFile("public/styles.css", "utf8"),
      readFile("src/app.ts", "utf8"),
      readFile("migrations/012_blocks_math_type.sql", "utf8"),
      readFile("src/lib/data-transfer.ts", "utf8")
    ]);

    expect(app).toContain('{ type: "MATH", command: "/math", icon: "math" }');
    expect(app).toContain('format === "math-inline"');
    expect(app).toContain("katex.render");
    expect(index).toContain("katex@0.17.0/dist/katex.min.css");
    expect(index).toContain('data-format="math-inline"');
    expect(styles).toContain(".math-block-preview");
    expect(server).toContain("https://cdn.jsdelivr.net");
    expect(migration).toContain("'MATH'");
    expect(dataTransfer).toContain("renderBlockHtml(block.type, block.markdown");
    expect(dataTransfer).not.toContain("block.markdown, block.html_cache,");
  });
});
