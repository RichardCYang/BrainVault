import type { BlockType } from "../types/domain.js";

const tableLimits = { rows: 50, columns: 20, cellLength: 4_000 } as const;
const kanbanLimits = {
  columns: 12,
  cardsPerColumn: 50,
  boardTitleLength: 120,
  columnTitleLength: 80,
  cardTitleLength: 160,
  cardDescriptionLength: 1_000,
  cardIconLength: 24,
  tagsPerCard: 8,
  tagLength: 40,
  idLength: 64
} as const;
const databaseLimits = {
  titleLength: 120,
  properties: 20,
  propertyNameLength: 80,
  rows: 200,
  views: 12,
  viewNameLength: 80,
  optionsPerProperty: 30,
  optionNameLength: 80,
  filtersPerView: 8,
  sortsPerView: 8,
  textLength: 2_000,
  urlLength: 2_000,
  idLength: 64
} as const;
const ganttLimits = {
  titleLength: 120,
  tasks: 200,
  taskTitleLength: 160,
  assigneeLength: 80,
  idLength: 64
} as const;
const bookmarkLimits = {
  items: 50,
  idLength: 64,
  urlLength: 2_048,
  titleLength: 300,
  descriptionLength: 1_000,
  siteNameLength: 160
} as const;
const aiChatLimits = {
  questionLength: 8_000,
  answerLength: 12_000,
  modelLength: 120,
  answeredAtLength: 16
} as const;

const databasePropertyTypes = new Set([
  "title",
  "text",
  "number",
  "select",
  "multi_select",
  "checkbox",
  "date",
  "url"
]);
const databaseViewTypes = new Set(["table", "board", "list"]);
const databaseOptionColors = new Set(["gray", "blue", "purple", "green", "yellow", "red", "pink", "orange"]);
const databaseFilterOperators = new Set(["contains", "equals", "is_empty", "is_not_empty", "checked", "unchecked"]);
const kanbanColumnColors = new Set(["gray", "blue", "purple", "green", "yellow", "red"]);
const kanbanCardColors = new Set(["default", "pink", "yellow", "blue", "green", "purple", "peach"]);
const ganttScales = new Set(["week", "month", "quarter"]);
const ganttStatuses = new Set(["not_started", "in_progress", "review", "done", "blocked"]);
const aiProviderIds = new Set(["chatgpt", "gemini", "claude", "deepseek", "grok"]);

export class StructuredMetadataIntegrityError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "StructuredMetadataIntegrityError";
    this.path = path;
  }
}

type MetadataRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new StructuredMetadataIntegrityError(path, message);
}

function isRecord(value: unknown): value is MetadataRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseMetadataRoot(metadata: unknown) {
  if (metadata === null || metadata === undefined) return null;
  let value: unknown = metadata;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      fail("metadata", "must contain valid JSON");
    }
  }
  if (!isRecord(value)) fail("metadata", "must be a JSON object");
  return value;
}

function optionalRecord(value: unknown, path: string) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) fail(path, "must be an object");
  return value;
}

function optionalArray(value: unknown, path: string, maximum: number) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > maximum) fail(path, `contains ${value.length} items; the maximum is ${maximum}`);
  return value;
}

function optionalString(value: unknown, path: string, maximum: number) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length > maximum) fail(path, `contains ${value.length} characters; the maximum is ${maximum}`);
  return value;
}

function optionalBoolean(value: unknown, path: string) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function optionalFiniteNumber(value: unknown, path: string) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function assertIdentifier(value: unknown, path: string, { required = true } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) fail(path, "must be a non-empty identifier");
    return null;
  }
  const id = optionalString(value, path, 64)!;
  if (!id.trim()) fail(path, "must be a non-empty identifier");
  return id;
}

function assertUnique(values: string[], path: string) {
  if (new Set(values).size !== values.length) fail(path, "contains duplicate identifiers");
}

function assertCanonicalBookmarkText(value: unknown, path: string, maximum: number, { required = false } = {}) {
  if ((value === null || value === undefined || value === "") && !required) return "";
  const text = optionalString(value, path, maximum);
  if (text === null || (!text && required)) fail(path, "must be a non-empty string");
  const normalized = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized !== text) fail(path, "contains characters or whitespace that would be normalized and lost");
  return text;
}

