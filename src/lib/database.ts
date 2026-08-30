export const databaseLimits = {
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

export const databasePropertyTypes = [
  "title",
  "text",
  "number",
  "select",
  "multi_select",
  "checkbox",
  "date",
  "url"
] as const;
export type DatabasePropertyType = (typeof databasePropertyTypes)[number];

export const databaseViewTypes = ["table", "board", "list"] as const;
export type DatabaseViewType = (typeof databaseViewTypes)[number];

export const databaseOptionColors = ["gray", "blue", "purple", "green", "yellow", "red", "pink", "orange"] as const;
export type DatabaseOptionColor = (typeof databaseOptionColors)[number];

export const databaseFilterOperators = [
  "contains",
  "equals",
  "is_empty",
  "is_not_empty",
  "checked",
  "unchecked"
] as const;
const unsafeDatabaseIds = new Set(["__proto__", "constructor", "prototype"]);
export type DatabaseFilterOperator = (typeof databaseFilterOperators)[number];

export type DatabaseOption = {
  id: string;
  name: string;
  color: DatabaseOptionColor;
};

export type DatabaseProperty = {
  id: string;
  name: string;
  type: DatabasePropertyType;
  options: DatabaseOption[];
};

export type DatabaseValue = string | number | boolean | string[] | null;

export type DatabaseRow = {
  id: string;
  values: Record<string, DatabaseValue>;
};

export type DatabaseFilter = {
  id: string;
  propertyId: string;
  operator: DatabaseFilterOperator;
  value: string | number | boolean | null;
};

export type DatabaseSort = {
  id: string;
  propertyId: string;
  direction: "ascending" | "descending";
};

export type DatabaseView = {
  id: string;
  name: string;
  type: DatabaseViewType;
  filters: DatabaseFilter[];
  sorts: DatabaseSort[];
  groupPropertyId: string | null;
  hiddenPropertyIds: string[];
};

export type DatabaseData = {
  title: string;
  properties: DatabaseProperty[];
  rows: DatabaseRow[];
  views: DatabaseView[];
  activeViewId: string;
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
  const id = typeof value === "string" ? value.trim().slice(0, databaseLimits.idLength) : "";
  if (id && !unsafeDatabaseIds.has(id)) return id;
  const fallbackId = fallback.slice(0, databaseLimits.idLength);
  return fallbackId && !unsafeDatabaseIds.has(fallbackId) ? fallbackId : "";
}

function uniqueId(requested: string, seen: Set<string>, fallbackPrefix: string) {
  let id = requested.slice(0, databaseLimits.idLength);
  let attempt = 1;
  while (seen.has(id)) {
    const suffix = `-${attempt}`;
    const prefixLength = Math.max(0, databaseLimits.idLength - suffix.length);
    id = `${fallbackPrefix.slice(0, prefixLength)}${suffix}`;
    attempt += 1;
  }
  seen.add(id);
  return id;
}

type DatabaseIdAliases = {
  exact: Map<string, string>;
  normalized: Map<string, string>;
};

function createIdAliases(): DatabaseIdAliases {
  return { exact: new Map(), normalized: new Map() };
}

function sourceStringId(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function registerExactIdAlias(aliases: DatabaseIdAliases, sourceId: string | null, canonicalId: string) {
  if (sourceId && !aliases.exact.has(sourceId)) aliases.exact.set(sourceId, canonicalId);
}

function registerNormalizedIdAlias(
  aliases: DatabaseIdAliases,
  requestedId: string,
  canonicalId: string
) {
  for (const alias of [requestedId, canonicalId]) {
    if (!alias || aliases.exact.has(alias) || aliases.normalized.has(alias)) continue;
    aliases.normalized.set(alias, canonicalId);
  }
}

function resolveIdReference(value: unknown, aliases: DatabaseIdAliases) {
  if (typeof value !== "string") return "";
  const exact = aliases.exact.get(value);
  if (exact !== undefined) return exact;
  const normalized = safeId(value, "");
  if (!normalized) return "";
  return aliases.exact.get(normalized) ?? aliases.normalized.get(normalized) ?? normalized;
}

function normalizePropertyType(value: unknown): DatabasePropertyType {
  return databasePropertyTypes.includes(value as DatabasePropertyType)
    ? (value as DatabasePropertyType)
    : "text";
}

function normalizeViewType(value: unknown): DatabaseViewType {
  return databaseViewTypes.includes(value as DatabaseViewType)
    ? (value as DatabaseViewType)
    : "table";
}

function normalizeOptionColor(value: unknown, index: number): DatabaseOptionColor {
  return databaseOptionColors.includes(value as DatabaseOptionColor)
    ? (value as DatabaseOptionColor)
    : databaseOptionColors[index % databaseOptionColors.length];
}

type NormalizedDatabaseOptions = {
  options: DatabaseOption[];
  aliases: DatabaseIdAliases;
};

function normalizeOptions(value: unknown, propertyId: string): NormalizedDatabaseOptions {
  const aliases = createIdAliases();
  if (!Array.isArray(value)) return { options: [], aliases };
  const seen = new Set<string>();
  const descriptors = value
    .slice(0, databaseLimits.optionsPerProperty)
    .map((item) => recordValue(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item, index) => {
      const sourceId = sourceStringId(item.id);
      const requestedId = safeId(item.id, `${propertyId}-option-${index + 1}`);
      const id = uniqueId(requestedId, seen, `${propertyId}-option-${index + 1}`);
      registerExactIdAlias(aliases, sourceId, id);
      const option: DatabaseOption = {
        id,
        name: stringValue(item.name, `Option ${index + 1}`, databaseLimits.optionNameLength),
        color: normalizeOptionColor(item.color, index)
      };
      return { sourceId, requestedId, option };
    });

  for (const descriptor of descriptors) {
    registerNormalizedIdAlias(aliases, descriptor.requestedId, descriptor.option.id);
  }
  return { options: descriptors.map((descriptor) => descriptor.option), aliases };
}

function normalizePropertyValue(property: DatabaseProperty, value: unknown): DatabaseValue {
  switch (property.type) {
    case "number": {
      if (value === null || value === "" || value === undefined) return null;
      const number = typeof value === "number" ? value : Number(value);
      return Number.isFinite(number) ? number : null;
    }
    case "checkbox":
      return value === true;
    case "select": {
      const optionId = typeof value === "string" ? value : "";
      return property.options.some((option) => option.id === optionId) ? optionId : "";
    }
    case "multi_select": {
      const optionIds = Array.isArray(value) ? value : [];
      return [...new Set(optionIds.filter((item): item is string => typeof item === "string"))]
        .filter((id) => property.options.some((option) => option.id === id))
        .slice(0, databaseLimits.optionsPerProperty);
    }
    case "date":
      return stringValue(value, "", 32);
    case "url":
      return stringValue(value, "", databaseLimits.urlLength);
    case "title":
    case "text":
    default:
      return stringValue(value, "", databaseLimits.textLength);
  }
}

function normalizeFilterOperator(value: unknown): DatabaseFilterOperator {
  return databaseFilterOperators.includes(value as DatabaseFilterOperator)
    ? (value as DatabaseFilterOperator)
    : "contains";
}

function normalizeFilterValue(value: unknown): string | number | boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, databaseLimits.textLength);
  return null;
}

