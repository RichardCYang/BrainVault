import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderKanbanHtml } from "../src/lib/kanban.js";

const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

describe("Kanban UI", () => {
  it("uses a database-like title and active board view bar", () => {
    expect(client).toContain('viewbar.className = "kanban-viewbar"');
    expect(client).toContain('viewTab.className = "kanban-view-tab is-active"');
    expect(styles).toMatch(/\.kanban-viewbar\s*\{[^}]*border-bottom:/s);
    expect(styles).toMatch(/\.kanban-view-tab\.is-active::after\s*\{[^}]*background:\s*var\(--focus\);/s);
  });

  it("uses the shared sky-blue theme for Kanban borders and shadows", () => {
    expect(styles).toMatch(/\.kanban-viewbar\s*\{[^}]*border-bottom:\s*1px solid var\(--line\);/s);
    expect(styles).toMatch(/\.kanban-card\s*\{[^}]*--kanban-card-border:\s*var\(--line\);[^}]*--kanban-card-border-hover:\s*var\(--line-strong\);/s);
    expect(styles).toMatch(/\.kanban-empty-column\s*\{[^}]*border:\s*1px dashed var\(--line-strong\);/s);
    expect(styles).toMatch(/\.kanban-card-style-panel\s*\{[^}]*border:\s*1px solid var\(--line-strong\);[^}]*box-shadow:\s*var\(--shadow-popover\);/s);
    expect(styles).toMatch(/\.rendered-kanban-card\s*\{[^}]*--rendered-kanban-card-border:\s*var\(--line\);[^}]*box-shadow:\s*var\(--shadow-card\);/s);
  });

  it("keeps columns transparent and presents colored status labels", () => {
    expect(client).toContain('columnLabel.className = "kanban-column-label"');
    expect(styles).toMatch(/\.kanban-column\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
    expect(styles).toMatch(/\.kanban-column-label\s*\{[^}]*background:\s*var\(--kanban-status-bg\);/s);
  });

  it("renders editable property tags as compact colored chips", () => {
    expect(client).toContain('tagsPreview.className = "kanban-card-tags-preview"');
    expect(client).toContain("syncKanbanTagField(tagsInput)");
    expect(styles).toContain(".kanban-card-tag--0");
    expect(styles).toContain(".rendered-kanban-tag--5");
  });

  it("applies selected card colors to the full card background", () => {
    expect(styles).toMatch(/\.kanban-card\s*\{[^}]*background-color:\s*var\(--kanban-card-bg\);/s);
    expect(styles).toMatch(/\.kanban-card\[data-card-color="pink"\]\s*\{[^}]*--kanban-card-bg:\s*#f7dfe7;/s);
    expect(styles).toMatch(/\.kanban-card\[data-card-color="blue"\]\s*\{[^}]*--kanban-card-bg:\s*#dfeaf2;/s);
    expect(styles).toMatch(/\.rendered-kanban-card\s*\{[^}]*background-color:\s*var\(--rendered-kanban-card-bg\);/s);
    expect(styles).not.toContain("inset 3px 0 0 var(--kanban-card-accent)");
    expect(styles).not.toContain("inset 3px 0 0 var(--rendered-kanban-card-accent)");
  });

  it("applies the same visual structure to read-only Kanban output", () => {
    const html = renderKanbanHtml({
      kanban: {
        title: "Workflow",
        columns: [{
          id: "planning",
          title: "Planning",
          color: "blue",
          cards: [{
            id: "card-1",
            title: "Annual report",
            description: "Prepare the report",
            icon: "",
            color: "default",
            tags: ["High", "On track"]
          }]
        }]
      }
    });

    expect(html).toContain('class="rendered-kanban-viewbar"');
    expect(html).toContain('class="rendered-kanban-column-label"');
    expect(html).toContain('rendered-kanban-tag--0');
    expect(html).toContain('rendered-kanban-tag--1');
    expect(html).toContain('class="rendered-kanban-card-heading"');
  });
});
