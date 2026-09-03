import { formatNumber, t } from "./i18n.js";
import { renderServerBlockHtml } from "./rendered-html-sanitizer.js";

export const accordionLimits = {
  titleLength: 120,
  items: 50,
  itemTitleLength: 300,
  itemContentLength: 8000,
  idLength: 64
};

function createId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`.slice(0, accordionLimits.idLength);
}

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value, fallback, maxLength) {
  return (typeof value === "string" ? value : fallback).slice(0, maxLength);
}

function safeId(value, fallback) {
  const id = typeof value === "string" ? value.trim().slice(0, accordionLimits.idLength) : "";
  return id || fallback;
}

function uniqueId(requested, seen, fallbackPrefix) {
  let id = requested;
  let attempt = 1;
  while (seen.has(id)) {
    id = `${fallbackPrefix}-${attempt}`.slice(0, accordionLimits.idLength);
    attempt += 1;
  }
  seen.add(id);
  return id;
}

function normalizeIcon(value) {
  return typeof value === "string" && value.trim() ? value : "📄";
}

export function createDefaultAccordionData() {
  return {
    title: t("accordion.defaultTitle"),
    showOrder: false,
    items: [
      {
        id: createId("accordion-item"),
        icon: "📄",
        title: t("accordion.defaultItemTitle", { number: formatNumber(1) }),
        content: "",
        open: true
      }
    ]
  };
}

export function normalizeAccordionData(value) {
  const source = recordValue(value) ?? {};
  const fallback = createDefaultAccordionData();
  const itemSources = Array.isArray(source.items) ? source.items.slice(0, accordionLimits.items) : fallback.items;
  const seen = new Set();
  const items = itemSources
    .map(recordValue)
    .filter(Boolean)
    .map((item, index) => ({
      id: uniqueId(safeId(item.id, createId("accordion-item")), seen, `accordion-item-${index + 1}`),
      icon: normalizeIcon(item.icon),
      title: stringValue(
        item.title,
        t("accordion.defaultItemTitle", { number: formatNumber(index + 1) }),
        accordionLimits.itemTitleLength
      ),
      content: stringValue(item.content, "", accordionLimits.itemContentLength),
      open: item.open !== false
    }));

  return {
    title: stringValue(source.title, fallback.title, accordionLimits.titleLength),
    showOrder: source.showOrder === true,
    items
  };
}

function resizeTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(textarea.scrollHeight, 72)}px`;
}

function renderFallbackPreview(preview, data, renderIcon) {
  preview.replaceChildren();
  const section = document.createElement("section");
  section.className = "rendered-accordion";
  const title = document.createElement("div");
  title.className = "rendered-accordion-title";
  title.textContent = data.title || t("accordion.defaultTitle");
  section.append(title);

  data.items.forEach((item, index) => {
    const details = document.createElement("details");
    details.className = "rendered-accordion-item";
    details.open = item.open;
    const summary = document.createElement("summary");
    summary.className = "rendered-accordion-summary";
    if (data.showOrder) {
      const order = document.createElement("span");
      order.className = "rendered-accordion-order";
      order.textContent = formatNumber(index + 1);
      summary.append(order);
    }
    const icon = document.createElement("span");
    icon.className = "rendered-accordion-item-icon";
    icon.dataset.iconValue = item.icon;
    if (renderIcon) renderIcon(icon, item.icon, "📄");
    else icon.textContent = item.icon;
    const label = document.createElement("span");
    label.className = "rendered-accordion-item-title";
    label.textContent = item.title || t("accordion.defaultItemTitle", { number: formatNumber(index + 1) });
    const content = document.createElement("div");
    content.className = "rendered-accordion-content";
    content.textContent = item.content;
    summary.append(icon, label);
    details.append(summary, content);
    section.append(details);
  });
  preview.append(section);
}

function focusAccordionControl(editor, itemId, selector = ".accordion-item-title-input") {
  requestAnimationFrame(() => {
    const item = editor.querySelector(`[data-accordion-item-id="${CSS.escape(itemId)}"]`);
    item?.querySelector(selector)?.focus();
  });
}