type DatabasePropertyDescriptor = {
  sourceId: string | null;
  requestedId: string;
  property: DatabaseProperty;
  optionAliases: DatabaseIdAliases;
};

function readSourcePropertyValue(
  sourceValues: Record<string, unknown>,
  descriptor: DatabasePropertyDescriptor,
  propertyAliases: DatabaseIdAliases
) {
  const candidates = [descriptor.sourceId, descriptor.requestedId, descriptor.property.id];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (!Object.prototype.hasOwnProperty.call(sourceValues, candidate)) continue;
    if (resolveIdReference(candidate, propertyAliases) !== descriptor.property.id) continue;
    return sourceValues[candidate];
  }
  return undefined;
}

function normalizeReferencedPropertyValue(descriptor: DatabasePropertyDescriptor, value: unknown) {
  if (descriptor.property.type === "select" && typeof value === "string") {
    return normalizePropertyValue(descriptor.property, resolveIdReference(value, descriptor.optionAliases));
  }
  if (descriptor.property.type === "multi_select" && Array.isArray(value)) {
    const remapped = value.map((item) =>
      typeof item === "string" ? resolveIdReference(item, descriptor.optionAliases) : item
    );
    return normalizePropertyValue(descriptor.property, remapped);
  }
  return normalizePropertyValue(descriptor.property, value);
}

function normalizeFilterValueForProperty(descriptor: DatabasePropertyDescriptor, value: unknown) {
  if ((descriptor.property.type === "select" || descriptor.property.type === "multi_select")
    && typeof value === "string") {
    const remapped = resolveIdReference(value, descriptor.optionAliases);
    if (descriptor.property.options.some((option) => option.id === remapped)) return remapped;
  }
  return normalizeFilterValue(value);
}

