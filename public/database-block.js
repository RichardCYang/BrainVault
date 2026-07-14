import { formatNumber, t } from "./i18n.js";

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
  textLength: 2000,
  urlLength: 2000
};

export const databasePropertyTypes = ["title", "text", "number", "select", "multi_select", "checkbox", "date", "url"];
export const databaseViewTypes = ["table", "board", "list"];
const databaseOptionColors = ["gray", "blue", "purple", "green", "yellow", "red", "pink", "orange"];
const databaseFilterOperators = ["contains", "equals", "is_empty", "is_not_empty", "checked", "unchecked"];

function createId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`.slice(0, 64);
}

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value, fallback, maxLength) {
  return (typeof value === "string" ? value : fallback).slice(0, maxLength);
}

function safeId(value, fallback) {
  const id = typeof value === "string" ? value.trim().slice(0, 64) : "";
  return id || fallback;
}

function uniqueId(value, seen, fallbackPrefix) {
  let id = value;
  let attempt = 1;
  while (seen.has(id)) {
    id = `${fallbackPrefix}-${attempt}`.slice(0, 64);
    attempt += 1;
  }
  seen.add(id);
  return id;
}

function normalizePropertyType(value) {
  return databasePropertyTypes.includes(value) ? value : "text";
}

function normalizeViewType(value) {
  return databaseViewTypes.includes(value) ? value : "table";
}

function normalizeOptionColor(value, index) {
  return databaseOptionColors.includes(value) ? value : databaseOptionColors[index % databaseOptionColors.length];
}

function normalizeOptions(value, propertyId) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .slice(0, databaseLimits.optionsPerProperty)
    .map(recordValue)
    .filter(Boolean)
    .map((item, index) => ({
      id: uniqueId(safeId(item.id, `${propertyId}-option-${index + 1}`), seen, `${propertyId}-option-${index + 1}`),
      name: stringValue(item.name, `${t("database.option")} ${formatNumber(index + 1)}`, databaseLimits.optionNameLength),
      color: normalizeOptionColor(item.color, index)
    }));
}

function normalizePropertyValue(property, value) {
  if (property.type === "number") {
    if (value === null || value === "" || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (property.type === "checkbox") return value === true;
  if (property.type === "select") {
    const optionId = typeof value === "string" ? value : "";
    return property.options.some((option) => option.id === optionId) ? optionId : "";
  }
  if (property.type === "multi_select") {
    const values = Array.isArray(value) ? value : [];
    return [...new Set(values.filter((item) => typeof item === "string"))]
      .filter((id) => property.options.some((option) => option.id === id))
      .slice(0, databaseLimits.optionsPerProperty);
  }
  if (property.type === "date") return stringValue(value, "", 32);
  if (property.type === "url") return stringValue(value, "", databaseLimits.urlLength);
  return stringValue(value, "", databaseLimits.textLength);
}

export function createDefaultDatabaseData() {
  const tableViewId = createId("view");
  const boardViewId = createId("view");
  return {
    title: t("database.defaultTitle"),
    properties: [
      { id: "title", name: t("database.defaultNameProperty"), type: "title", options: [] },
      {
        id: "status",
        name: t("database.defaultStatusProperty"),
        type: "select",
        options: [
          { id: "not-started", name: t("database.defaultNotStarted"), color: "gray" },
          { id: "in-progress", name: t("database.defaultInProgress"), color: "blue" },
          { id: "done", name: t("database.defaultDone"), color: "green" }
        ]
      },
      { id: "tags", name: t("database.defaultTagsProperty"), type: "multi_select", options: [] },
      { id: "due", name: t("database.defaultDueProperty"), type: "date", options: [] },
      { id: "complete", name: t("database.defaultCompleteProperty"), type: "checkbox", options: [] }
    ],
    rows: [
      {
        id: createId("row"),
        values: { title: "", status: "not-started", tags: [], due: "", complete: false }
      }
    ],
    views: [
      {
        id: tableViewId,
        name: t("database.tableView"),
        type: "table",
        filters: [],
        sorts: [],
        groupPropertyId: null,
        hiddenPropertyIds: []
      },
      {
        id: boardViewId,
        name: t("database.boardView"),
        type: "board",
        filters: [],
        sorts: [],
        groupPropertyId: "status",
        hiddenPropertyIds: ["status"]
      }
    ],
    activeViewId: tableViewId
  };
}

export function normalizeDatabaseData(value) {
  const source = recordValue(value) ?? {};
  const fallback = createDefaultDatabaseData();
  const propertySources = Array.isArray(source.properties) ? source.properties.slice(0, databaseLimits.properties) : [];
  const seenPropertyIds = new Set();
  let titleSeen = false;
  const properties = propertySources
    .map(recordValue)
    .filter(Boolean)
    .map((item, index) => {
      const id = uniqueId(safeId(item.id, createId("property")), seenPropertyIds, `property-${index + 1}`);
      let type = normalizePropertyType(item.type);
      if (type === "title") {
        if (titleSeen) type = "text";
        else titleSeen = true;
      }
      return {
        id,
        name: stringValue(item.name, type === "title" ? t("database.defaultNameProperty") : t("database.newProperty"), databaseLimits.propertyNameLength),
        type,
        options: type === "select" || type === "multi_select" ? normalizeOptions(item.options, id) : []
      };
    });

  if (!titleSeen) {
    const id = uniqueId("title", seenPropertyIds, "title");
    properties.unshift({ id, name: t("database.defaultNameProperty"), type: "title", options: [] });
  }

  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const rowSources = Array.isArray(source.rows) ? source.rows.slice(0, databaseLimits.rows) : [];
  const seenRowIds = new Set();
  const rows = rowSources
    .map(recordValue)
    .filter(Boolean)
    .map((item, index) => {
      const id = uniqueId(safeId(item.id, createId("row")), seenRowIds, `row-${index + 1}`);
      const sourceValues = recordValue(item.values) ?? {};
      const values = {};
      properties.forEach((property) => {
        values[property.id] = normalizePropertyValue(property, sourceValues[property.id]);
      });
      return { id, values };
    });

  const viewSources = Array.isArray(source.views) ? source.views.slice(0, databaseLimits.views) : [];
  const seenViewIds = new Set();
  const views = viewSources
    .map(recordValue)
    .filter(Boolean)
    .map((item, index) => {
      const id = uniqueId(safeId(item.id, createId("view")), seenViewIds, `view-${index + 1}`);
      const type = normalizeViewType(item.type);
      const filters = (Array.isArray(item.filters) ? item.filters : [])
        .slice(0, databaseLimits.filtersPerView)
        .map(recordValue)
        .filter(Boolean)
        .map((filter, filterIndex) => ({
          id: safeId(filter.id, `${id}-filter-${filterIndex + 1}`),
          propertyId: safeId(filter.propertyId, ""),
          operator: databaseFilterOperators.includes(filter.operator) ? filter.operator : "contains",
          value: typeof filter.value === "boolean" || typeof filter.value === "number" || typeof filter.value === "string"
            ? filter.value
            : null
        }))
        .filter((filter) => propertyById.has(filter.propertyId));
      const sorts = (Array.isArray(item.sorts) ? item.sorts : [])
        .slice(0, databaseLimits.sortsPerView)
        .map(recordValue)
        .filter(Boolean)
        .map((sort, sortIndex) => ({
          id: safeId(sort.id, `${id}-sort-${sortIndex + 1}`),
          propertyId: safeId(sort.propertyId, ""),
          direction: sort.direction === "descending" ? "descending" : "ascending"
        }))
        .filter((sort) => propertyById.has(sort.propertyId));
      const groupProperty = propertyById.get(safeId(item.groupPropertyId, ""));
      return {
        id,
        name: stringValue(item.name, t(`database.${type}View`), databaseLimits.viewNameLength),
        type,
        filters,
        sorts,
        groupPropertyId: type === "board" && groupProperty && ["select", "checkbox"].includes(groupProperty.type)
          ? groupProperty.id
          : null,
        hiddenPropertyIds: Array.isArray(item.hiddenPropertyIds)
          ? [...new Set(item.hiddenPropertyIds.filter((id) => typeof id === "string"))]
            .filter((id) => propertyById.has(id) && propertyById.get(id).type !== "title")
          : []
      };
    });

  const normalizedViews = views.length ? views : fallback.views;
  const activeViewId = normalizedViews.some((view) => view.id === source.activeViewId)
    ? source.activeViewId
    : normalizedViews[0].id;

  return {
    title: stringValue(source.title, fallback.title, databaseLimits.titleLength),
    properties,
    rows,
    views: normalizedViews,
    activeViewId
  };
}

export function getDatabaseActiveView(database) {
  return database.views.find((view) => view.id === database.activeViewId) ?? database.views[0];
}

function getTitleProperty(database) {
  return database.properties.find((property) => property.type === "title") ?? database.properties[0];
}

function getOption(property, optionId) {
  return property.options.find((option) => option.id === optionId) ?? null;
}

function isEmptyValue(value) {
  return value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function searchableValue(property, value) {
  if (property.type === "select") return getOption(property, value)?.name ?? "";
  if (property.type === "multi_select") {
    return Array.isArray(value)
      ? value.map((id) => getOption(property, id)?.name ?? "").join(" ")
      : "";
  }
  if (property.type === "checkbox") return value === true ? "true checked" : "false unchecked";
  return value === null || value === undefined ? "" : String(value);
}

function rowMatchesFilter(dataRow, filter, propertyById) {
  const property = propertyById.get(filter.propertyId);
  if (!property) return true;
  const value = dataRow.values[property.id];
  if (filter.operator === "is_empty") return isEmptyValue(value);
  if (filter.operator === "is_not_empty") return !isEmptyValue(value);
  if (filter.operator === "checked") return value === true;
  if (filter.operator === "unchecked") return value !== true;
  if (property.type === "number") {
    const filterNumber = Number(filter.value);
    return Number.isFinite(filterNumber) && value === filterNumber;
  }
  if (property.type === "select") return value === filter.value;
  if (property.type === "multi_select") {
    const values = Array.isArray(value) ? value : [];
    return filter.operator === "equals"
      ? values.length === 1 && values[0] === filter.value
      : values.includes(String(filter.value ?? ""));
  }
  const left = searchableValue(property, value).toLocaleLowerCase();
  const right = String(filter.value ?? "").toLocaleLowerCase();
  return filter.operator === "equals" ? left === right : left.includes(right);
}

function compareValues(property, left, right) {
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

export function applyDatabaseView(database, view = getDatabaseActiveView(database)) {
  const propertyById = new Map(database.properties.map((property) => [property.id, property]));
  const rows = database.rows.filter((dataRow) => view.filters.every((filter) => rowMatchesFilter(dataRow, filter, propertyById)));
  if (!view.sorts.length) return rows;
  return rows.slice().sort((left, right) => {
    for (const sort of view.sorts) {
      const property = propertyById.get(sort.propertyId);
      if (!property) continue;
      const result = compareValues(property, left.values[property.id], right.values[property.id]);
      if (result) return sort.direction === "descending" ? -result : result;
    }
    return 0;
  });
}

function applyDatabaseSearch(database, rows, query) {
  const normalizedQuery = String(query ?? "").trim().toLocaleLowerCase();
  if (!normalizedQuery) return rows;
  return rows.filter((dataRow) => database.properties.some((property) =>
    searchableValue(property, dataRow.values[property.id]).toLocaleLowerCase().includes(normalizedQuery)
  ));
}

function makeButton(action, label, title, data = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  Object.entries(data).forEach(([key, value]) => {
    if (value !== null && value !== undefined) button.dataset[key] = String(value);
  });
  return button;
}

function makeSelect(options, value, className, ariaLabel) {
  const select = document.createElement("select");
  select.className = className;
  select.setAttribute("aria-label", ariaLabel);
  options.forEach(({ value: optionValue, label, disabled = false }) => {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    option.disabled = disabled;
    select.append(option);
  });
  select.value = value;
  return select;
}

function propertyTypeLabel(type) {
  return t(`database.propertyTypes.${type}`);
}

function viewTypeLabel(type) {
  return t(`database.viewTypes.${type}`);
}

function operatorLabel(operator) {
  return t(`database.operators.${operator}`);
}

function sortDirectionLabel(direction) {
  return t(`database.sortDirections.${direction}`);
}

function createValueEditor(dataRow, property, { compact = false, onDirty, onStructuralChange = null } = {}) {
  const value = dataRow.values[property.id];
  let control;

  if (property.type === "checkbox") {
    control = document.createElement("input");
    control.type = "checkbox";
    control.checked = value === true;
  } else if (property.type === "select") {
    control = makeSelect(
      [{ value: "", label: t("database.noValue") }, ...property.options.map((option) => ({ value: option.id, label: option.name }))],
      typeof value === "string" ? value : "",
      "database-value-select",
      property.name
    );
    control.classList.add("database-select-chip");
    control.dataset.optionColor = getOption(property, control.value)?.color ?? "gray";
  } else {
    control = document.createElement("input");
    control.type = property.type === "number" ? "number" : property.type === "date" ? "date" : "text";
    control.value = property.type === "multi_select"
      ? (Array.isArray(value) ? value.map((id) => getOption(property, id)?.name).filter(Boolean).join(", ") : "")
      : value === null || value === undefined ? "" : String(value);
    control.maxLength = property.type === "url" ? databaseLimits.urlLength : databaseLimits.textLength;
    if (property.type === "url") control.inputMode = "url";
    if (property.type === "number") control.inputMode = "decimal";
    control.placeholder = property.type === "multi_select" ? t("database.multiSelectPlaceholder") : "";
  }

  control.classList.add("database-value-input");
  if (compact) control.classList.add("is-compact");
  control.dataset.rowId = dataRow.id;
  control.dataset.propertyId = property.id;
  control.setAttribute("aria-label", t("database.valueAria", { property: property.name }));

  const updateEvent = property.type === "checkbox" || property.type === "select" || property.type === "date" ? "change" : "input";
  const update = () => {
    if (property.type === "checkbox") dataRow.values[property.id] = control.checked;
    else if (property.type === "number") dataRow.values[property.id] = control.value === "" ? null : Number(control.value);
    else if (property.type === "multi_select") {
      const names = control.value.split(",").map((item) => item.trim().toLocaleLowerCase()).filter(Boolean);
      dataRow.values[property.id] = property.options
        .filter((option) => names.includes(option.name.toLocaleLowerCase()))
        .map((option) => option.id);
    } else dataRow.values[property.id] = control.value;
    if (property.type === "select") control.dataset.optionColor = getOption(property, control.value)?.color ?? "gray";
    onDirty();
    if (onStructuralChange && updateEvent === "change") onStructuralChange();
  };

  control.addEventListener(updateEvent, update);
  if (onStructuralChange && updateEvent === "input") control.addEventListener("change", onStructuralChange);
  return control;
}

function createPropertyManager(editor, row, database, onDirty, replaceEditor) {
  const details = document.createElement("details");
  details.className = "database-properties-panel";

  const summary = document.createElement("summary");
  summary.textContent = t("database.properties");
  details.append(summary);

  const list = document.createElement("div");
  list.className = "database-property-list";

  database.properties.forEach((property) => {
    const item = document.createElement("div");
    item.className = "database-property-item";
    item.dataset.propertyId = property.id;

    const name = document.createElement("input");
    name.type = "text";
    name.className = "database-property-name";
    name.value = property.name;
    name.maxLength = databaseLimits.propertyNameLength;
    name.setAttribute("aria-label", t("database.propertyName"));
    name.addEventListener("input", () => {
      property.name = name.value.slice(0, databaseLimits.propertyNameLength);
      editor.querySelectorAll(`[data-property-label="${CSS.escape(property.id)}"]`).forEach((label) => {
        label.textContent = property.name;
      });
      onDirty();
    });

    const type = makeSelect(
      databasePropertyTypes.map((propertyType) => ({
        value: propertyType,
        label: propertyTypeLabel(propertyType),
        disabled: property.type === "title" ? propertyType !== "title" : propertyType === "title"
      })),
      property.type,
      "database-property-type",
      t("database.propertyType")
    );
    type.disabled = property.type === "title";
    type.addEventListener("change", () => {
      property.type = normalizePropertyType(type.value);
      if (!["select", "multi_select"].includes(property.type)) property.options = [];
      database.rows.forEach((dataRow) => {
        dataRow.values[property.id] = normalizePropertyValue(property, dataRow.values[property.id]);
      });
      replaceEditor({ openProperties: true, focusPropertyId: property.id });
    });

    item.append(name, type);

    if (["select", "multi_select"].includes(property.type)) {
      const options = document.createElement("input");
      options.type = "text";
      options.className = "database-property-options";
      options.value = property.options.map((option) => option.name).join(", ");
      options.placeholder = t("database.optionsPlaceholder");
      options.setAttribute("aria-label", t("database.options"));
      options.addEventListener("change", () => {
        const names = [...new Set(options.value.split(",").map((value) => value.trim()).filter(Boolean))]
          .slice(0, databaseLimits.optionsPerProperty);
        property.options = names.map((optionName, index) => {
          const existing = property.options.find((option) => option.name.toLocaleLowerCase() === optionName.toLocaleLowerCase());
          return existing ?? { id: createId("option"), name: optionName, color: databaseOptionColors[index % databaseOptionColors.length] };
        });
        database.rows.forEach((dataRow) => {
          dataRow.values[property.id] = normalizePropertyValue(property, dataRow.values[property.id]);
        });
        replaceEditor({ openProperties: true, focusPropertyId: property.id });
      });
      item.append(options);
    }

    const visibility = document.createElement("label");
    visibility.className = "database-property-visibility";
    const visible = document.createElement("input");
    visible.type = "checkbox";
    visible.checked = !getDatabaseActiveView(database).hiddenPropertyIds.includes(property.id);
    visible.disabled = property.type === "title";
    visible.addEventListener("change", () => {
      const view = getDatabaseActiveView(database);
      view.hiddenPropertyIds = visible.checked
        ? view.hiddenPropertyIds.filter((id) => id !== property.id)
        : [...new Set([...view.hiddenPropertyIds, property.id])];
      replaceEditor({ openProperties: true, focusPropertyId: property.id });
    });
    visibility.append(visible, document.createTextNode(t("database.visibleInView")));
    item.append(visibility);

    const remove = makeButton("database-delete-property", "×", t("database.deleteProperty"), { propertyId: property.id });
    remove.className = "database-property-delete";
    remove.disabled = property.type === "title" || database.properties.length <= 1;
    item.append(remove);
    list.append(item);
  });

  const add = makeButton("database-add-property", `＋ ${t("database.addProperty")}`, t("database.addProperty"));
  add.className = "database-add-property";
  add.disabled = database.properties.length >= databaseLimits.properties;
  list.append(add);
  details.append(list);
  return details;
}

function validOperatorsForProperty(property) {
  if (property.type === "checkbox") return ["checked", "unchecked"];
  if (["number", "select", "date"].includes(property.type)) return ["equals", "is_empty", "is_not_empty"];
  return ["contains", "equals", "is_empty", "is_not_empty"];
}

function createFilterValueControl(property, operator) {
  if (["is_empty", "is_not_empty", "checked", "unchecked"].includes(operator)) {
    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.value = "";
    return hidden;
  }
  if (property.type === "select" || property.type === "multi_select") {
    return makeSelect(
      property.options.map((option) => ({ value: option.id, label: option.name })),
      property.options[0]?.id ?? "",
      "database-filter-value",
      t("database.filterValue")
    );
  }
  const input = document.createElement("input");
  input.className = "database-filter-value";
  input.type = property.type === "number" ? "number" : property.type === "date" ? "date" : "text";
  input.placeholder = t("database.filterValue");
  input.setAttribute("aria-label", t("database.filterValue"));
  return input;
}

function createViewSettings(editor, row, database, onDirty, replaceEditor) {
  const view = getDatabaseActiveView(database);
  const panel = document.createElement("div");
  panel.className = "database-view-settings";

  const filters = document.createElement("details");
  filters.className = "database-rule-panel database-filter-panel";
  const filterSummary = document.createElement("summary");
  filterSummary.textContent = `${t("database.filter")}${view.filters.length ? ` ${formatNumber(view.filters.length)}` : ""}`;
  filters.append(filterSummary);

  const filterPopover = document.createElement("div");
  filterPopover.className = "database-toolbar-popover database-rule-popover";
  const filterBuilder = document.createElement("div");
  filterBuilder.className = "database-rule-builder";
  const filterProperty = makeSelect(
    database.properties.map((property) => ({ value: property.id, label: property.name })),
    database.properties[0]?.id ?? "",
    "database-filter-property",
    t("database.filterProperty")
  );
  let selectedFilterProperty = database.properties.find((property) => property.id === filterProperty.value) ?? database.properties[0];
  let filterOperator = makeSelect(
    validOperatorsForProperty(selectedFilterProperty).map((operator) => ({ value: operator, label: operatorLabel(operator) })),
    validOperatorsForProperty(selectedFilterProperty)[0],
    "database-filter-operator",
    t("database.filterOperator")
  );
  let filterValue = createFilterValueControl(selectedFilterProperty, filterOperator.value);

  const rebuildFilterValue = () => {
    const next = createFilterValueControl(selectedFilterProperty, filterOperator.value);
    filterValue.replaceWith(next);
    filterValue = next;
  };

  const rebuildFilterControls = () => {
    selectedFilterProperty = database.properties.find((property) => property.id === filterProperty.value) ?? database.properties[0];
    const operatorOptions = validOperatorsForProperty(selectedFilterProperty);
    const nextOperator = operatorOptions.includes(filterOperator.value) ? filterOperator.value : operatorOptions[0];
    const nextOperatorControl = makeSelect(
      operatorOptions.map((operator) => ({ value: operator, label: operatorLabel(operator) })),
      nextOperator,
      "database-filter-operator",
      t("database.filterOperator")
    );
    nextOperatorControl.addEventListener("change", rebuildFilterValue);
    filterOperator.replaceWith(nextOperatorControl);
    filterOperator = nextOperatorControl;
    rebuildFilterValue();
  };

  filterProperty.addEventListener("change", rebuildFilterControls);
  filterOperator.addEventListener("change", rebuildFilterValue);

  const addFilter = makeButton("database-add-filter", t("database.addFilter"), t("database.addFilter"));
  addFilter.addEventListener("click", () => {
    if (view.filters.length >= databaseLimits.filtersPerView) return;
    view.filters.push({
      id: createId("filter"),
      propertyId: selectedFilterProperty.id,
      operator: filterOperator.value,
      value: selectedFilterProperty.type === "number" && filterValue.value !== "" ? Number(filterValue.value) : filterValue.value
    });
    replaceEditor({ openFilters: true });
  });
  filterBuilder.append(filterProperty, filterOperator, filterValue, addFilter);
  filterPopover.append(filterBuilder);

  if (view.filters.length) {
    const chips = document.createElement("div");
    chips.className = "database-rule-chips";
    view.filters.forEach((filter) => {
      const property = database.properties.find((item) => item.id === filter.propertyId);
      const chip = makeButton(
        "database-remove-filter",
        `${property?.name ?? "?"} · ${operatorLabel(filter.operator)}${filter.value !== null && filter.value !== "" ? ` · ${property?.type === "select" || property?.type === "multi_select" ? getOption(property, filter.value)?.name ?? filter.value : filter.value}` : ""} ×`,
        t("database.removeFilter"),
        { filterId: filter.id }
      );
      chip.className = "database-rule-chip";
      chips.append(chip);
    });
    filterPopover.append(chips);
  }
  filters.append(filterPopover);
  panel.append(filters);

  const sorts = document.createElement("details");
  sorts.className = "database-rule-panel database-sort-panel";
  const sortSummary = document.createElement("summary");
  sortSummary.textContent = `${t("database.sort")}${view.sorts.length ? ` ${formatNumber(view.sorts.length)}` : ""}`;
  sorts.append(sortSummary);

  const sortPopover = document.createElement("div");
  sortPopover.className = "database-toolbar-popover database-rule-popover";
  const sortBuilder = document.createElement("div");
  sortBuilder.className = "database-rule-builder";
  const sortProperty = makeSelect(
    database.properties.map((property) => ({ value: property.id, label: property.name })),
    database.properties[0]?.id ?? "",
    "database-sort-property",
    t("database.sortProperty")
  );
  const sortDirection = makeSelect(
    ["ascending", "descending"].map((direction) => ({ value: direction, label: sortDirectionLabel(direction) })),
    "ascending",
    "database-sort-direction",
    t("database.sortDirection")
  );
  const addSort = makeButton("database-add-sort", t("database.addSort"), t("database.addSort"));
  addSort.addEventListener("click", () => {
    if (view.sorts.length >= databaseLimits.sortsPerView) return;
    view.sorts.push({ id: createId("sort"), propertyId: sortProperty.value, direction: sortDirection.value });
    replaceEditor({ openSorts: true });
  });
  sortBuilder.append(sortProperty, sortDirection, addSort);
  sortPopover.append(sortBuilder);

  if (view.sorts.length) {
    const chips = document.createElement("div");
    chips.className = "database-rule-chips";
    view.sorts.forEach((sort) => {
      const property = database.properties.find((item) => item.id === sort.propertyId);
      const chip = makeButton(
        "database-remove-sort",
        `${property?.name ?? "?"} · ${sortDirectionLabel(sort.direction)} ×`,
        t("database.removeSort"),
        { sortId: sort.id }
      );
      chip.className = "database-rule-chip";
      chips.append(chip);
    });
    sortPopover.append(chips);
  }
  sorts.append(sortPopover);
  panel.append(sorts);

  const viewOptions = document.createElement("details");
  viewOptions.className = "database-view-options-panel";
  const viewOptionsSummary = document.createElement("summary");
  viewOptionsSummary.textContent = "•••";
  viewOptionsSummary.title = t("database.viewOptions");
  viewOptionsSummary.setAttribute("aria-label", t("database.viewOptions"));
  viewOptions.append(viewOptionsSummary);

  const viewOptionsMenu = document.createElement("div");
  viewOptionsMenu.className = "database-toolbar-popover database-view-options-menu";

  const viewNameLabel = document.createElement("label");
  viewNameLabel.className = "database-settings-field";
  const viewNameCaption = document.createElement("span");
  viewNameCaption.textContent = t("database.viewName");
  const viewName = document.createElement("input");
  viewName.type = "text";
  viewName.className = "database-view-name";
  viewName.value = view.name;
  viewName.maxLength = databaseLimits.viewNameLength;
  viewName.setAttribute("aria-label", t("database.viewName"));
  viewName.addEventListener("input", () => {
    view.name = viewName.value.slice(0, databaseLimits.viewNameLength);
    const tabLabel = editor.querySelector(`[data-view-tab="${CSS.escape(view.id)}"] .database-view-tab-label`);
    if (tabLabel) tabLabel.textContent = view.name;
    onDirty();
  });
  viewNameLabel.append(viewNameCaption, viewName);

  const viewTypeLabelElement = document.createElement("label");
  viewTypeLabelElement.className = "database-settings-field";
  const viewTypeCaption = document.createElement("span");
  viewTypeCaption.textContent = t("database.viewType");
  const viewType = makeSelect(
    databaseViewTypes.map((type) => ({ value: type, label: viewTypeLabel(type) })),
    view.type,
    "database-view-type",
    t("database.viewType")
  );
  viewType.addEventListener("change", () => {
    view.type = normalizeViewType(viewType.value);
    if (view.type === "board") {
      const groupProperty = database.properties.find((property) => ["select", "checkbox"].includes(property.type));
      view.groupPropertyId = groupProperty?.id ?? null;
    }
    replaceEditor({ openViewOptions: true, focusViewName: true });
  });
  viewTypeLabelElement.append(viewTypeCaption, viewType);
  viewOptionsMenu.append(viewNameLabel, viewTypeLabelElement);

  if (view.type === "board") {
    const groupProperties = database.properties.filter((property) => ["select", "checkbox"].includes(property.type));
    const groupLabel = document.createElement("label");
    groupLabel.className = "database-settings-field";
    const groupCaption = document.createElement("span");
    groupCaption.textContent = t("database.groupBy");
    const groupBy = makeSelect(
      [{ value: "", label: t("database.noGrouping") }, ...groupProperties.map((property) => ({ value: property.id, label: property.name }))],
      view.groupPropertyId ?? "",
      "database-group-property",
      t("database.groupBy")
    );
    groupBy.addEventListener("change", () => {
      view.groupPropertyId = groupBy.value || null;
      replaceEditor({ openViewOptions: true });
    });
    groupLabel.append(groupCaption, groupBy);
    viewOptionsMenu.append(groupLabel);
  }

  const removeView = makeButton("database-delete-view", t("database.deleteView"), t("database.deleteView"));
  removeView.className = "database-delete-view";
  removeView.disabled = database.views.length <= 1;
  viewOptionsMenu.append(removeView);
  viewOptions.append(viewOptionsMenu);
  panel.append(viewOptions);

  return panel;
}

function createTableView(row, database, view, rows, onDirty, replaceEditor) {
  const viewSensitivePropertyIds = new Set([...view.filters, ...view.sorts].map((rule) => rule.propertyId));
  const visibleProperties = database.properties.filter((property) => !view.hiddenPropertyIds.includes(property.id));
  const scroller = document.createElement("div");
  scroller.className = "database-table-scroll";
  const table = document.createElement("table");
  table.className = "database-table";
  table.setAttribute("aria-label", t("database.tableAria"));

  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  visibleProperties.forEach((property) => {
    const th = document.createElement("th");
    th.dataset.propertyLabel = property.id;
    th.dataset.propertyType = property.type;
    th.textContent = property.name;
    header.append(th);
  });
  thead.append(header);

  const tbody = document.createElement("tbody");
  rows.forEach((dataRow) => {
    const tr = document.createElement("tr");
    tr.dataset.databaseRowId = dataRow.id;
    visibleProperties.forEach((property) => {
      const td = document.createElement("td");
      td.dataset.propertyType = property.type;
      const valueEditor = createValueEditor(dataRow, property, {
        onDirty,
        onStructuralChange: viewSensitivePropertyIds.has(property.id) ? () => replaceEditor() : null
      });
      if (property.type === "title") {
        const titleCell = document.createElement("div");
        titleCell.className = "database-title-cell";
        const pageIcon = document.createElement("span");
        pageIcon.className = "database-title-cell-icon";
        pageIcon.textContent = "▤";
        pageIcon.setAttribute("aria-hidden", "true");
        valueEditor.classList.add("database-title-value");
        titleCell.append(pageIcon, valueEditor);
        td.append(titleCell);
      } else {
        td.append(valueEditor);
      }
      tr.append(td);
    });
    const remove = makeButton("database-delete-row", "×", t("database.deleteRow"), { rowId: dataRow.id });
    remove.className = "database-delete-row database-table-delete-row";
    tr.lastElementChild?.append(remove);
    tbody.append(tr);
  });

  table.append(thead, tbody);
  scroller.append(table);
  return scroller;
}

function createListView(row, database, view, rows, onDirty, replaceEditor) {
  const viewSensitivePropertyIds = new Set([...view.filters, ...view.sorts].map((rule) => rule.propertyId));
  const titleProperty = getTitleProperty(database);
  const visibleProperties = database.properties.filter(
    (property) => property.id !== titleProperty.id && !view.hiddenPropertyIds.includes(property.id)
  );
  const list = document.createElement("div");
  list.className = "database-list-view";
  rows.forEach((dataRow) => {
    const item = document.createElement("article");
    item.className = "database-list-row";
    item.dataset.databaseRowId = dataRow.id;
    const title = createValueEditor(dataRow, titleProperty, {
      onDirty,
      onStructuralChange: viewSensitivePropertyIds.has(titleProperty.id) ? () => replaceEditor() : null
    });
    title.classList.add("database-list-title");
    const properties = document.createElement("div");
    properties.className = "database-list-properties";
    visibleProperties.forEach((property) => {
      const field = document.createElement("label");
      field.className = "database-list-field";
      const label = document.createElement("span");
      label.dataset.propertyLabel = property.id;
      label.textContent = property.name;
      field.append(label, createValueEditor(dataRow, property, {
        compact: true,
        onDirty,
        onStructuralChange: viewSensitivePropertyIds.has(property.id) ? () => replaceEditor() : null
      }));
      properties.append(field);
    });
    const remove = makeButton("database-delete-row", "×", t("database.deleteRow"), { rowId: dataRow.id });
    remove.className = "database-delete-row";
    item.append(title, properties, remove);
    list.append(item);
  });
  return list;
}

function createBoardView(row, database, view, rows, onDirty, replaceEditor) {
  const viewSensitivePropertyIds = new Set([...view.filters, ...view.sorts].map((rule) => rule.propertyId));
  const titleProperty = getTitleProperty(database);
  const groupProperty = database.properties.find((property) => property.id === view.groupPropertyId) ?? null;
  const visibleProperties = database.properties.filter(
    (property) => property.id !== titleProperty.id && property.id !== groupProperty?.id && !view.hiddenPropertyIds.includes(property.id)
  );
  const groups = [];
  if (groupProperty?.type === "select") {
    groupProperty.options.forEach((option) => groups.push({ id: option.id, name: option.name, color: option.color, rows: [] }));
    groups.push({ id: "", name: t("database.noValue"), color: "gray", rows: [] });
  } else if (groupProperty?.type === "checkbox") {
    groups.push(
      { id: "false", name: t("database.unchecked"), color: "gray", rows: [] },
      { id: "true", name: t("database.checked"), color: "green", rows: [] }
    );
  } else {
    groups.push({ id: "all", name: t("database.allRows"), color: "gray", rows: [] });
  }

  rows.forEach((dataRow) => {
    const value = groupProperty ? dataRow.values[groupProperty.id] : "all";
    const groupId = groupProperty?.type === "checkbox" ? String(value === true) : String(value ?? "");
    (groups.find((group) => group.id === groupId) ?? groups[groups.length - 1]).rows.push(dataRow);
  });

  const scroller = document.createElement("div");
  scroller.className = "database-board-scroll";
  const board = document.createElement("div");
  board.className = "database-board";
  board.setAttribute("aria-label", t("database.boardAria"));

  groups.forEach((group) => {
    const column = document.createElement("section");
    column.className = "database-board-column";
    column.dataset.optionColor = group.color;
    const heading = document.createElement("header");
    const name = document.createElement("strong");
    name.textContent = group.name;
    const count = document.createElement("span");
    count.textContent = formatNumber(group.rows.length);
    heading.append(name, count);

    const cards = document.createElement("div");
    cards.className = "database-board-cards";
    group.rows.forEach((dataRow) => {
      const card = document.createElement("article");
      card.className = "database-board-card";
      card.dataset.databaseRowId = dataRow.id;
      const title = createValueEditor(dataRow, titleProperty, {
        onDirty,
        onStructuralChange: viewSensitivePropertyIds.has(titleProperty.id) ? () => replaceEditor() : null
      });
      title.classList.add("database-board-card-title");
      card.append(title);

      if (groupProperty) {
        const groupField = document.createElement("label");
        groupField.className = "database-board-group-field";
        const groupLabel = document.createElement("span");
        groupLabel.textContent = groupProperty.name;
        const groupEditor = createValueEditor(dataRow, groupProperty, {
          compact: true,
          onDirty,
          onStructuralChange: () => replaceEditor({ focusRowId: dataRow.id })
        });
        groupField.append(groupLabel, groupEditor);
        card.append(groupField);
      }

      visibleProperties.forEach((property) => {
        const field = document.createElement("label");
        field.className = "database-board-card-field";
        const label = document.createElement("span");
        label.dataset.propertyLabel = property.id;
        label.textContent = property.name;
        field.append(label, createValueEditor(dataRow, property, {
          compact: true,
          onDirty,
          onStructuralChange: viewSensitivePropertyIds.has(property.id) ? () => replaceEditor() : null
        }));
        card.append(field);
      });
      const remove = makeButton("database-delete-row", "×", t("database.deleteRow"), { rowId: dataRow.id });
      remove.className = "database-delete-row";
      card.append(remove);
      cards.append(card);
    });

    const add = makeButton("database-add-row", `＋ ${t("database.newRow")}`, t("database.newRow"), {
      groupPropertyId: groupProperty?.id ?? "",
      groupValue: group.id
    });
    add.className = "database-board-add-row";
    add.disabled = database.rows.length >= databaseLimits.rows;
    column.append(heading, cards, add);
    board.append(column);
  });

  scroller.append(board);
  return scroller;
}

export function createDatabaseEditor(row, value, { onDirty = () => {} } = {}) {
  const database = normalizeDatabaseData(value);
  const editor = document.createElement("div");
  editor.className = "database-block-editor";
  editor.databaseData = database;

  const replaceEditor = (focus = {}) => {
    const host = row.querySelector(".block-editor-host");
    if (!host) return;
    const next = createDatabaseEditor(row, database, { onDirty });
    host.replaceChildren(next);
    onDirty();
    requestAnimationFrame(() => {
      if (focus.openProperties) next.querySelector(".database-properties-panel")?.setAttribute("open", "");
      if (focus.openFilters) next.querySelector(".database-filter-panel")?.setAttribute("open", "");
      if (focus.openSorts) next.querySelector(".database-sort-panel")?.setAttribute("open", "");
      if (focus.openViewOptions) next.querySelector(".database-view-options-panel")?.setAttribute("open", "");
      if (focus.focusPropertyId) next.querySelector(`.database-property-item[data-property-id="${CSS.escape(focus.focusPropertyId)}"] .database-property-name`)?.focus();
      else if (focus.focusViewName) next.querySelector(".database-view-name")?.focus();
      else if (focus.focusRowId) next.querySelector(`[data-database-row-id="${CSS.escape(focus.focusRowId)}"] .database-value-input`)?.focus();
    });
  };

  const heading = document.createElement("div");
  heading.className = "database-heading";
  const title = document.createElement("input");
  title.type = "text";
  title.className = "database-title-input";
  title.value = database.title;
  title.maxLength = databaseLimits.titleLength;
  title.placeholder = t("database.titlePlaceholder");
  title.setAttribute("aria-label", t("database.titleAria"));
  title.addEventListener("input", () => {
    database.title = title.value.slice(0, databaseLimits.titleLength);
    onDirty();
  });
  const count = document.createElement("span");
  count.className = "database-count";
  count.textContent = t("database.rowCount", { count: formatNumber(database.rows.length) });
  heading.append(title, count);

  const toolbar = document.createElement("div");
  toolbar.className = "database-toolbar";

  const viewBar = document.createElement("div");
  viewBar.className = "database-view-bar";
  database.views.forEach((view) => {
    const tab = makeButton("database-select-view", "", t("database.selectView", { view: view.name }), { viewId: view.id });
    tab.className = "database-view-tab";
    tab.dataset.viewTab = view.id;
    tab.dataset.viewType = view.type;
    tab.setAttribute("aria-pressed", String(view.id === database.activeViewId));
    const icon = document.createElement("span");
    icon.className = "database-view-tab-icon";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "database-view-tab-label";
    label.textContent = view.name;
    tab.append(icon, label);
    viewBar.append(tab);
  });

  const addView = makeSelect(
    [
      { value: "", label: "+" },
      ...databaseViewTypes.map((type) => ({ value: type, label: viewTypeLabel(type) }))
    ],
    "",
    "database-add-view-select",
    t("database.addView")
  );
  addView.title = t("database.addView");
  addView.disabled = database.views.length >= databaseLimits.views;
  addView.addEventListener("change", () => {
    if (!addView.value) return;
    const type = normalizeViewType(addView.value);
    const groupProperty = database.properties.find((property) => ["select", "checkbox"].includes(property.type));
    const view = {
      id: createId("view"),
      name: viewTypeLabel(type),
      type,
      filters: [],
      sorts: [],
      groupPropertyId: type === "board" ? groupProperty?.id ?? null : null,
      hiddenPropertyIds: []
    };
    database.views.push(view);
    database.activeViewId = view.id;
    replaceEditor({ openViewOptions: true, focusViewName: true });
  });
  viewBar.append(addView);

  const activeView = getDatabaseActiveView(database);
  const viewRows = applyDatabaseView(database, activeView);
  const settings = createViewSettings(editor, row, database, onDirty, replaceEditor);
  const properties = createPropertyManager(editor, row, database, onDirty, replaceEditor);
  settings.prepend(properties);

  const searchPanel = document.createElement("details");
  searchPanel.className = "database-search-panel";
  const searchSummary = document.createElement("summary");
  searchSummary.textContent = `⌕ ${t("database.search")}`;
  searchSummary.setAttribute("aria-label", t("database.search"));
  const searchPopover = document.createElement("div");
  searchPopover.className = "database-toolbar-popover database-search-popover";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "database-search-input";
  searchInput.placeholder = t("database.searchPlaceholder");
  searchInput.setAttribute("aria-label", t("database.search"));
  searchPopover.append(searchInput);
  searchPanel.append(searchSummary, searchPopover);
  settings.append(searchPanel);

  const newButtonGroup = document.createElement("div");
  newButtonGroup.className = "database-new-button-group";
  const newRowButton = makeButton("database-add-row", t("database.newItem"), t("database.newRow"));
  newRowButton.className = "database-new-row-button";
  newRowButton.disabled = database.rows.length >= databaseLimits.rows;
  const newMenu = document.createElement("details");
  newMenu.className = "database-new-menu";
  const newMenuSummary = document.createElement("summary");
  newMenuSummary.textContent = "⌄";
  newMenuSummary.setAttribute("aria-label", t("database.newOptions"));
  const newMenuPopover = document.createElement("div");
  newMenuPopover.className = "database-toolbar-popover database-new-menu-popover";
  const newMenuRowButton = makeButton("database-add-row", `＋ ${t("database.newRow")}`, t("database.newRow"));
  newMenuPopover.append(newMenuRowButton);
  newMenu.append(newMenuSummary, newMenuPopover);
  newButtonGroup.append(newRowButton, newMenu);
  settings.append(newButtonGroup);

  toolbar.append(viewBar, settings);

  const renderViewContent = (query = "") => {
    const visibleRows = applyDatabaseSearch(database, viewRows, query);
    const content = activeView.type === "board"
      ? createBoardView(row, database, activeView, visibleRows, onDirty, replaceEditor)
      : activeView.type === "list"
        ? createListView(row, database, activeView, visibleRows, onDirty, replaceEditor)
        : createTableView(row, database, activeView, visibleRows, onDirty, replaceEditor);
    content.dataset.databaseContent = "true";
    return { content, visibleRows };
  };

  let { content, visibleRows } = renderViewContent();

  const footer = document.createElement("div");
  footer.className = "database-footer";
  const addRow = makeButton("database-add-row", `＋ ${t("database.newRow")}`, t("database.newRow"));
  addRow.disabled = database.rows.length >= databaseLimits.rows;
  const filtered = document.createElement("span");
  filtered.className = "database-filtered-count";
  const updateFilteredCount = () => {
    const isFiltered = visibleRows.length !== database.rows.length;
    filtered.hidden = !isFiltered;
    filtered.textContent = isFiltered
      ? t("database.filteredCount", {
          visible: formatNumber(visibleRows.length),
          total: formatNumber(database.rows.length)
        })
      : "";
  };
  footer.append(addRow, filtered);
  updateFilteredCount();

  searchInput.addEventListener("input", () => {
    const next = renderViewContent(searchInput.value);
    content.replaceWith(next.content);
    content = next.content;
    visibleRows = next.visibleRows;
    updateFilteredCount();
  });
  searchPanel.addEventListener("toggle", () => {
    if (searchPanel.open) requestAnimationFrame(() => searchInput.focus());
  });

  editor.append(heading, toolbar, content, footer);

  editor.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || !editor.contains(button)) return;
    const action = button.dataset.action;

    if (action === "database-select-view") {
      database.activeViewId = button.dataset.viewId;
      replaceEditor();
    } else if (action === "database-add-property") {
      if (database.properties.length >= databaseLimits.properties) return;
      const property = { id: createId("property"), name: t("database.newProperty"), type: "text", options: [] };
      database.properties.push(property);
      database.rows.forEach((dataRow) => { dataRow.values[property.id] = ""; });
      replaceEditor({ openProperties: true, focusPropertyId: property.id });
    } else if (action === "database-delete-property") {
      const property = database.properties.find((item) => item.id === button.dataset.propertyId);
      if (!property || property.type === "title" || !window.confirm(t("database.confirmDeleteProperty", { property: property.name }))) return;
      database.properties = database.properties.filter((item) => item.id !== property.id);
      database.rows.forEach((dataRow) => { delete dataRow.values[property.id]; });
      database.views.forEach((view) => {
        view.filters = view.filters.filter((filter) => filter.propertyId !== property.id);
        view.sorts = view.sorts.filter((sort) => sort.propertyId !== property.id);
        view.hiddenPropertyIds = view.hiddenPropertyIds.filter((id) => id !== property.id);
        if (view.groupPropertyId === property.id) view.groupPropertyId = null;
      });
      replaceEditor({ openProperties: true });
    } else if (action === "database-add-row") {
      if (database.rows.length >= databaseLimits.rows) return;
      const values = {};
      database.properties.forEach((property) => {
        values[property.id] = property.type === "checkbox" ? false : property.type === "number" ? null : property.type === "multi_select" ? [] : "";
      });
      const groupProperty = database.properties.find((property) => property.id === button.dataset.groupPropertyId);
      if (groupProperty?.type === "select") values[groupProperty.id] = button.dataset.groupValue ?? "";
      if (groupProperty?.type === "checkbox") values[groupProperty.id] = button.dataset.groupValue === "true";
      const dataRow = { id: createId("row"), values };
      database.rows.push(dataRow);
      replaceEditor({ focusRowId: dataRow.id });
    } else if (action === "database-delete-row") {
      if (!window.confirm(t("database.confirmDeleteRow"))) return;
      database.rows = database.rows.filter((dataRow) => dataRow.id !== button.dataset.rowId);
      replaceEditor();
    } else if (action === "database-remove-filter") {
      activeView.filters = activeView.filters.filter((filter) => filter.id !== button.dataset.filterId);
      replaceEditor({ openFilters: true });
    } else if (action === "database-remove-sort") {
      activeView.sorts = activeView.sorts.filter((sort) => sort.id !== button.dataset.sortId);
      replaceEditor({ openSorts: true });
    } else if (action === "database-delete-view") {
      if (database.views.length <= 1 || !window.confirm(t("database.confirmDeleteView", { view: activeView.name }))) return;
      const index = database.views.findIndex((view) => view.id === activeView.id);
      database.views.splice(index, 1);
      database.activeViewId = database.views[Math.max(0, index - 1)]?.id ?? database.views[0].id;
      replaceEditor();
    }
  });

  return editor;
}

export function extractDatabaseData(row) {
  return normalizeDatabaseData(row?.querySelector(".database-block-editor")?.databaseData);
}

export function summarizeDatabaseData(databaseValue) {
  const database = normalizeDatabaseData(databaseValue);
  const lines = [database.title, ...database.properties.map((property) => property.name)];
  database.rows.forEach((dataRow) => {
    database.properties.forEach((property) => {
      const value = searchableValue(property, dataRow.values[property.id]);
      if (value) lines.push(value);
    });
  });
  return lines.join("\n").slice(0, 20000);
}
