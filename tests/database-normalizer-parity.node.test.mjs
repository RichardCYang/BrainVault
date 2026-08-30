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
