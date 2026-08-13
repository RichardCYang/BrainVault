import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

describe("Kanban column drag ordering", () => {
  it("uses the existing three-dot delete button as a pointer drag handle on mouse and touch", () => {
    expect(client).toContain('deleteColumn.setAttribute("aria-grabbed", "false")');
    expect(client).toContain('const handle = event.target.closest(".kanban-column-menu")');
    expect(client).toContain('handle.setPointerCapture?.(event.pointerId)');
    expect(client).toContain('const threshold = event.pointerType === "touch" ? 7 : 4;');
    expect(client).toContain('drag.targetIndex = getKanbanColumnInsertionIndex(event.clientX, drag.candidates)');
    expect(styles).toMatch(/\.kanban-column-menu\s*\{[^}]*cursor:\s*grab;[^}]*touch-action:\s*none;/s);
    expect(styles).toMatch(/@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.kanban-column-menu\s*\{[^}]*opacity:\s*0\.72;/s);
  });

  it("reorders the extracted board data, persists through the normal block-save path, and suppresses delete click after a drag", () => {
    expect(client).toContain('suppressKanbanColumnMenuClickUntil = Date.now() + 500;');
    expect(client).toContain('const sourceIndex = data.columns.findIndex((column) => column.id === drag.column.dataset.columnId);');
    expect(client).toContain('data.columns.splice(Math.min(drag.targetIndex, data.columns.length), 0, column);');
    expect(client).toContain('replaceKanbanData(drag.row, data);');
    expect(client).toContain('button.classList.contains("kanban-column-menu") && Date.now() < suppressKanbanColumnMenuClickUntil');
  });

  it("keeps click behavior on the same button wired to the existing delete action", () => {
    expect(client).toContain('"kanban-delete-column",');
    expect(client).toContain('if (action === "kanban-delete-column")');
    expect(client).toContain('if (!window.confirm(message)) return;');
  });
});
