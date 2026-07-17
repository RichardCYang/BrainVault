import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("demo workspace fixture", () => {
  const fixture = JSON.parse(readFileSync(new URL("../scripts/demo-workspace.json", import.meta.url), "utf8"));

  it("includes populated Kanban and database blocks for the README preview", () => {
    const kanban = fixture.blocks.find((block: { type: string }) => block.type === "KANBAN");
    const database = fixture.blocks.find((block: { type: string }) => block.type === "DATABASE");

    expect(kanban?.metadata?.kanban?.columns).toHaveLength(3);
    expect(kanban.metadata.kanban.columns.flatMap((column: { cards: unknown[] }) => column.cards).length).toBeGreaterThan(0);
    expect(database?.metadata?.database?.rows).toHaveLength(4);
    expect(database.metadata.database.views.map((view: { type: string }) => view.type)).toEqual(["table", "board"]);
  });
});