function canonicalBookmarkUrl(value: unknown, path: string, baseUrl?: string) {
  const raw = assertCanonicalBookmarkText(value, path, bookmarkLimits.urlLength);
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
  } catch {
    fail(path, "must be a valid URL");
  }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || parsed.username || parsed.password) {
    fail(path, "must be an HTTP(S) URL without embedded credentials");
  }
  if (parsed.hash) fail(path, "must not contain a fragment because fragments are discarded by the editor");
  const canonical = parsed.toString();
  if (canonical.length > bookmarkLimits.urlLength) fail(path, `exceeds ${bookmarkLimits.urlLength} characters after URL normalization`);
  if (canonical !== raw) fail(path, "must use the canonical URL form shown by the editor");
  return canonical;
}

function assertTableMetadata(root: MetadataRecord) {
  const table = optionalRecord(root.table, "metadata.table");
  if (!table) return;
  const rows = optionalArray(table.rows, "metadata.table.rows", tableLimits.rows);
  if (rows) {
    rows.forEach((rawRow, rowIndex) => {
      if (!Array.isArray(rawRow)) fail(`metadata.table.rows[${rowIndex}]`, "must be an array");
      if (rawRow.length > tableLimits.columns) {
        fail(`metadata.table.rows[${rowIndex}]`, `contains ${rawRow.length} cells; the maximum is ${tableLimits.columns}`);
      }
      rawRow.forEach((cell, columnIndex) => {
        optionalString(cell, `metadata.table.rows[${rowIndex}][${columnIndex}]`, tableLimits.cellLength);
      });
    });
  }
  optionalBoolean(table.headerRow, "metadata.table.headerRow");
  optionalBoolean(table.headerColumn, "metadata.table.headerColumn");
}

function assertKanbanMetadata(root: MetadataRecord) {
  const kanban = optionalRecord(root.kanban, "metadata.kanban");
  if (!kanban) return;
  optionalString(kanban.title, "metadata.kanban.title", kanbanLimits.boardTitleLength);
  const columns = optionalArray(kanban.columns, "metadata.kanban.columns", kanbanLimits.columns);
  if (!columns) return;

  const columnIds: string[] = [];
  const cardIds: string[] = [];
  columns.forEach((rawColumn, columnIndex) => {
    const path = `metadata.kanban.columns[${columnIndex}]`;
    const column = optionalRecord(rawColumn, path);
    if (!column) fail(path, "must be an object");
    columnIds.push(assertIdentifier(column.id, `${path}.id`)!);
    optionalString(column.title, `${path}.title`, kanbanLimits.columnTitleLength);
    if (column.color !== null && column.color !== undefined && !kanbanColumnColors.has(column.color as string)) {
      fail(`${path}.color`, "is not a supported column color");
    }
    const cards = optionalArray(column.cards, `${path}.cards`, kanbanLimits.cardsPerColumn);
    cards?.forEach((rawCard, cardIndex) => {
      const cardPath = `${path}.cards[${cardIndex}]`;
      const card = optionalRecord(rawCard, cardPath);
      if (!card) fail(cardPath, "must be an object");
      cardIds.push(assertIdentifier(card.id, `${cardPath}.id`)!);
      optionalString(card.title, `${cardPath}.title`, kanbanLimits.cardTitleLength);
      optionalString(card.description, `${cardPath}.description`, kanbanLimits.cardDescriptionLength);
      const icon = optionalString(card.icon, `${cardPath}.icon`, kanbanLimits.cardIconLength);
      if (icon !== null && icon.replace(/[\r\n\t]/g, "").trim() !== icon) {
        fail(`${cardPath}.icon`, "contains whitespace that would be removed by the editor");
      }
      if (card.color !== null && card.color !== undefined && !kanbanCardColors.has(card.color as string)) {
        fail(`${cardPath}.color`, "is not a supported card color");
      }
      const tags = optionalArray(card.tags, `${cardPath}.tags`, kanbanLimits.tagsPerCard);
      if (tags) {
        const normalizedTags = tags.map((tag, tagIndex) => {
          const tagPath = `${cardPath}.tags[${tagIndex}]`;
          const text = optionalString(tag, tagPath, kanbanLimits.tagLength)!;
          if (text.trim() !== text || !text) fail(tagPath, "must be a non-empty trimmed string");
          return text;
        });
        if (new Set(normalizedTags).size !== normalizedTags.length) fail(`${cardPath}.tags`, "contains duplicate tags");
      }
    });
  });
  assertUnique(columnIds, "metadata.kanban.columns");
  assertUnique(cardIds, "metadata.kanban.cards");
}

