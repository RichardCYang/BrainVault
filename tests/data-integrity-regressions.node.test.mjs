import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  parseDatabaseOptionNames,
  reconcileDatabaseOptions
} from "../public/database-block.js";

function createDatabaseFixture() {
  const property = {
    id: "status",
    type: "select",
    options: [
      { id: "not-started", name: "Not started", color: "gray" },
      { id: "in-progress", name: "In progress", color: "blue" },
      { id: "done", name: "Done", color: "green" }
    ]
  };
  const database = {
    rows: [
      { values: { status: "in-progress" } },
      { values: { status: "done" } }
    ],
    views: [{ filters: [{ propertyId: "status", value: "in-progress" }] }]
  };
  return { database, property };
}

test("database option rename preserves stable IDs and existing references", () => {
  const { database, property } = createDatabaseFixture();
  const options = reconcileDatabaseOptions(
    database,
    property,
    parseDatabaseOptionNames("Not started, Doing, Done")
  );

  assert.equal(options[1].id, "in-progress");
  assert.equal(options[1].name, "Doing");
  assert.equal(database.rows[0].values.status, "in-progress");
  assert.equal(database.views[0].filters[0].value, "in-progress");
});

test("database option editor rejects overflow instead of truncating", () => {
  const tooMany = Array.from({ length: 31 }, (_, index) => `Option-${index + 1}`).join(",");
  assert.throws(
    () => parseDatabaseOptionNames(tooMany),
    (error) => error?.code === "too-many-options"
  );
  assert.throws(
    () => parseDatabaseOptionNames("x".repeat(81)),
    (error) => error?.code === "option-name-too-long"
  );
});

test("database option editor refuses to remove referenced option IDs", () => {
  const { database, property } = createDatabaseFixture();
  assert.throws(
    () => reconcileDatabaseOptions(
      database,
      property,
      parseDatabaseOptionNames("Not started, Done")
    ),
    (error) => error?.code === "referenced-option-removal"
  );
});

test("kanban tag normalization keeps over-limit input intact for fail-closed validation", async () => {
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function normalizeKanbanTags(value)");
  const end = source.indexOf("\nfunction normalizeKanbanIcon(value)", start);
  assert.ok(start >= 0 && end > start);

  const context = {
    kanbanLimits: { tagsPerCard: 8, tagLength: 40 },
    t: (key, params = {}) => `${key}:${params.count ?? ""}`
  };
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\nthis.normalizeKanbanTags = normalizeKanbanTags; this.validateKanbanTags = validateKanbanTags;`,
    context
  );

  const nineTags = "t1,t2,t3,t4,t5,t6,t7,t8,KEEP_ME";
  assert.deepEqual(
    Array.from(context.normalizeKanbanTags(nineTags)),
    ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "KEEP_ME"]
  );
  assert.match(context.validateKanbanTags(nineTags), /^kanban\.tooManyTags:/);

  const longTag = `${"x".repeat(40)}KEEP`;
  assert.equal(context.normalizeKanbanTags(longTag)[0], longTag);
  assert.match(context.validateKanbanTags(longTag), /^kanban\.tagTooLong:/);
});

test("block PATCH fences invalid stored metadata before accepting replacement metadata", async () => {
  const source = await fs.readFile(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8");
  const guardDefinition = source.indexOf("function assertExistingMetadataSafeToOverwrite(existing: BlockRow)");
  const guardCall = source.indexOf("assertExistingMetadataSafeToOverwrite(existing);");
  const replacementSelection = source.indexOf(
    "const sourceMetadata = body.metadata !== undefined ? body.metadata : existing.metadata;"
  );

  assert.ok(guardDefinition >= 0);
  assert.ok(guardCall > guardDefinition);
  assert.ok(replacementSelection > guardCall);
  assert.match(source, /409,\s*\n\s*"BLOCK_METADATA_RECOVERY_REQUIRED"/);
});
