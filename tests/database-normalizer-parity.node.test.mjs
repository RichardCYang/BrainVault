import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDatabaseData } from "../public/database-block.js";
import { databaseLimits, getDatabaseData } from "../src/lib/database.ts";

function assertReferencesAreLocal(database) {
  const properties = new Map(database.properties.map((property) => [property.id, property]));
  for (const view of database.views) {
    assert.ok(!view.groupPropertyId || properties.has(view.groupPropertyId));
    assert.ok(view.hiddenPropertyIds.every((propertyId) => properties.has(propertyId)));
  }
}

function normalizedPair(database) {
  return {
    browser: normalizeDatabaseData(database),
    server: getDatabaseData({ database })
  };
}

test("database fallback views never reference properties absent from a legacy model", () => {
  const source = {
    title: "Legacy database",
    properties: [
      { id: "title", name: "Name", type: "title", options: [] },
      { id: "notes", name: "Notes", type: "text", options: [] }
    ],
    rows: [{ id: "row-1", values: { title: "Keep me", notes: "Preserved" } }],
    views: [],
    activeViewId: "missing-view"
  };

  const pair = normalizedPair(source);
  for (const database of Object.values(pair)) {
    assertReferencesAreLocal(database);
    assert.equal(database.rows[0].values.title, "Keep me");
    assert.equal(database.rows[0].values.notes, "Preserved");
    const board = database.views.find((view) => view.type === "board");
    assert.ok(board);
    assert.equal(board.groupPropertyId, null);
    assert.deepEqual(board.hiddenPropertyIds, []);
  }
});

test("database rule normalization makes duplicate IDs independently removable", () => {
  const source = {
    title: "Rules",
    properties: [
      { id: "title", name: "Name", type: "title", options: [] },
      { id: "notes", name: "Notes", type: "text", options: [] }
    ],
    rows: [],
    views: [{
      id: "view-1",
      name: "Table",
      type: "table",
      filters: [
        { id: "duplicate", propertyId: "notes", operator: "contains", value: "first" },
        { id: "duplicate", propertyId: "notes", operator: "contains", value: "second" }
      ],
      sorts: [
        { id: "duplicate", propertyId: "notes", direction: "ascending" },
        { id: "duplicate", propertyId: "notes", direction: "descending" }
      ],
      groupPropertyId: null,
      hiddenPropertyIds: []
    }],
    activeViewId: "view-1"
  };

  const pair = normalizedPair(source);
  for (const database of Object.values(pair)) {
    const view = database.views[0];
    assert.equal(view.filters.length, 2);
    assert.equal(new Set(view.filters.map((filter) => filter.id)).size, 2);
    assert.equal(view.filters.filter((filter) => filter.id !== view.filters[0].id).length, 1);
    assert.deepEqual(view.filters.map((filter) => filter.value), ["first", "second"]);

    assert.equal(view.sorts.length, 2);
    assert.equal(new Set(view.sorts.map((sort) => sort.id)).size, 2);
    assert.equal(view.sorts.filter((sort) => sort.id !== view.sorts[0].id).length, 1);
    assert.deepEqual(view.sorts.map((sort) => sort.direction), ["ascending", "descending"]);
  }
});