function assertDatabaseMetadata(root: MetadataRecord) {
  const database = optionalRecord(root.database, "metadata.database");
  if (!database) return;
  optionalString(database.title, "metadata.database.title", databaseLimits.titleLength);

  const properties = optionalArray(database.properties, "metadata.database.properties", databaseLimits.properties);
  const propertyIds: string[] = [];
  const propertyTypes = new Map<string, string>();
  const optionIdsByProperty = new Map<string, Set<string>>();
  let titleProperties = 0;
  properties?.forEach((rawProperty, propertyIndex) => {
    const path = `metadata.database.properties[${propertyIndex}]`;
    const property = optionalRecord(rawProperty, path);
    if (!property) fail(path, "must be an object");
    const id = assertIdentifier(property.id, `${path}.id`)!;
    propertyIds.push(id);
    optionalString(property.name, `${path}.name`, databaseLimits.propertyNameLength);
    if (!databasePropertyTypes.has(property.type as string)) fail(`${path}.type`, "is not a supported property type");
    const type = String(property.type);
    propertyTypes.set(id, type);
    if (type === "title") titleProperties += 1;
    const options = optionalArray(property.options, `${path}.options`, databaseLimits.optionsPerProperty);
    const optionIds: string[] = [];
    options?.forEach((rawOption, optionIndex) => {
      const optionPath = `${path}.options[${optionIndex}]`;
      const option = optionalRecord(rawOption, optionPath);
      if (!option) fail(optionPath, "must be an object");
      optionIds.push(assertIdentifier(option.id, `${optionPath}.id`)!);
      optionalString(option.name, `${optionPath}.name`, databaseLimits.optionNameLength);
      if (option.color !== null && option.color !== undefined && !databaseOptionColors.has(option.color as string)) {
        fail(`${optionPath}.color`, "is not a supported option color");
      }
    });
    assertUnique(optionIds, `${path}.options`);
    if (options?.length && type !== "select" && type !== "multi_select") {
      fail(`${path}.options`, "would be discarded for this property type");
    }
    optionIdsByProperty.set(id, new Set(optionIds));
  });
  assertUnique(propertyIds, "metadata.database.properties");
  if (titleProperties > 1) fail("metadata.database.properties", "contains more than one title property");

  const propertyIdSet = new Set(propertyIds);
  const rows = optionalArray(database.rows, "metadata.database.rows", databaseLimits.rows);
  const rowIds: string[] = [];
  rows?.forEach((rawRow, rowIndex) => {
    const path = `metadata.database.rows[${rowIndex}]`;
    const row = optionalRecord(rawRow, path);
    if (!row) fail(path, "must be an object");
    rowIds.push(assertIdentifier(row.id, `${path}.id`)!);
    const values = optionalRecord(row.values, `${path}.values`);
    if (!values) return;
    for (const [propertyId, value] of Object.entries(values)) {
      if (!propertyIdSet.has(propertyId)) fail(`${path}.values.${propertyId}`, "references a missing property and would be discarded");
      const type = propertyTypes.get(propertyId);
      if (type === "number") {
        optionalFiniteNumber(value, `${path}.values.${propertyId}`);
      } else if (type === "checkbox") {
        optionalBoolean(value, `${path}.values.${propertyId}`);
      } else if (type === "multi_select") {
        const selected = optionalArray(value, `${path}.values.${propertyId}`, databaseLimits.optionsPerProperty);
        const selectedIds = selected?.map((item, index) => optionalString(item, `${path}.values.${propertyId}[${index}]`, databaseLimits.idLength)!) ?? [];
        if (new Set(selectedIds).size !== selectedIds.length) fail(`${path}.values.${propertyId}`, "contains duplicate options");
        const validOptions = optionIdsByProperty.get(propertyId) ?? new Set<string>();
        if (selectedIds.some((id) => !validOptions.has(id))) fail(`${path}.values.${propertyId}`, "references a missing option");
      } else if (type === "select") {
        const selected = optionalString(value, `${path}.values.${propertyId}`, databaseLimits.idLength);
        if (selected && !(optionIdsByProperty.get(propertyId) ?? new Set<string>()).has(selected)) {
          fail(`${path}.values.${propertyId}`, "references a missing option");
        }
      } else if (type === "date") {
        optionalString(value, `${path}.values.${propertyId}`, 32);
      } else if (type === "url") {
        optionalString(value, `${path}.values.${propertyId}`, databaseLimits.urlLength);
      } else {
        optionalString(value, `${path}.values.${propertyId}`, databaseLimits.textLength);
      }
    }
  });
  assertUnique(rowIds, "metadata.database.rows");

  const views = optionalArray(database.views, "metadata.database.views", databaseLimits.views);
  const viewIds: string[] = [];
  views?.forEach((rawView, viewIndex) => {
    const path = `metadata.database.views[${viewIndex}]`;
    const view = optionalRecord(rawView, path);
    if (!view) fail(path, "must be an object");
    viewIds.push(assertIdentifier(view.id, `${path}.id`)!);
    optionalString(view.name, `${path}.name`, databaseLimits.viewNameLength);
    if (!databaseViewTypes.has(view.type as string)) fail(`${path}.type`, "is not a supported view type");

    const filters = optionalArray(view.filters, `${path}.filters`, databaseLimits.filtersPerView);
    const filterIds: string[] = [];
    filters?.forEach((rawFilter, filterIndex) => {
      const filterPath = `${path}.filters[${filterIndex}]`;
      const filter = optionalRecord(rawFilter, filterPath);
      if (!filter) fail(filterPath, "must be an object");
      filterIds.push(assertIdentifier(filter.id, `${filterPath}.id`)!);
      const propertyId = assertIdentifier(filter.propertyId, `${filterPath}.propertyId`)!;
      if (!propertyIdSet.has(propertyId)) fail(`${filterPath}.propertyId`, "references a missing property");
      if (!databaseFilterOperators.has(filter.operator as string)) fail(`${filterPath}.operator`, "is not supported");
      if (typeof filter.value === "string") optionalString(filter.value, `${filterPath}.value`, databaseLimits.textLength);
      else if (filter.value !== null && filter.value !== undefined && typeof filter.value !== "boolean" && !(typeof filter.value === "number" && Number.isFinite(filter.value))) {
        fail(`${filterPath}.value`, "must be a string, finite number, boolean, or null");
      }
    });
    assertUnique(filterIds, `${path}.filters`);

    const sorts = optionalArray(view.sorts, `${path}.sorts`, databaseLimits.sortsPerView);
    const sortIds: string[] = [];
    sorts?.forEach((rawSort, sortIndex) => {
      const sortPath = `${path}.sorts[${sortIndex}]`;
      const sort = optionalRecord(rawSort, sortPath);
      if (!sort) fail(sortPath, "must be an object");
      sortIds.push(assertIdentifier(sort.id, `${sortPath}.id`)!);
      const propertyId = assertIdentifier(sort.propertyId, `${sortPath}.propertyId`)!;
      if (!propertyIdSet.has(propertyId)) fail(`${sortPath}.propertyId`, "references a missing property");
      if (sort.direction !== "ascending" && sort.direction !== "descending") fail(`${sortPath}.direction`, "must be ascending or descending");
    });
    assertUnique(sortIds, `${path}.sorts`);

    if (view.groupPropertyId !== null && view.groupPropertyId !== undefined) {
      const propertyId = assertIdentifier(view.groupPropertyId, `${path}.groupPropertyId`)!;
      if (!propertyIdSet.has(propertyId)) fail(`${path}.groupPropertyId`, "references a missing property");
      if (view.type !== "board" || !["select", "checkbox"].includes(propertyTypes.get(propertyId) ?? "")) {
        fail(`${path}.groupPropertyId`, "would be cleared because only board views may group by select or checkbox properties");
      }
    }
    const hidden = optionalArray(view.hiddenPropertyIds, `${path}.hiddenPropertyIds`, databaseLimits.properties);
    const hiddenIds = hidden?.map((item, index) => assertIdentifier(item, `${path}.hiddenPropertyIds[${index}]`)!) ?? [];
    if (hiddenIds.some((id) => !propertyIdSet.has(id))) fail(`${path}.hiddenPropertyIds`, "references a missing property");
    if (hiddenIds.some((id) => propertyTypes.get(id) === "title")) {
      fail(`${path}.hiddenPropertyIds`, "contains a title property that the editor would unhide");
    }
    assertUnique(hiddenIds, `${path}.hiddenPropertyIds`);
  });
  assertUnique(viewIds, "metadata.database.views");
  if (database.activeViewId !== null && database.activeViewId !== undefined) {
    const activeViewId = assertIdentifier(database.activeViewId, "metadata.database.activeViewId")!;
    if (!viewIds.includes(activeViewId)) fail("metadata.database.activeViewId", "references a missing view");
  }
}