export function createDefaultDatabaseData(): DatabaseData {
  const properties: DatabaseProperty[] = [
    { id: "title", name: "Name", type: "title", options: [] },
    {
      id: "status",
      name: "Status",
      type: "select",
      options: [
        { id: "not-started", name: "Not started", color: "gray" },
        { id: "in-progress", name: "In progress", color: "blue" },
        { id: "done", name: "Done", color: "green" }
      ]
    },
    { id: "tags", name: "Tags", type: "multi_select", options: [] },
    { id: "due", name: "Due", type: "date", options: [] },
    { id: "complete", name: "Complete", type: "checkbox", options: [] }
  ];

  return {
    title: "Database",
    properties,
    rows: [{ id: "row-1", values: { title: "", status: "not-started", tags: [], due: "", complete: false } }],
    views: [
      {
        id: "table-view",
        name: "Table",
        type: "table",
        filters: [],
        sorts: [],
        groupPropertyId: null,
        hiddenPropertyIds: []
      },
      {
        id: "board-view",
        name: "Board",
        type: "board",
        filters: [],
        sorts: [],
        groupPropertyId: "status",
        hiddenPropertyIds: ["status"]
      }
    ],
    activeViewId: "table-view"
  };
}

export function getDatabaseData(metadata: unknown): DatabaseData {
  const value = parseMetadata(metadata)?.database;
  if (!value || typeof value !== "object" || Array.isArray(value)) return createDefaultDatabaseData();
  const source = value as Record<string, unknown>;

  const propertySources = Array.isArray(source.properties)
    ? source.properties.slice(0, databaseLimits.properties)
    : [];
  const seenPropertyIds = new Set<string>();
  const propertyAliases = createIdAliases();
  let titlePropertySeen = false;
  const propertyDescriptors: DatabasePropertyDescriptor[] = propertySources
    .map((item) => recordValue(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item, index) => {
      const sourceId = sourceStringId(item.id);
      const requestedId = safeId(item.id, `property-${index + 1}`);
      const id = uniqueId(requestedId, seenPropertyIds, `property-${index + 1}`);
      registerExactIdAlias(propertyAliases, sourceId, id);
      let type = normalizePropertyType(item.type);
      if (type === "title") {
        if (titlePropertySeen) type = "text";
        else titlePropertySeen = true;
      }
      const normalizedOptions = type === "select" || type === "multi_select"
        ? normalizeOptions(item.options, id)
        : { options: [], aliases: createIdAliases() };
      const property: DatabaseProperty = {
        id,
        name: stringValue(
          item.name,
          type === "title" ? "Name" : `Property ${index + 1}`,
          databaseLimits.propertyNameLength
        ),
        type,
        options: normalizedOptions.options
      };
      return { sourceId, requestedId, property, optionAliases: normalizedOptions.aliases };
    });

  if (!titlePropertySeen) {
    const id = uniqueId("title", seenPropertyIds, "title");
    propertyDescriptors.unshift({
      sourceId: null,
      requestedId: id,
      property: { id, name: "Name", type: "title", options: [] },
      optionAliases: createIdAliases()
    });
  }

  for (const descriptor of propertyDescriptors) {
    registerNormalizedIdAlias(propertyAliases, descriptor.requestedId, descriptor.property.id);
  }
  const properties = propertyDescriptors.map((descriptor) => descriptor.property);
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const propertyDescriptorById = new Map(
    propertyDescriptors.map((descriptor) => [descriptor.property.id, descriptor])
  );

  const rowSources = Array.isArray(source.rows) ? source.rows.slice(0, databaseLimits.rows) : [];
  const seenRowIds = new Set<string>();
  const rows = rowSources
    .map((item) => recordValue(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item, rowIndex) => {
      const id = uniqueId(safeId(item.id, `row-${rowIndex + 1}`), seenRowIds, `row-${rowIndex + 1}`);
      const sourceValues = recordValue(item.values) ?? {};
      const values: Record<string, DatabaseValue> = {};
      for (const descriptor of propertyDescriptors) {
        const sourceValue = readSourcePropertyValue(sourceValues, descriptor, propertyAliases);
        values[descriptor.property.id] = normalizeReferencedPropertyValue(descriptor, sourceValue);
      }
      return { id, values };
    });

  const viewSources = Array.isArray(source.views) ? source.views.slice(0, databaseLimits.views) : [];
  const seenViewIds = new Set<string>();
  const viewAliases = createIdAliases();
  const viewDescriptors = viewSources
    .map((item) => recordValue(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item, viewIndex) => {
      const sourceId = sourceStringId(item.id);
      const requestedId = safeId(item.id, `view-${viewIndex + 1}`);
      const id = uniqueId(requestedId, seenViewIds, `view-${viewIndex + 1}`);
      registerExactIdAlias(viewAliases, sourceId, id);
      const type = normalizeViewType(item.type);
      const filterSources = Array.isArray(item.filters)
        ? item.filters.slice(0, databaseLimits.filtersPerView)
        : [];
      const seenFilterIds = new Set<string>();
      const filters = filterSources
        .map((filter) => recordValue(filter))
        .filter((filter): filter is Record<string, unknown> => Boolean(filter))
        .map((filter, filterIndex): DatabaseFilter => {
          const propertyId = resolveIdReference(filter.propertyId, propertyAliases);
          const propertyDescriptor = propertyDescriptorById.get(propertyId);
          return {
            id: uniqueId(
              safeId(filter.id, `${id}-filter-${filterIndex + 1}`),
              seenFilterIds,
              `${id}-filter-${filterIndex + 1}`
            ),
            propertyId,
            operator: normalizeFilterOperator(filter.operator),
            value: propertyDescriptor
              ? normalizeFilterValueForProperty(propertyDescriptor, filter.value)
              : normalizeFilterValue(filter.value)
          };
        })
        .filter((filter) => propertyById.has(filter.propertyId));

      const sortSources = Array.isArray(item.sorts) ? item.sorts.slice(0, databaseLimits.sortsPerView) : [];
      const seenSortIds = new Set<string>();
      const sorts = sortSources
        .map((sort) => recordValue(sort))
        .filter((sort): sort is Record<string, unknown> => Boolean(sort))
        .map((sort, sortIndex): DatabaseSort => ({
          id: uniqueId(
            safeId(sort.id, `${id}-sort-${sortIndex + 1}`),
            seenSortIds,
            `${id}-sort-${sortIndex + 1}`
          ),
          propertyId: resolveIdReference(sort.propertyId, propertyAliases),
          direction: sort.direction === "descending" ? "descending" : "ascending"
        }))
        .filter((sort) => propertyById.has(sort.propertyId));

      const requestedGroupPropertyId = resolveIdReference(item.groupPropertyId, propertyAliases);
      const groupProperty = propertyById.get(requestedGroupPropertyId);
      const groupPropertyId = type === "board" && groupProperty && ["select", "checkbox"].includes(groupProperty.type)
        ? groupProperty.id
        : null;

      const hiddenPropertyIds = Array.isArray(item.hiddenPropertyIds)
        ? [...new Set(item.hiddenPropertyIds
          .filter((propertyId): propertyId is string => typeof propertyId === "string")
          .map((propertyId) => resolveIdReference(propertyId, propertyAliases)))]
          .filter((propertyId) => propertyById.has(propertyId) && propertyById.get(propertyId)?.type !== "title")
        : [];

      const view: DatabaseView = {
        id,
        name: stringValue(
          item.name,
          type === "board" ? "Board" : type === "list" ? "List" : "Table",
          databaseLimits.viewNameLength
        ),
        type,
        filters,
        sorts,
        groupPropertyId,
        hiddenPropertyIds
      };
      return { sourceId, requestedId, view };
    });

  for (const descriptor of viewDescriptors) {
    registerNormalizedIdAlias(viewAliases, descriptor.requestedId, descriptor.view.id);
  }
  const views = viewDescriptors.map((descriptor) => descriptor.view);

  const fallback = createDefaultDatabaseData();
  const fallbackViews = fallback.views.map((view) => {
    const requestedGroupProperty = view.groupPropertyId
      ? propertyById.get(view.groupPropertyId)
      : null;
    return {
      ...view,
      groupPropertyId: view.type === "board"
        && requestedGroupProperty
        && ["select", "checkbox"].includes(requestedGroupProperty.type)
        ? requestedGroupProperty.id
        : null,
      hiddenPropertyIds: view.hiddenPropertyIds.filter(
        (propertyId) => propertyById.has(propertyId) && propertyById.get(propertyId)?.type !== "title"
      )
    };
  });
  const normalizedViews = views.length ? views : fallbackViews;
  const requestedActiveViewId = resolveIdReference(source.activeViewId, viewAliases);
  const activeViewId = normalizedViews.some((view) => view.id === requestedActiveViewId)
    ? requestedActiveViewId
    : normalizedViews[0].id;

  return {
    title: stringValue(source.title, fallback.title, databaseLimits.titleLength),
    properties,
    rows,
    views: normalizedViews,
    activeViewId
  };
}

