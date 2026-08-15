import { normalizeIconValue } from "./icon-value.js";

export const accordionLimits = {
  titleLength: 120,
  items: 50,
  itemTitleLength: 300,
  itemContentLength: 8_000,
  idLength: 64
} as const;

export type AccordionItem = {
  id: string;
  icon: string;
  title: string;
  content: string;
  open: boolean;
};

export type AccordionData = {
  title: string;
  showOrder: boolean;
  items: AccordionItem[];
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown, fallback: string, maxLength: number) {
  return (typeof value === "string" ? value : fallback).slice(0, maxLength);
}

function safeId(value: unknown, fallback: string) {
  const id = typeof value === "string" ? value.trim().slice(0, accordionLimits.idLength) : "";
  return id || fallback;
}

function uniqueId(requested: string, seen: Set<string>, fallbackPrefix: string) {
  let id = requested;
  let attempt = 1;
  while (seen.has(id)) {
    id = `${fallbackPrefix}-${attempt}`.slice(0, accordionLimits.idLength);
    attempt += 1;
  }
  seen.add(id);
  return id;
}

function safeIcon(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "📄";
  try {
    return normalizeIconValue(value) ?? "📄";
  } catch {
    return "📄";
  }
}

export function createDefaultAccordionData(): AccordionData {
  return {
    title: "Accordion",
    showOrder: false,
    items: [
      {
        id: "accordion-item-1",
        icon: "📄",
        title: "Item 1",
        content: "",
        open: true
      }
    ]
  };
}

export function normalizeAccordionData(value: unknown): AccordionData {
  const source = recordValue(value) ?? {};
  const fallback = createDefaultAccordionData();
  const itemSources = Array.isArray(source.items) ? source.items.slice(0, accordionLimits.items) : fallback.items;
  const seenIds = new Set<string>();
  const items = itemSources
    .map((item) => recordValue(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item, index) => ({
      id: uniqueId(
        safeId(item.id, `accordion-item-${index + 1}`),
        seenIds,
        `accordion-item-${index + 1}`
      ),
      icon: safeIcon(item.icon),
      title: stringValue(item.title, `Item ${index + 1}`, accordionLimits.itemTitleLength),
      content: stringValue(item.content, "", accordionLimits.itemContentLength),
      open: item.open !== false
    }));

  return {
    title: stringValue(source.title, fallback.title, accordionLimits.titleLength),
    showOrder: source.showOrder === true,
    items
  };
}

export function getAccordionData(metadata: unknown): AccordionData {
  const root = parseMetadata(metadata);
  return normalizeAccordionData(root?.accordion);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPlainContent(value: string) {
  const content = escapeHtml(value).replace(/\r\n?|\n/g, "<br>");
  return content || '<span class="rendered-accordion-empty"></span>';
}

type AccordionContentRenderer = (value: string) => string;

export function summarizeAccordionData(value: unknown) {
  const accordion = normalizeAccordionData(value);
  return [
    accordion.title,
    ...accordion.items.flatMap((item) => [item.title, item.content])
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 20_000);
}

export function renderAccordionHtml(metadata: unknown, renderContent: AccordionContentRenderer = renderPlainContent) {
  const accordion = getAccordionData(metadata);
  const title = escapeHtml(accordion.title || "Accordion");
  const items = accordion.items.map((item, index) => {
    const order = accordion.showOrder
      ? `<span class="rendered-accordion-order">${index + 1}</span>`
      : "";
    const icon = escapeHtml(item.icon);
    const iconLabel = item.icon.startsWith("icon:") || item.icon.startsWith("image:") ? "📄" : icon;
    const itemTitle = escapeHtml(item.title || `Item ${index + 1}`);
    const open = item.open ? " open" : "";
    return `<details class="rendered-accordion-item"${open}>
      <summary class="rendered-accordion-summary">${order}<span class="rendered-accordion-item-icon" data-icon-value="${icon}">${iconLabel}</span><span class="rendered-accordion-item-title">${itemTitle}</span></summary>
      <div class="rendered-accordion-content">${item.content ? renderContent(item.content) : renderPlainContent("")}</div>
    </details>`;
  }).join("");

  return `<section class="rendered-accordion"><div class="rendered-accordion-title">${title}</div>${items}</section>`;
}