function parseExactIsoDay(value: unknown, path: string) {
  const text = optionalString(value, path, 10);
  if (text === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) fail(path, "must be an exact YYYY-MM-DD value");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    fail(path, "must be a valid calendar date");
  }
  return Math.trunc(time / 86_400_000);
}

function assertGanttMetadata(root: MetadataRecord) {
  const gantt = optionalRecord(root.gantt, "metadata.gantt");
  if (!gantt) return;
  optionalString(gantt.title, "metadata.gantt.title", ganttLimits.titleLength);
  if (gantt.scale !== null && gantt.scale !== undefined && !ganttScales.has(gantt.scale as string)) {
    fail("metadata.gantt.scale", "is not a supported timeline scale");
  }
  parseExactIsoDay(gantt.viewStart, "metadata.gantt.viewStart");
  optionalBoolean(gantt.showWeekends, "metadata.gantt.showWeekends");

  const tasks = optionalArray(gantt.tasks, "metadata.gantt.tasks", ganttLimits.tasks);
  if (!tasks) return;
  const ids: string[] = [];
  tasks.forEach((rawTask, taskIndex) => {
    const path = `metadata.gantt.tasks[${taskIndex}]`;
    const task = optionalRecord(rawTask, path);
    if (!task) fail(path, "must be an object");
    const id = assertIdentifier(task.id, `${path}.id`)!;
    if (id.length > ganttLimits.idLength) fail(`${path}.id`, `contains more than ${ganttLimits.idLength} characters`);
    if (id.trim() !== id) fail(`${path}.id`, "must not contain leading or trailing whitespace");
    ids.push(id);
    optionalString(task.title, `${path}.title`, ganttLimits.taskTitleLength);
    const start = parseExactIsoDay(task.start, `${path}.start`);
    const end = parseExactIsoDay(task.end, `${path}.end`);
    if (start !== null && end !== null && end < start) {
      fail(`${path}.end`, "must be on or after the start date");
    }
    const progress = optionalFiniteNumber(task.progress, `${path}.progress`);
    if (progress !== null && (!Number.isInteger(progress) || progress < 0 || progress > 100)) {
      fail(`${path}.progress`, "must be an integer from 0 through 100");
    }
    if (task.status !== null && task.status !== undefined && !ganttStatuses.has(task.status as string)) {
      fail(`${path}.status`, "is not a supported task status");
    }
    optionalString(task.assignee, `${path}.assignee`, ganttLimits.assigneeLength);
  });
  assertUnique(ids, "metadata.gantt.tasks");
}

