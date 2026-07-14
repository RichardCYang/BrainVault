import { describe, expect, it } from "vitest";
import {
  applyDatabaseView,
  createDefaultDatabaseData,
  databaseLimits,
  getDatabaseData,
  renderDatabaseHtml
} from "../src/lib/database.js";
import { renderBlockHtml } from "../src/lib/markdown.js";

describe("Database block data", () => {
  it("creates table and board views over a property schema", () => {
    const database = createDefaultDatabaseData();
    expect(database.properties[0]).toMatchObject({ id: "title", type: "title" });
    expect(database.properties.some((property) => property.type === "select")).toBe(true);
    expect(database.views.map((view) => view.type)).toEqual(["table", "board"]);
    expect(database.rows).toHaveLength(1);
  });

  it("normalizes malformed data and keeps one title property", () => {
    const duplicateId = "duplicate";
    const database = getDatabaseData({
      database: {
        title: "D".repeat(databaseLimits.titleLength + 10),
        properties: [
          { id: duplicateId, name: "Primary", type: "title" },
          { id: duplicateId, name: "Extra title", type: "title" },
          {
            id: "status",
            name: "Status",
            type: "select",
            options: Array.from({ length: databaseLimits.optionsPerProperty + 4 }, (_, index) => ({
              id: duplicateId,
              name: `Option ${index}`,
              color: "invalid"
            }))
          }
        ],
        rows: Array.from({ length: databaseLimits.rows + 5 }, (_, index) => ({
          id: duplicateId,
          values: { [duplicateId]: `Row ${index}`, status: duplicateId }
        })),
        views: [{ id: duplicateId, name: "Filtered", type: "table", filters: [], sorts: [] }],
        activeViewId: duplicateId
      }
    });

    expect(database.title).toHaveLength(databaseLimits.titleLength);
    expect(database.properties.filter((property) => property.type === "title")).toHaveLength(1);
    expect(new Set(database.properties.map((property) => property.id)).size).toBe(database.properties.length);
    expect(database.properties.find((property) => property.id === "status")?.options)
      .toHaveLength(databaseLimits.optionsPerProperty);
    expect(database.rows).toHaveLength(databaseLimits.rows);
    expect(new Set(database.rows.map((row) => row.id)).size).toBe(database.rows.length);
  });

  it("applies filters and ordered sorts to a view", () => {
    const database = getDatabaseData({
      database: {
        title: "Tasks",
        properties: [
          { id: "title", name: "Name", type: "title" },
          { id: "points", name: "Points", type: "number" },
          {
            id: "status",
            name: "Status",
            type: "select",
            options: [
              { id: "todo", name: "To do", color: "gray" },
              { id: "done", name: "Done", color: "green" }
            ]
          }
        ],
        rows: [
          { id: "one", values: { title: "Alpha", points: 3, status: "todo" } },
          { id: "two", values: { title: "Beta", points: 8, status: "done" } },
          { id: "three", values: { title: "Gamma", points: 5, status: "done" } }
        ],
        views: [
          {
            id: "view",
            name: "Done",
            type: "table",
            filters: [{ id: "filter", propertyId: "status", operator: "equals", value: "done" }],
            sorts: [{ id: "sort", propertyId: "points", direction: "descending" }]
          }
        ],
        activeViewId: "view"
      }
    });

    expect(applyDatabaseView(database).map((row) => row.id)).toEqual(["two", "three"]);
  });
});

describe("Database block rendering", () => {
  const metadata = {
    database: {
      title: "Tasks <script>alert(1)</script>",
      properties: [
        { id: "title", name: "Name", type: "title" },
        {
          id: "status",
          name: "Status",
          type: "select",
          options: [{ id: "done", name: "Done <img src=x onerror=alert(1)>", color: "green" }]
        },
        { id: "url", name: "Link", type: "url" }
      ],
      rows: [
        {
          id: "row",
          values: {
            title: "Ship <svg onload=alert(1)>",
            status: "done",
            url: "https://example.com/?a=1&b=2"
          }
        }
      ],
      views: [{ id: "table", name: "Table", type: "table", filters: [], sorts: [] }],
      activeViewId: "table"
    }
  };

  it("escapes database content and keeps database render classes", () => {
    const html = renderDatabaseHtml(metadata);
    expect(html).toContain('class="rendered-database"');
    expect(html).toContain("Tasks &lt;script&gt;");
    expect(html).toContain("Ship &lt;svg onload=alert(1)&gt;");
    expect(html).toContain("Done &lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<img");
  });

  it("is sanitized by the standard block renderer", () => {
    const html = renderBlockHtml("DATABASE", "", false, metadata);
    expect(html).toContain('class="rendered-database-table"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<script");
  });
});