test("database generated IDs and filter values stay inside canonical limits", () => {
  const propertyId = "p".repeat(databaseLimits.idLength);
  const viewId = "v".repeat(databaseLimits.idLength);
  const source = {
    title: "Boundary values",
    properties: [
      { id: "title", name: "Name", type: "title", options: [] },
      {
        id: propertyId,
        name: "Status",
        type: "select",
        options: [
          { name: "First", color: "gray" },
          { name: "Second", color: "blue" }
        ]
      }
    ],
    rows: [],
    views: [{
      id: viewId,
      name: "Table",
      type: "table",
      filters: [
        { propertyId: "title", operator: "contains", value: "x".repeat(databaseLimits.textLength + 1) },
        { propertyId: "title", operator: "contains", value: Number.POSITIVE_INFINITY }
      ],
      sorts: [
        { propertyId: "title", direction: "ascending" },
        { propertyId: "title", direction: "descending" }
      ],
      groupPropertyId: null,
      hiddenPropertyIds: []
    }],
    activeViewId: viewId
  };

  const pair = normalizedPair(source);
  for (const database of Object.values(pair)) {
    const optionIds = database.properties.find((property) => property.id === propertyId).options.map((option) => option.id);
    const view = database.views[0];
    const generatedIds = [...optionIds, ...view.filters.map((filter) => filter.id), ...view.sorts.map((sort) => sort.id)];

    assert.ok(generatedIds.every((id) => id.length > 0 && id.length <= databaseLimits.idLength));
    assert.equal(new Set(optionIds).size, optionIds.length);
    assert.equal(new Set(view.filters.map((filter) => filter.id)).size, view.filters.length);
    assert.equal(new Set(view.sorts.map((sort) => sort.id)).size, view.sorts.length);
    assert.equal(view.filters[0].value.length, databaseLimits.textLength);
    assert.equal(view.filters[1].value, null);
  }
});

test("database identifier repair preserves values, option references, and view state", () => {
  const longPropertyId = "long-property-" + "p".repeat(databaseLimits.idLength);
  const longOptionId = "long-option-" + "o".repeat(databaseLimits.idLength);
  const canonicalLongPropertyId = longPropertyId.trim().slice(0, databaseLimits.idLength);
  const canonicalLongOptionId = longOptionId.trim().slice(0, databaseLimits.idLength);
  const source = {
    title: "Repairable database",
    properties: [
      { id: " title ", name: "Name", type: "title", options: [] },
      {
        id: " status ",
        name: "Status",
        type: "select",
        options: [
          { id: " open ", name: "Open", color: "blue" },
          { id: longOptionId, name: "Long option", color: "green" }
        ]
      },
      { id: longPropertyId, name: "Long property", type: "text", options: [] }
    ],
    rows: [{
      id: " row-1 ",
      values: {
        " title ": "KEEP TITLE",
        " status ": " open ",
        [longPropertyId]: "KEEP LONG VALUE"
      }
    }],
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
        id: " board-view ",
        name: "Board",
        type: "board",
        filters: [
          { id: " filter-1 ", propertyId: " status ", operator: "equals", value: " open " },
          { id: "filter-2", propertyId: " status ", operator: "equals", value: longOptionId }
        ],
        sorts: [{ id: " sort-1 ", propertyId: longPropertyId, direction: "descending" }],
        groupPropertyId: " status ",
        hiddenPropertyIds: [" status ", longPropertyId]
      }
    ],
    activeViewId: " board-view "
  };

  const pair = normalizedPair(source);
  assert.deepEqual(pair.browser, pair.server);
  for (const database of Object.values(pair)) {
    const status = database.properties.find((property) => property.id === "status");
    assert.ok(status);
    assert.deepEqual(status.options.map((option) => option.id), ["open", canonicalLongOptionId]);
    assert.equal(database.rows[0].values.title, "KEEP TITLE");
    assert.equal(database.rows[0].values.status, "open");
    assert.equal(database.rows[0].values[canonicalLongPropertyId], "KEEP LONG VALUE");

    const board = database.views.find((view) => view.id === "board-view");
    assert.ok(board);
    assert.equal(database.activeViewId, "board-view");
    assert.deepEqual(board.filters.map((filter) => filter.propertyId), ["status", "status"]);
    assert.deepEqual(board.filters.map((filter) => filter.value), ["open", canonicalLongOptionId]);
    assert.equal(board.sorts[0].propertyId, canonicalLongPropertyId);
    assert.equal(board.groupPropertyId, "status");
    assert.deepEqual(board.hiddenPropertyIds, ["status", canonicalLongPropertyId]);
  }
});