function assertBookmarkMetadata(root: MetadataRecord) {
  const bookmark = optionalRecord(root.bookmark, "metadata.bookmark");
  if (!bookmark) return;
  if (bookmark.view !== null && bookmark.view !== undefined && bookmark.view !== "list" && bookmark.view !== "gallery") {
    fail("metadata.bookmark.view", "must be list or gallery");
  }
  const items = optionalArray(bookmark.items, "metadata.bookmark.items", bookmarkLimits.items);
  if (!items) return;
  const ids: string[] = [];
  const urls: string[] = [];
  items.forEach((rawItem, itemIndex) => {
    const path = `metadata.bookmark.items[${itemIndex}]`;
    const item = optionalRecord(rawItem, path);
    if (!item) fail(path, "must be an object");
    const id = assertCanonicalBookmarkText(item.id, `${path}.id`, bookmarkLimits.idLength, { required: true });
    ids.push(id);
    const url = canonicalBookmarkUrl(item.url, `${path}.url`);
    if (!url) fail(`${path}.url`, "must be a non-empty HTTP(S) URL");
    urls.push(url);
    assertCanonicalBookmarkText(item.title, `${path}.title`, bookmarkLimits.titleLength);
    assertCanonicalBookmarkText(item.description, `${path}.description`, bookmarkLimits.descriptionLength);
    assertCanonicalBookmarkText(item.siteName, `${path}.siteName`, bookmarkLimits.siteNameLength);
    canonicalBookmarkUrl(item.imageUrl, `${path}.imageUrl`, url);
    canonicalBookmarkUrl(item.faviconUrl, `${path}.faviconUrl`, url);
  });
  assertUnique(ids, "metadata.bookmark.items");
  if (new Set(urls).size !== urls.length) fail("metadata.bookmark.items", "contains duplicate URLs that the editor would discard");
}

