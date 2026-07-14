export const kanbanLimits = {
  columns: 12,
  cardsPerColumn: 50,
  boardTitleLength: 120,
  columnTitleLength: 80,
  cardTitleLength: 160,
  cardDescriptionLength: 1_000,
  cardIconLength: 24,
  tagsPerCard: 8,
  tagLength: 40
} as const;

export const kanbanColumnColors = ["gray", "blue", "purple", "green", "yellow", "red"] as const;
export type KanbanColumnColor = (typeof kanbanColumnColors)[number];

export const kanbanCardColors = ["default", "pink", "yellow", "blue", "green", "purple", "peach"] as const;
export type KanbanCardColor = (typeof kanbanCardColors)[number];

export type KanbanCard = {
  id: string;
  title: string;
  description: string;
  icon: string;
  color: KanbanCardColor;
  tags: string[];
};

export type KanbanColumn = {
  id: string;
  title: string;
  color: KanbanColumnColor;
  cards: KanbanCard[];
};

export type KanbanData = {
  title: string;
  columns: KanbanColumn[];
};

function parseMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown, fallback: string, maxLength: number) {
  return (typeof value === "string" ? value : fallback).slice(0, maxLength);
}

function safeId(value: unknown, fallback: string) {
  const id = typeof value === "string" ? value.trim().slice(0, 64) : "";
  return id || fallback;
}

function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((tag) => stringValue(tag, "", kanbanLimits.tagLength).trim())
    .filter(Boolean))]
    .slice(0, kanbanLimits.tagsPerCard);
}

function normalizeIcon(value: unknown) {
  return stringValue(value, "", kanbanLimits.cardIconLength)
    .replace(/[\r\n\t]/g, "")
    .trim();
}

function normalizeColumnColor(value: unknown, index: number): KanbanColumnColor {
  return kanbanColumnColors.includes(value as KanbanColumnColor)
    ? (value as KanbanColumnColor)
    : kanbanColumnColors[index % kanbanColumnColors.length];
}

function normalizeCardColor(value: unknown): KanbanCardColor {
  return kanbanCardColors.includes(value as KanbanCardColor)
    ? (value as KanbanCardColor)
    : "default";
}

export function createDefaultKanbanData(): KanbanData {
  return {
    title: "Project board",
    columns: [
      { id: "todo", title: "To do", color: "gray", cards: [] },
      { id: "in-progress", title: "In progress", color: "blue", cards: [] },
      { id: "done", title: "Done", color: "green", cards: [] }
    ]
  };
}

export function getKanbanData(metadata: unknown): KanbanData {
  const value = parseMetadata(metadata)?.kanban;
  if (!value || typeof value !== "object" || Array.isArray(value)) return createDefaultKanbanData();

  const source = value as Record<string, unknown>;
  const sourceColumns = Array.isArray(source.columns) ? source.columns.slice(0, kanbanLimits.columns) : [];
  const seenColumnIds = new Set<string>();
  const seenCardIds = new Set<string>();

  const columns = sourceColumns
    .filter((column): column is Record<string, unknown> => Boolean(column && typeof column === "object" && !Array.isArray(column)))
    .map((column, columnIndex) => {
      const requestedColumnId = safeId(column.id, `column-${columnIndex + 1}`);
      let columnId = requestedColumnId;
      let columnIdAttempt = 1;
      while (seenColumnIds.has(columnId)) {
        columnId = `column-${columnIndex + 1}-${columnIdAttempt}`;
        columnIdAttempt += 1;
      }
      seenColumnIds.add(columnId);

      const sourceCards = Array.isArray(column.cards) ? column.cards.slice(0, kanbanLimits.cardsPerColumn) : [];
      const cards = sourceCards
        .filter((card): card is Record<string, unknown> => Boolean(card && typeof card === "object" && !Array.isArray(card)))
        .map((card, cardIndex) => {
          const requestedCardId = safeId(card.id, `${columnId}-card-${cardIndex + 1}`);
          let cardId = requestedCardId;
          let cardIdAttempt = 1;
          while (seenCardIds.has(cardId)) {
            cardId = `card-${columnIndex + 1}-${cardIndex + 1}-${cardIdAttempt}`;
            cardIdAttempt += 1;
          }
          seenCardIds.add(cardId);
          return {
            id: cardId,
            title: stringValue(card.title, "Untitled", kanbanLimits.cardTitleLength),
            description: stringValue(card.description, "", kanbanLimits.cardDescriptionLength),
            icon: normalizeIcon(card.icon),
            color: normalizeCardColor(card.color),
            tags: normalizeTags(card.tags)
          };
        });

      return {
        id: columnId,
        title: stringValue(column.title, `Group ${columnIndex + 1}`, kanbanLimits.columnTitleLength),
        color: normalizeColumnColor(column.color, columnIndex),
        cards
      };
    });

  return {
    title: stringValue(source.title, "Project board", kanbanLimits.boardTitleLength),
    columns: columns.length ? columns : createDefaultKanbanData().columns
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderKanbanHtml(metadata: unknown) {
  const board = getKanbanData(metadata);
  const columns = board.columns.map((column) => {
    const cards = column.cards.map((card) => {
      const description = card.description
        ? `<p class="rendered-kanban-card-description">${escapeHtml(card.description)}</p>`
        : "";
      const tags = card.tags.length
        ? `<div class="rendered-kanban-card-tags">${card.tags
          .map((tag) => `<span class="rendered-kanban-tag">${escapeHtml(tag)}</span>`)
          .join("")}</div>`
        : "";
      const icon = card.icon
        ? `<span class="rendered-kanban-card-icon">${escapeHtml(card.icon)}</span>`
        : "";
      return `<article class="rendered-kanban-card rendered-kanban-card--${card.color}"><div class="rendered-kanban-card-heading">${icon}<strong>${escapeHtml(card.title || "Untitled")}</strong></div>${description}${tags}</article>`;
    }).join("");

    return `<section class="rendered-kanban-column rendered-kanban-column--${column.color}"><header><span>${escapeHtml(column.title)}</span><small>${column.cards.length}</small></header><div class="rendered-kanban-card-list">${cards}</div></section>`;
  }).join("");

  return `<div class="rendered-kanban"><h3>${escapeHtml(board.title)}</h3><div class="rendered-kanban-board">${columns}</div></div>`;
}
