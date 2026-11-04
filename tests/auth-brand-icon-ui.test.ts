import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("Authentication brand icon", () => {
  it("uses the vector logo in both authentication and workspace modes", () => {
    expect(index).toContain('<img class="brand-mark" src="/img/logo.svg"');
    expect(index).toContain('<img class="brand-mark mobile-app-brand-mark" src="/img/logo.svg"');
    expect(index).toContain('<link rel="icon" type="image/svg+xml" href="/img/logo.svg" />');
  });

  it("keeps the desktop brand icon and title aligned to the left", () => {
    const brandButtonRule = styles.match(/\.brand-home-button\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(brandButtonRule).toContain("justify-content: flex-start;");
  });

  it("does not draw a frame behind the transparent PNG corners", () => {
    const authBrandRule = styles.match(/\n\.auth-mode \.brand-mark\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(styles).not.toContain("body.auth-mode * {\n  border-radius: 0 !important;");
    expect(authBrandRule).toContain("border: 0;");
    expect(authBrandRule).toContain("border-radius: var(--radius-md);");
    expect(authBrandRule).toContain("background: transparent;");
    expect(authBrandRule).toContain("box-shadow: none;");
    expect(authBrandRule).toContain("object-fit: contain;");
  });
});