export function createAccordionEditor(row, value, options = {}) {
  const { onDirty, renderIcon, onPickIcon, previewHtml = "" } = options;
  const data = normalizeAccordionData(value);
  const editor = document.createElement("div");
  editor.className = "accordion-block-editor";
  editor.accordionData = data;
  editor.classList.toggle("show-order", data.showOrder);
  const isReadOnly = () => row?.getAttribute("aria-readonly") === "true" || row?.classList.contains("is-read-only");

  const editSurface = document.createElement("div");
  editSurface.className = "accordion-edit-surface";

  const heading = document.createElement("div");
  heading.className = "accordion-block-heading";
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "accordion-title-input";
  titleInput.maxLength = accordionLimits.titleLength;
  titleInput.value = data.title;
  titleInput.placeholder = t("accordion.titlePlaceholder");
  titleInput.setAttribute("aria-label", t("accordion.titleAria"));
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "accordion-add-item";
  addButton.dataset.action = "accordion-add-item";
  addButton.disabled = data.items.length >= accordionLimits.items;
  addButton.textContent = `＋ ${t("accordion.addItem")}`;
  addButton.setAttribute("aria-label", t("accordion.addItem"));
  heading.append(titleInput, addButton);

  const list = document.createElement("div");
  list.className = "accordion-items";
  list.setAttribute("role", "list");

  data.items.forEach((item, index) => {
    const itemElement = document.createElement("article");
    itemElement.className = "accordion-item";
    itemElement.dataset.accordionItemId = item.id;
    itemElement.setAttribute("role", "listitem");

    const header = document.createElement("div");
    header.className = "accordion-item-header";

    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "accordion-item-drag-handle";
    dragHandle.draggable = true;
    dragHandle.dataset.accordionItemId = item.id;
    dragHandle.textContent = "⠿";
    dragHandle.title = t("accordion.dragItem");
    dragHandle.setAttribute("aria-label", t("accordion.dragItem"));

    const order = document.createElement("span");
    order.className = "accordion-item-order";
    order.textContent = formatNumber(index + 1);
    order.setAttribute("aria-hidden", "true");

    const iconButton = document.createElement("button");
    iconButton.type = "button";
    iconButton.className = "accordion-item-icon-button";
    iconButton.dataset.action = "accordion-pick-icon";
    iconButton.dataset.accordionItemId = item.id;
    iconButton.title = t("accordion.changeIcon");
    iconButton.setAttribute("aria-label", t("accordion.changeIconFor", { title: item.title || formatNumber(index + 1) }));
    if (renderIcon) renderIcon(iconButton, item.icon, "📄");
    else iconButton.textContent = item.icon;

    const disclosure = document.createElement("button");
    disclosure.type = "button";
    disclosure.className = "accordion-item-toggle";
    disclosure.dataset.action = "accordion-toggle-item";
    disclosure.dataset.accordionItemId = item.id;
    disclosure.setAttribute("aria-expanded", String(item.open));
    disclosure.setAttribute("aria-controls", `accordion-panel-${item.id}`);
    disclosure.title = t(item.open ? "accordion.collapseItem" : "accordion.expandItem");
    const chevron = document.createElement("span");
    chevron.className = "accordion-item-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = item.open ? "⌄" : "›";
    disclosure.append(chevron);

    const itemTitle = document.createElement("input");
    itemTitle.type = "text";
    itemTitle.className = "accordion-item-title-input";
    itemTitle.maxLength = accordionLimits.itemTitleLength;
    itemTitle.value = item.title;
    itemTitle.placeholder = t("accordion.itemTitlePlaceholder");
    itemTitle.setAttribute("aria-label", t("accordion.itemTitleAria", { number: formatNumber(index + 1) }));
    itemTitle.dataset.accordionItemId = item.id;

    const controls = document.createElement("div");
    controls.className = "accordion-item-actions";
    const moveUp = document.createElement("button");
    moveUp.type = "button";
    moveUp.dataset.action = "accordion-move-up";
    moveUp.dataset.accordionItemId = item.id;
    moveUp.className = "accordion-item-action";
    moveUp.textContent = "↑";
    moveUp.title = t("accordion.moveUp");
    moveUp.setAttribute("aria-label", t("accordion.moveUp"));
    moveUp.disabled = index === 0;
    const moveDown = document.createElement("button");
    moveDown.type = "button";
    moveDown.dataset.action = "accordion-move-down";
    moveDown.dataset.accordionItemId = item.id;
    moveDown.className = "accordion-item-action";
    moveDown.textContent = "↓";
    moveDown.title = t("accordion.moveDown");
    moveDown.setAttribute("aria-label", t("accordion.moveDown"));
    moveDown.disabled = index === data.items.length - 1;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.action = "accordion-remove-item";
    remove.dataset.accordionItemId = item.id;
    remove.className = "accordion-item-action accordion-item-remove";
    remove.textContent = "⌫";
    remove.title = t("accordion.removeItem");
    remove.setAttribute("aria-label", t("accordion.removeItem"));
    controls.append(moveUp, moveDown, remove);

    header.append(dragHandle, order, iconButton, disclosure, itemTitle, controls);

    const panel = document.createElement("div");
    panel.id = `accordion-panel-${item.id}`;
    panel.className = "accordion-item-panel";
    panel.hidden = !item.open;
    const content = document.createElement("textarea");
    content.className = "accordion-item-content";
    content.rows = 3;
    content.maxLength = accordionLimits.itemContentLength;
    content.value = item.content;
    content.placeholder = t("accordion.contentPlaceholder");
    content.setAttribute("aria-label", t("accordion.contentAria", { title: item.title || formatNumber(index + 1) }));
    content.dataset.accordionItemId = item.id;
    panel.append(content);
    itemElement.append(header, panel);
    list.append(itemElement);
    requestAnimationFrame(() => resizeTextarea(content));
  });

  const empty = document.createElement("div");
  empty.className = "accordion-empty-state";
  empty.hidden = data.items.length > 0;
  empty.textContent = t("accordion.emptyState");

  editSurface.append(heading, list, empty);

  const preview = document.createElement("div");
  preview.className = "block-rendered-preview accordion-block-preview";
  if (previewHtml) renderServerBlockHtml(preview, previewHtml);
  else renderFallbackPreview(preview, data, renderIcon);

  editor.append(editSurface, preview);

  const replaceEditor = ({ focusItemId = null, focusSelector } = {}) => {
    const replacement = createAccordionEditor(row, data, {
      onDirty,
      renderIcon,
      onPickIcon,
      previewHtml: ""
    });
    editor.replaceWith(replacement);
    onDirty?.();
    if (focusItemId) focusAccordionControl(replacement, focusItemId, focusSelector);
    return replacement;
  };

  editor.addEventListener("input", (event) => {
    if (isReadOnly()) return;
    if (event.target === titleInput) {
      data.title = titleInput.value.slice(0, accordionLimits.titleLength);
      editor.accordionData = data;
      onDirty?.();
      return;
    }
    const itemId = event.target?.dataset?.accordionItemId;
    if (!itemId) return;
    const item = data.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    if (event.target.classList.contains("accordion-item-title-input")) {
      item.title = event.target.value.slice(0, accordionLimits.itemTitleLength);
    } else if (event.target.classList.contains("accordion-item-content")) {
      item.content = event.target.value.slice(0, accordionLimits.itemContentLength);
      resizeTextarea(event.target);
    } else {
      return;
    }
    editor.accordionData = data;
    onDirty?.();
  });

  editor.addEventListener("click", (event) => {
    if (isReadOnly()) return;
    const button = event.target.closest("button[data-action]");
    if (!button || !editor.contains(button)) return;
    const action = button.dataset.action;
    const itemId = button.dataset.accordionItemId;
    const itemIndex = data.items.findIndex((candidate) => candidate.id === itemId);

    if (action === "accordion-add-item") {
      if (data.items.length >= accordionLimits.items) return;
      const nextIndex = data.items.length + 1;
      const item = {
        id: createId("accordion-item"),
        icon: "📄",
        title: t("accordion.defaultItemTitle", { number: formatNumber(nextIndex) }),
        content: "",
        open: true
      };
      data.items.push(item);
      replaceEditor({ focusItemId: item.id });
      return;
    }
    if (itemIndex < 0) return;
    const item = data.items[itemIndex];

    if (action === "accordion-toggle-item") {
      item.open = !item.open;
      button.setAttribute("aria-expanded", String(item.open));
      button.title = t(item.open ? "accordion.collapseItem" : "accordion.expandItem");
      button.querySelector(".accordion-item-chevron").textContent = item.open ? "⌄" : "›";
      const panel = editor.querySelector(`#accordion-panel-${CSS.escape(item.id)}`);
      if (panel) panel.hidden = !item.open;
      editor.accordionData = data;
      onDirty?.();
      return;
    }
    if (action === "accordion-pick-icon") {
      onPickIcon?.({ itemId: item.id, icon: item.icon, trigger: button });
      return;
    }
    if (action === "accordion-remove-item") {
      data.items.splice(itemIndex, 1);
      const focusItemId = data.items[Math.min(itemIndex, data.items.length - 1)]?.id ?? null;
      replaceEditor({ focusItemId });
      return;
    }
    if (action === "accordion-move-up" && itemIndex > 0) {
      [data.items[itemIndex - 1], data.items[itemIndex]] = [data.items[itemIndex], data.items[itemIndex - 1]];
      replaceEditor({ focusItemId: item.id, focusSelector: '[data-action="accordion-move-up"]' });
      return;
    }
    if (action === "accordion-move-down" && itemIndex < data.items.length - 1) {
      [data.items[itemIndex], data.items[itemIndex + 1]] = [data.items[itemIndex + 1], data.items[itemIndex]];
      replaceEditor({ focusItemId: item.id, focusSelector: '[data-action="accordion-move-down"]' });
    }
  });

  let draggedId = null;
  const clearDropIndicators = () => {
    for (const item of list.querySelectorAll(".accordion-item")) item.classList.remove("drop-before", "drop-after", "is-dragging");
  };

  list.addEventListener("dragstart", (event) => {
    if (isReadOnly()) {
      event.preventDefault();
      return;
    }
    const handle = event.target.closest(".accordion-item-drag-handle");
    if (!handle || !list.contains(handle)) return;
    draggedId = handle.dataset.accordionItemId;
    if (!draggedId) return;
    event.dataTransfer?.setData("text/plain", draggedId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    handle.closest(".accordion-item")?.classList.add("is-dragging");
  });

  list.addEventListener("dragover", (event) => {
    if (!draggedId) return;
    if (isReadOnly()) {
      clearDropIndicators();
      draggedId = null;
      return;
    }
    const target = event.target.closest(".accordion-item");
    if (!target || target.dataset.accordionItemId === draggedId) return;
    event.preventDefault();
    clearDropIndicators();
    const rect = target.getBoundingClientRect();
    target.classList.add(event.clientY >= rect.top + rect.height / 2 ? "drop-after" : "drop-before");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });

  list.addEventListener("drop", (event) => {
    if (!draggedId) return;
    if (isReadOnly()) {
      event.preventDefault();
      clearDropIndicators();
      draggedId = null;
      return;
    }
    const target = event.target.closest(".accordion-item");
    if (!target || target.dataset.accordionItemId === draggedId) {
      clearDropIndicators();
      draggedId = null;
      return;
    }
    event.preventDefault();
    const sourceIndex = data.items.findIndex((item) => item.id === draggedId);
    const targetIndex = data.items.findIndex((item) => item.id === target.dataset.accordionItemId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const targetRect = target.getBoundingClientRect();
    const after = event.clientY >= targetRect.top + targetRect.height / 2;
    const [moved] = data.items.splice(sourceIndex, 1);
    let insertionIndex = data.items.findIndex((item) => item.id === target.dataset.accordionItemId);
    if (after) insertionIndex += 1;
    data.items.splice(Math.max(0, insertionIndex), 0, moved);
    clearDropIndicators();
    const focusItemId = draggedId;
    draggedId = null;
    replaceEditor({ focusItemId, focusSelector: ".accordion-item-drag-handle" });
  });

  list.addEventListener("dragend", () => {
    draggedId = null;
    clearDropIndicators();
  });

  return editor;
}

export function extractAccordionData(row) {
  return normalizeAccordionData(row?.querySelector(".accordion-block-editor")?.accordionData);
}

function normalizeEditorAccordionDataInPlace(editor) {
  const current = recordValue(editor?.accordionData);
  if (!current) return null;
  const normalized = normalizeAccordionData(current);

  // createAccordionEditor keeps `data` in its event-handler closure. External
  // controls (icon picker / block menu) must therefore preserve that root
  // object identity instead of replacing editor.accordionData with a clone.
  current.title = normalized.title;
  current.showOrder = normalized.showOrder;
  current.items = normalized.items;
  editor.accordionData = current;
  return current;
}

export function setAccordionShowOrder(row, showOrder) {
  const editor = row?.querySelector(".accordion-block-editor");
  if (!editor) return false;
  const data = normalizeEditorAccordionDataInPlace(editor);
  if (!data) return false;
  data.showOrder = showOrder === true;
  editor.accordionData = data;
  editor.classList.toggle("show-order", data.showOrder);
  return true;
}

export function setAccordionItemIcon(row, itemId, icon, renderIcon) {
  const editor = row?.querySelector(".accordion-block-editor");
  if (!editor || !itemId) return false;
  const data = normalizeEditorAccordionDataInPlace(editor);
  if (!data) return false;
  const item = data.items.find((candidate) => candidate.id === itemId);
  if (!item) return false;
  item.icon = normalizeIcon(icon);
  editor.accordionData = data;
  const button = editor.querySelector(`[data-action="accordion-pick-icon"][data-accordion-item-id="${CSS.escape(itemId)}"]`);
  if (button) {
    if (renderIcon) renderIcon(button, item.icon, "📄");
    else button.textContent = item.icon;
  }
  return true;
}

export function summarizeAccordionData(value) {
  const accordion = normalizeAccordionData(value);
  return [accordion.title, ...accordion.items.flatMap((item) => [item.title, item.content])]
    .filter(Boolean)
    .join("\n")
    .slice(0, 20000);
}