export function getDatabaseTitleProperty(database: DatabaseData) {
  return database.properties.find((property) => property.type === "title") ?? database.properties[0];
}

export function getDatabaseActiveView(database: DatabaseData) {
  return database.views.find((view) => view.id === database.activeViewId) ?? database.views[0];
}

export function getDatabaseOption(property: DatabaseProperty, optionId: unknown) {
  return property.options.find((option) => option.id === optionId) ?? null;
}

function isEmptyValue(value: DatabaseValue) {
  return value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function searchableValue(property: DatabaseProperty, value: DatabaseValue) {
  if (property.type === "select") return getDatabaseOption(property, value)?.name ?? "";
  if (property.type === "multi_select") {
    return Array.isArray(value)
      ? value.map((id) => getDatabaseOption(property, id)?.name ?? "").filter(Boolean).join(" ")
      : "";
  }
  if (property.type === "checkbox") return value === true ? "true checked yes" : "false unchecked no";
  return value === null || value === undefined ? "" : String(value);
}

function rowMatchesFilter(row: DatabaseRow, filter: DatabaseFilter, propertyById: Map<string, DatabaseProperty>) {
  const property = propertyById.get(filter.propertyId);
  if (!property) return true;
  const value = row.values[property.id];
  if (filter.operator === "is_empty") return isEmptyValue(value);
  if (filter.operator === "is_not_empty") return !isEmptyValue(value);
  if (filter.operator === "checked") return value === true;
  if (filter.operator === "unchecked") return value !== true;

  if (property.type === "multi_select") {
    const values = Array.isArray(value) ? value : [];
    return filter.operator === "equals"
      ? values.length === 1 && values[0] === filter.value
      : values.includes(String(filter.value ?? ""));
  }

  if (property.type === "number") {
    const filterNumber = Number(filter.value);
    return Number.isFinite(filterNumber) && value === filterNumber;
  }

  if (property.type === "select") return value === filter.value;
  const left = searchableValue(property, value).toLocaleLowerCase();
  const right = String(filter.value ?? "").toLocaleLowerCase();
  return filter.operator === "equals" ? left === right : left.includes(right);
}

function compareValues(property: DatabaseProperty, left: DatabaseValue, right: DatabaseValue) {
  if (isEmptyValue(left) && isEmptyValue(right)) return 0;
  if (isEmptyValue(left)) return 1;
  if (isEmptyValue(right)) return -1;
  if (property.type === "number") return Number(left) - Number(right);
  if (property.type === "checkbox") return Number(Boolean(left)) - Number(Boolean(right));
  return searchableValue(property, left).localeCompare(searchableValue(property, right), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

export function applyDatabaseView(database: DatabaseData, view = getDatabaseActiveView(database)) {
  const propertyById = new Map(database.properties.map((property) => [property.id, property]));
  const rows = database.rows.filter((row) => view.filters.every((filter) => rowMatchesFilter(row, filter, propertyById)));
  if (!view.sorts.length) return rows;

  return rows.slice().sort((left, right) => {
    for (const sort of view.sorts) {
      const property = propertyById.get(sort.propertyId);
      if (!property) continue;
      const result = compareValues(property, left.values[property.id], right.values[property.id]);
      if (result !== 0) return sort.direction === "descending" ? -result : result;
    }
    return 0;
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderDatabaseValue(property: DatabaseProperty, value: DatabaseValue) {
  if (property.type === "checkbox") return value === true ? "✓" : "";
  if (property.type === "select") {
    const option = getDatabaseOption(property, value);
    return option
      ? `<span class="rendered-database-option rendered-database-option--${option.color}">${escapeHtml(option.name)}</span>`
      : "";
  }
  if (property.type === "multi_select") {
    if (!Array.isArray(value)) return "";
    return value
      .map((id) => getDatabaseOption(property, id))
      .filter((option): option is DatabaseOption => Boolean(option))
      .map((option) => `<span class="rendered-database-option rendered-database-option--${option.color}">${escapeHtml(option.name)}</span>`)
      .join(" ");
  }
  if (property.type === "url" && typeof value === "string" && /^https?:\/\//i.test(value)) {
    const safe = escapeHtml(value);
    return `<a href="${safe}">${safe}</a>`;
  }
  return escapeHtml(value === null || value === undefined ? "" : String(value));
}

function renderDatabaseTable(database: DatabaseData, view: DatabaseView, rows: DatabaseRow[]) {
  const visibleProperties = database.properties.filter((property) => !view.hiddenPropertyIds.includes(property.id));
  const head = visibleProperties.map((property) => `<th scope="col">${escapeHtml(property.name)}</th>`).join("");
  const body = rows.map((row) => `<tr>${visibleProperties
    .map((property) => `<td>${renderDatabaseValue(property, row.values[property.id])}</td>`)
    .join("")}</tr>`).join("");
  return `<div class="rendered-database-table-wrap"><table class="rendered-database-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderDatabaseList(database: DatabaseData, view: DatabaseView, rows: DatabaseRow[]) {
  const titleProperty = getDatabaseTitleProperty(database);
  const visibleProperties = database.properties.filter(
    (property) => property.id !== titleProperty.id && !view.hiddenPropertyIds.includes(property.id)
  );
  const items = rows.map((row) => {
    const details = visibleProperties
      .map((property) => {
        const rendered = renderDatabaseValue(property, row.values[property.id]);
        return rendered ? `<span class="rendered-database-list-property"><small>${escapeHtml(property.name)}</small>${rendered}</span>` : "";
      })
      .filter(Boolean)
      .join("");
    return `<li><strong>${renderDatabaseValue(titleProperty, row.values[titleProperty.id]) || "Untitled"}</strong><div>${details}</div></li>`;
  }).join("");
  return `<ul class="rendered-database-list">${items}</ul>`;
}

function renderDatabaseBoard(database: DatabaseData, view: DatabaseView, rows: DatabaseRow[]) {
  const titleProperty = getDatabaseTitleProperty(database);
  const groupProperty = database.properties.find((property) => property.id === view.groupPropertyId) ?? null;
  const visibleProperties = database.properties.filter(
    (property) => property.id !== titleProperty.id && property.id !== groupProperty?.id && !view.hiddenPropertyIds.includes(property.id)
  );

  const groups: Array<{ id: string; name: string; color: string; rows: DatabaseRow[] }> = [];
  if (groupProperty?.type === "select") {
    for (const option of groupProperty.options) groups.push({ id: option.id, name: option.name, color: option.color, rows: [] });
    groups.push({ id: "", name: "No value", color: "gray", rows: [] });
  } else if (groupProperty?.type === "checkbox") {
    groups.push(
      { id: "false", name: "Unchecked", color: "gray", rows: [] },
      { id: "true", name: "Checked", color: "green", rows: [] }
    );
  } else {
    groups.push({ id: "all", name: "All", color: "gray", rows: [] });
  }

  for (const row of rows) {
    const value = groupProperty ? row.values[groupProperty.id] : "all";
    const groupId = groupProperty?.type === "checkbox" ? String(value === true) : String(value ?? "");
    (groups.find((group) => group.id === groupId) ?? groups[groups.length - 1]).rows.push(row);
  }

  const columns = groups.map((group) => {
    const cards = group.rows.map((row) => {
      const details = visibleProperties
        .map((property) => {
          const rendered = renderDatabaseValue(property, row.values[property.id]);
          return rendered ? `<span class="rendered-database-card-property"><small>${escapeHtml(property.name)}</small>${rendered}</span>` : "";
        })
        .filter(Boolean)
        .join("");
      return `<article class="rendered-database-card"><strong>${renderDatabaseValue(titleProperty, row.values[titleProperty.id]) || "Untitled"}</strong>${details}</article>`;
    }).join("");
    return `<section class="rendered-database-board-column rendered-database-board-column--${group.color}"><header><span>${escapeHtml(group.name)}</span><small>${group.rows.length}</small></header><div>${cards}</div></section>`;
  }).join("");

  return `<div class="rendered-database-board">${columns}</div>`;
}

export function renderDatabaseHtml(metadata: unknown) {
  const database = getDatabaseData(metadata);
  const view = getDatabaseActiveView(database);
  const rows = applyDatabaseView(database, view);
  const content = view.type === "board"
    ? renderDatabaseBoard(database, view, rows)
    : view.type === "list"
      ? renderDatabaseList(database, view, rows)
      : renderDatabaseTable(database, view, rows);
  return `<div class="rendered-database"><header><h3>${escapeHtml(database.title)}</h3><span>${escapeHtml(view.name)} · ${rows.length}</span></header>${content}</div>`;
}
