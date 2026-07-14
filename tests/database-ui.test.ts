import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/database-block.js", import.meta.url), "utf8");

describe("Database block UI", () => {
  it("keeps the database shell and header toolbar transparent", () => {
    expect(styles).toMatch(/\.database-block-editor\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
    expect(styles).toMatch(/\.database-view-settings\s*\{[^}]*background:\s*transparent;/s);
    expect(styles).toMatch(/\.database-table th\s*\{[^}]*background:\s*transparent;/s);
  });

  it("renders the view bar and right-side database actions as one toolbar", () => {
    expect(client).toContain('toolbar.className = "database-toolbar"');
    expect(client).toContain('settings.prepend(properties)');
    expect(client).toContain('settings.append(searchPanel)');
    expect(client).toContain('settings.append(newButtonGroup)');
  });

  it("supports the visual search control and colored select pills", () => {
    expect(client).toContain("applyDatabaseSearch");
    expect(client).toContain('control.classList.add("database-select-chip")');
    expect(styles).toContain('.database-select-chip[data-option-color="blue"]');
  });

  it("inherits BrainVault's light sky-blue theme without changing the transparent layout", () => {
    expect(styles).toMatch(/\.database-block-editor\s*\{[^}]*--database-ink:\s*var\(--ink\);[^}]*--database-accent:\s*var\(--accent\);[^}]*--database-blue:\s*var\(--focus\);/s);
    expect(styles).toMatch(/\.database-view-tab\[aria-pressed="true"\]::after\s*\{[^}]*background:\s*var\(--database-blue\);/s);
    expect(styles).toMatch(/\.database-new-row-button\s*\{[^}]*background:\s*var\(--database-accent\);[^}]*color:\s*var\(--database-accent-ink\);/s);
  });
});