function isValidAnsweredAt(value: string) {
  if (!value) return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute);
}

function assertAiChatMetadata(root: MetadataRecord) {
  const aiChat = optionalRecord(root.aiChat, "metadata.aiChat");
  if (!aiChat) return;
  if (aiChat.provider !== null && aiChat.provider !== undefined && !aiProviderIds.has(aiChat.provider as string)) {
    fail("metadata.aiChat.provider", "is not a supported AI provider");
  }
  const model = optionalString(aiChat.model, "metadata.aiChat.model", aiChatLimits.modelLength);
  if (model !== null && (model.includes("\u0000") || model.trim() !== model)) {
    fail("metadata.aiChat.model", "contains characters or whitespace that would be removed by the editor");
  }
  const answeredAt = optionalString(aiChat.answeredAt, "metadata.aiChat.answeredAt", aiChatLimits.answeredAtLength);
  if (answeredAt !== null && !isValidAnsweredAt(answeredAt)) fail("metadata.aiChat.answeredAt", "must be an exact YYYY-MM-DDTHH:mm value");
  const question = optionalString(aiChat.question, "metadata.aiChat.question", aiChatLimits.questionLength);
  const answer = optionalString(aiChat.answer, "metadata.aiChat.answer", aiChatLimits.answerLength);
  if (question?.includes("\u0000")) fail("metadata.aiChat.question", "contains a NUL character that would be removed");
  if (answer?.includes("\u0000")) fail("metadata.aiChat.answer", "contains a NUL character that would be removed");
}

export function assertStructuredBlockMetadataIntegrity(type: BlockType, metadata: unknown) {
  if (!["TABLE", "KANBAN", "DATABASE", "GANTT", "BOOKMARK", "AI_CHAT"].includes(type)) return undefined;
  const root = parseMetadataRoot(metadata);
  if (!root) return null;
  if (type === "TABLE") assertTableMetadata(root);
  else if (type === "KANBAN") assertKanbanMetadata(root);
  else if (type === "DATABASE") assertDatabaseMetadata(root);
  else if (type === "GANTT") assertGanttMetadata(root);
  else if (type === "BOOKMARK") assertBookmarkMetadata(root);
  else assertAiChatMetadata(root);
  // MariaDB may return JSON columns as text. Return the validated object so
  // callers serialize it exactly once instead of storing a JSON string value.
  return root;
}

export type BackupBlockMetadataRecord = {
  id: string;
  type: BlockType;
  metadata: string | null;
};

export class BackupMetadataIntegrityError extends Error {
  readonly blockId: string;
  readonly path: string;
  readonly reason: string;

  constructor(blockId: string, path: string, reason: string) {
    super(`${blockId} ${path}: ${reason}`);
    this.name = "BackupMetadataIntegrityError";
    this.blockId = blockId;
    this.path = path;
    this.reason = reason;
  }
}

export function assertLosslessBackupBlockMetadata(block: BackupBlockMetadataRecord) {
  if (block.metadata !== null) {
    try {
      JSON.parse(block.metadata);
    } catch {
      throw new BackupMetadataIntegrityError(block.id, "metadata", "must contain valid JSON");
    }
  }

  try {
    // Validate the serialized backup value directly. Passing the already-decoded
    // value would accidentally accept double-encoded JSON strings and restore a
    // representation that the editor only decodes once.
    assertStructuredBlockMetadataIntegrity(block.type, block.metadata);
  } catch (error) {
    if (error instanceof StructuredMetadataIntegrityError) {
      const prefix = `${error.path}: `;
      const reason = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
      throw new BackupMetadataIntegrityError(block.id, error.path, reason);
    }
    throw error;
  }
}
