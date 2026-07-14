import { describe, expect, it } from "vitest";
import {
  createDefaultKanbanData,
  getKanbanData,
  kanbanCardColors,
  kanbanLimits,
  renderKanbanHtml
} from "../src/lib/kanban.js";
import { renderBlockHtml } from "../src/lib/markdown.js";

describe("Kanban block data", () => {
  it("creates the standard three-group board", () => {
    const board = createDefaultKanbanData();
    expect(board.columns.map((column) => column.title)).toEqual(["To do", "In progress", "Done"]);
    expect(board.columns.every((column) => column.cards.length === 0)).toBe(true);
  });

  it("normalizes malformed data, limits sizes, and de-duplicates ids", () => {
    const duplicateId = "x".repeat(64);
    const board = getKanbanData({
      kanban: {
        title: "A".repeat(kanbanLimits.boardTitleLength + 20),
        columns: Array.from({ length: kanbanLimits.columns + 4 }, (_, columnIndex) => ({
          id: duplicateId,
          title: `Group ${columnIndex}`,
          color: "not-a-color",
          cards: Array.from({ length: kanbanLimits.cardsPerColumn + 3 }, (_, cardIndex) => ({
            id: duplicateId,
            title: `Card ${cardIndex}`,
            description: "D".repeat(kanbanLimits.cardDescriptionLength + 20),
            icon: "🚀".repeat(kanbanLimits.cardIconLength),
            color: cardIndex === 0 ? "pink" : "not-a-card-color",
            tags: ["one", "one", ...Array.from({ length: 20 }, (_, index) => `tag-${index}`)]
          }))
        }))
      }
    });

    expect(board.title).toHaveLength(kanbanLimits.boardTitleLength);
    expect(board.columns).toHaveLength(kanbanLimits.columns);
    expect(new Set(board.columns.map((column) => column.id)).size).toBe(board.columns.length);
    expect(board.columns[0].cards).toHaveLength(kanbanLimits.cardsPerColumn);
    expect(new Set(board.columns.flatMap((column) => column.cards.map((card) => card.id))).size)
      .toBe(board.columns.length * kanbanLimits.cardsPerColumn);
    expect(board.columns[0].cards[0].description).toHaveLength(kanbanLimits.cardDescriptionLength);
    expect(board.columns[0].cards[0].icon.length).toBeLessThanOrEqual(kanbanLimits.cardIconLength);
    expect(board.columns[0].cards[0].color).toBe("pink");
    expect(board.columns[0].cards[1].color).toBe("default");
    expect(kanbanCardColors).toContain(board.columns[0].cards[0].color);
    expect(board.columns[0].cards[0].tags).toHaveLength(kanbanLimits.tagsPerCard);
  });
});

describe("Kanban block rendering", () => {
  const metadata = {
    kanban: {
      title: "Launch <script>alert(1)</script>",
      columns: [
        {
          id: "todo",
          title: "To do",
          color: "blue",
          cards: [
            {
              id: "card-1",
              title: "Ship <img src=x onerror=alert(1)>",
              description: "Review & approve",
              icon: "<svg onload=alert(1)>",
              color: "pink",
              tags: ["urgent", "frontend"]
            }
          ]
        }
      ]
    }
  };

  it("escapes card content and preserves render classes", () => {
    const html = renderKanbanHtml(metadata);
    expect(html).toContain("rendered-kanban-column--blue");
    expect(html).toContain("rendered-kanban-card--pink");
    expect(html).toContain('class="rendered-kanban-card-icon"');
    expect(html).toContain("&lt;svg onload=alert(1)&gt;");
    expect(html).not.toContain("<svg");
    expect(html).toContain("Launch &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });

  it("is sanitized through the standard block renderer", () => {
    const html = renderBlockHtml("KANBAN", "", false, metadata);
    expect(html).toContain('class="rendered-kanban"');
    expect(html).toContain('class="rendered-kanban-card-description"');
    expect(html).toContain("Review &amp; approve");
    expect(html).not.toContain("<script>");
  });
});
