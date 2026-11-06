import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { renderBlockHtml, sanitizeRenderedBlockHtml, sanitizeRenderedClass } from "../src/lib/markdown.js";
import { getKanbanData } from "../src/lib/kanban.js";
import { assertStructuredBlockMetadataIntegrity } from "../src/lib/structured-metadata-integrity.js";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const sanitizer = read("public/rendered-html-sanitizer.js").replace("export function renderServerBlockHtml", "function renderServerBlockHtml");
function browserSanitize(html, allowAiControls = false) {
  const { document, Element, Node } = parseHTML("<html><body><div id='target'></div></body></html>");
  const context = vm.createContext({ document, Element, Node, URL });
  vm.runInContext(sanitizer, context);
  const target = document.querySelector("#target");
  context.renderServerBlockHtml(target, html, { allowAiControls });
  return target;
}

describe("BV-2026-001 content classes", () => {
  const chromeClasses = ["account-settings-layer", "account-settings-backdrop", "account-settings-dialog",
    "share-page-layer", "emoji-picker-layer", "mobile-sidebar-backdrop", "kanban-card-style-panel",
    "database-property-menu", "is-open", "is-dragging"];

  it.each(chromeClasses)("removes %s from fresh Markdown and legacy caches in both sanitizers", (token) => {
    const payload = `<div class='${token} rendered-code-shell'><a class='${token}' href='https://example.com/login'>Sign in</a></div>`;
    const fresh = renderBlockHtml("MARKDOWN", payload);
    const cached = sanitizeRenderedBlockHtml("MARKDOWN", payload);
    for (const html of [fresh, cached, browserSanitize(payload).innerHTML]) {
      expect(html).not.toContain(token);
      expect(html).toContain("rendered-code-shell");
      expect(html).toContain("Sign in");
    }
  });

  it("applies identical class rules in the browser and server, including decoded entities", () => {
    const tokens = [...chromeClasses, "rendered-table", "language-csharp", "math-expression", "math-expression--display",
      "youtube-video-iframe", "visually-hidden", "is-active", "is-current", "is-complete", "is-weekend", "is-today", "rendered-X", "kanban-layer", "language-x:evil"];
    const input = tokens.join(" \t\n");
    const result = browserSanitize(`<span class='${input}'></span>`).firstElementChild.getAttribute("class");
    expect(result).toBe(sanitizeRenderedClass(input));
    expect(browserSanitize('<div class="account-settings-&#108;ayer"></div>').firstElementChild.hasAttribute("class")).toBe(false);
  });

  it("preserves math, code, table, toggle, YouTube and AI pagination rendering", () => {
    const markdown = renderBlockHtml("MARKDOWN", '$x$\n\n```js\nlet n = 1;\n```\n\n| A |\n|---|\n| B |');
    const html = browserSanitize(markdown).innerHTML;
    expect(html).toContain('class="math-expression math-expression--inline"');
    expect(html).toContain('class="language-javascript"');
    expect(html).toContain("<table>");
    const legacy = '<details class="rendered-toggle"><summary class="rendered-toggle-summary">Toggle</summary></details>'
      + '<iframe class="youtube-video-iframe" src="https://www.youtube-nocookie.com/embed/abcdefghijk"></iframe>'
      + '<section class="rendered-ai-chat-turn is-active"><button type="button" class="rendered-ai-chat-page is-current" data-ai-chat-page="0">1</button></section>';
    const result = browserSanitize(sanitizeRenderedBlockHtml("AI_CHAT", legacy), true);
    expect(result.querySelector(".rendered-toggle-summary")?.textContent).toBe("Toggle");
    expect(result.querySelector(".youtube-video-iframe")).toBeTruthy();
    expect(result.querySelector(".rendered-ai-chat-page.is-current")?.getAttribute("data-ai-chat-page")).toBe("0");
    const states = '<table><tbody><tr class="is-complete"><td>Done</td></tr></tbody></table><span class="rendered-gantt-day is-weekend is-today">6</span>';
    expect(browserSanitize(sanitizeRenderedBlockHtml("TIMETABLE", states)).querySelector("tr.is-complete")).toBeTruthy();
    expect(browserSanitize(sanitizeRenderedBlockHtml("GANTT", states)).querySelector(".is-weekend.is-today")).toBeTruthy();
  });
});

describe("BV-2026-002 Kanban focus", () => {
  const source = read("public/app.js");
  const replaceSource = source.slice(source.indexOf("function replaceKanbanData("), source.indexOf("function findKanbanCard("));
  it.each(["focusCardId", "focusStyleCardId", "focusColumnId"])("focuses the exact stored ID for %s", (option) => {
    const id = 'x"] , .other, [data-x="';
    const metadata = { kanban: { columns: [{ id, title: "column", color: "gray", cards: [{ id, title: "card" }] }] } };
    expect(() => assertStructuredBlockMetadataIntegrity("KANBAN", metadata)).not.toThrow();
    expect(getKanbanData(metadata).columns[0].cards[0].id).toBe(id);
    const { document } = parseHTML('<div id="row"><div class="block-editor-host"></div></div>');
    const row = document.querySelector("#row");
    const editor = document.createElement("div");
    editor.innerHTML = '<div class="kanban-column"><input class="kanban-column-title"><div class="kanban-card"><input class="kanban-card-title"><details class="kanban-card-style-menu"><summary>Style</summary></details></div></div>';
    editor.querySelector(".kanban-card").dataset.cardId = id;
    editor.querySelector(".kanban-column").dataset.columnId = id;
    const target = editor.querySelector(option === "focusCardId" ? ".kanban-card-title" : option === "focusColumnId" ? ".kanban-column-title" : "summary");
    target.focus = vi.fn(); target.select = vi.fn();
    const context = vm.createContext({
      requireWritablePage: () => true, promoteBlockDraftConflict: () => true,
      normalizeKanbanData: (value) => value, createKanbanEditor: () => editor,
      scheduleBlockSave: vi.fn(), requestAnimationFrame: (fn) => fn(),
      closeKanbanCardStyleMenus: vi.fn(), positionKanbanCardStylePanel: vi.fn()
    });
    vm.runInContext(replaceSource, context);
    expect(() => context.replaceKanbanData(row, metadata.kanban, { [option]: id })).not.toThrow();
    expect(target.focus).toHaveBeenCalledOnce();
    if (option !== "focusStyleCardId") expect(target.select).toHaveBeenCalledOnce();
    else expect(editor.querySelector("details").open).toBe(true);
  });
});
