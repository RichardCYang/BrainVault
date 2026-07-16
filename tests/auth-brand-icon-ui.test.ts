import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("Authentication brand icon", () => {
  it("uses the rounded PNG asset in both authentication and workspace modes", () => {
    expect(index).toContain('<img class="brand-mark" src="/img/icon_normal.png"');
    expect(index).toContain('<img class="brand-mark mobile-app-brand-mark" src="/img/icon_normal.png"');
  });

  it("keeps the desktop brand icon and title aligned to the left", () => {
    const brandButtonRule = styles.match(/\.brand-home-button\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(brandButtonRule).toContain("justify-content: flex-start;");
  });

  it("does not draw a square authentication-only frame behind the transparent PNG corners", () => {
    const authBrandRule = styles.match(/\/\* Keep the raster brand mark[^*]*\*\/\n\.auth-mode \.brand-mark\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(styles).toContain("body.auth-mode * {\n  border-radius: 0 !important;");
    expect(authBrandRule).toContain("display: block;");
    expect(authBrandRule).toContain("border: 0;");
    expect(authBrandRule).toContain("border-radius: 10px !important;");
    expect(authBrandRule).toContain("background: transparent;");
    expect(authBrandRule).toContain("object-fit: contain;");
    expect(authBrandRule).not.toContain("border: 1px solid #277fab;");
    expect(authBrandRule).not.toContain("background: #70c6f2;");
  });
});