test("missing database IDs normalize deterministically and identically in browser and server", () => {
  const source = {
    title: "Deterministic repair",
    properties: [
      { name: "Name", type: "title", options: [] },
      {
        name: "Status",
        type: "select",
        options: [{ name: "Open", color: "blue" }]
      }
    ],
    rows: [{
      values: {
        "property-1": "KEEP GENERATED TITLE",
        "property-2": "property-2-option-1"
      }
    }],
    views: [{
      name: "Board",
      type: "board",
      filters: [{ propertyId: "property-2", operator: "equals", value: "property-2-option-1" }],
      sorts: [{ propertyId: "property-1", direction: "ascending" }],
      groupPropertyId: "property-2",
      hiddenPropertyIds: ["property-2"]
    }],
    activeViewId: "view-1"
  };

  const firstBrowser = normalizeDatabaseData(source);
  const secondBrowser = normalizeDatabaseData(source);
  const server = getDatabaseData({ database: source });
  assert.deepEqual(firstBrowser, secondBrowser);
  assert.deepEqual(firstBrowser, server);
  assert.deepEqual(firstBrowser.properties.map((property) => property.id), ["property-1", "property-2"]);
  assert.equal(firstBrowser.properties[1].options[0].id, "property-2-option-1");
  assert.equal(firstBrowser.rows[0].id, "row-1");
  assert.equal(firstBrowser.rows[0].values["property-1"], "KEEP GENERATED TITLE");
  assert.equal(firstBrowser.rows[0].values["property-2"], "property-2-option-1");
  assert.equal(firstBrowser.views[0].id, "view-1");
  assert.equal(firstBrowser.activeViewId, "view-1");
});

test("browser fallback view identifiers remain stable during legacy repair", () => {
  const source = {
    title: "No views",
    properties: [{ id: "title", name: "Name", type: "title", options: [] }],
    rows: [{ id: "row-1", values: { title: "Keep me" } }],
    views: [],
    activeViewId: " table-view "
  };

  const first = normalizeDatabaseData(source);
  const second = normalizeDatabaseData(source);
  assert.deepEqual(first, second);
  assert.deepEqual(first.views.map((view) => view.id), ["table-view", "board-view"]);
  assert.equal(first.activeViewId, "table-view");
  assert.equal(first.rows[0].values.title, "Keep me");
});

test("reserved object-key IDs are repaired without prototype mutation or data loss", () => {
  const sourceValues = JSON.parse('{"title":"Row","__proto__":["constructor"]}');
  const source = {
    title: "Reserved identifiers",
    properties: [
      { id: "title", name: "Name", type: "title", options: [] },
      {
        id: "__proto__",
        name: "Tags",
        type: "multi_select",
        options: [{ id: "constructor", name: "Keep", color: "blue" }]
      }
    ],
    rows: [{ id: "row-1", values: sourceValues }],
    views: [{
      id: "prototype",
      name: "Table",
      type: "table",
      filters: [{ propertyId: "__proto__", operator: "equals", value: "constructor" }],
      sorts: [{ propertyId: "__proto__", direction: "ascending" }],
      groupPropertyId: null,
      hiddenPropertyIds: ["__proto__"]
    }],
    activeViewId: "prototype"
  };

  const pair = normalizedPair(source);
  assert.deepEqual(pair.browser, pair.server);
  for (const database of Object.values(pair)) {
    assert.deepEqual(database.properties.map((property) => property.id), ["title", "property-2"]);
    assert.equal(database.properties[1].options[0].id, "property-2-option-1");
    assert.deepEqual(database.rows[0].values["property-2"], ["property-2-option-1"]);
    assert.equal(Object.getPrototypeOf(database.rows[0].values), Object.prototype);
    assert.equal(database.views[0].id, "view-1");
    assert.equal(database.views[0].filters[0].propertyId, "property-2");
    assert.equal(database.views[0].filters[0].value, "property-2-option-1");
    assert.equal(database.views[0].sorts[0].propertyId, "property-2");
    assert.deepEqual(database.views[0].hiddenPropertyIds, ["property-2"]);
    assert.equal(database.activeViewId, "view-1");
  }
});
