import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CollaborationDocumentError } from "../src/lib/collaboration-document.js";
import {
  readCollaborationMaterialization,
  validateCollaborationCandidate
} from "../src/lib/collaboration-materialization.js";
import { getKanbanData } from "../src/lib/kanban.js";
import { getTableData } from "../src/lib/table.js";
import { applyValidatedYjsStateUpdate } from "../src/lib/yjs-validation.js";

// Two people edit the same shared page at once. Each edit is valid on its own;
// the CRDT merge of both can still break a document rule. The server must
// repair that merge (keeping content) instead of rejecting the second person's
// update on every reconnect, which used to leave their edits unsaveable.

const maxStateBytes = 16 * 1024 * 1024;

function createYValue(value: unknown): unknown {
  if (typeof value === "string") {
    const text = new Y.Text();
    if (value) text.insert(0, value);
    return text;
  }
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>();
    if (value.length) array.insert(0, value.map(createYValue));
    return array;
  }
  if (value && typeof value === "object") {
    const map = new Y.Map<unknown>();
    for (const [key, item] of Object.entries(value)) map.set(key, createYValue(item));
    return map;
  }
  return value ?? null;
}

type BlockInput = {
  type?: string;
  markdown?: string;
  parentBlockId?: string | null;
  sortOrder?: number;
  metadata?: Record<string, unknown> | null;
};

function setBlock(document: Y.Doc, id: string, block: BlockInput) {
  document.getMap("blocks").set(id, createYValue({
    type: block.type ?? "MARKDOWN",
    markdown: block.markdown ?? "",
    checked: false,
    parentBlockId: block.parentBlockId ?? null,
    sortOrder: block.sortOrder ?? 0,
    metadata: block.metadata ?? null
  }));
}

function createPage(blocks: Record<string, BlockInput>) {
  const document = new Y.Doc();
  document.getText("title").insert(0, "Shared page");
  for (const [id, block] of Object.entries(blocks)) setBlock(document, id, block);
  return document;
}

function fork(document: Y.Doc) {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  return copy;
}

function blockMap(document: Y.Doc, id: string) {
  return document.getMap("blocks").get(id) as Y.Map<unknown>;
}

/** The server already holds `first`; `second` now arrives from another peer. */
function admit(first: Y.Doc, second: Y.Doc, allowRepair = true) {
  const candidate = applyValidatedYjsStateUpdate(
    Y.encodeStateAsUpdate(first),
    Y.encodeStateAsUpdate(second),
    maxStateBytes
  );
  return validateCollaborationCandidate(candidate, { maxStateBytes, allowRepair });
}

/** Both peers apply the server's broadcast update and must agree. */
function expectPeersConverge(first: Y.Doc, second: Y.Doc, incrementalUpdate: Uint8Array) {
  Y.applyUpdate(first, incrementalUpdate);
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
  const left = readCollaborationMaterialization(first);
  const right = readCollaborationMaterialization(second);
  expect(right).toEqual(left);
  return left;
}

describe("collaboration concurrent merge repair", () => {
  it("pads the short row left by a row and a column added at once", () => {
    const table = { table: getTableData({ table: { rows: [["a", "b"], ["c", "d"]] } }) };
    const base = createPage({ tbl: { type: "TABLE", metadata: table } });
    const first = fork(base);
    const second = fork(base);

    const rows = (blockMap(first, "tbl").get("metadata") as Y.Map<unknown>).get("table") as Y.Map<unknown>;
    for (const row of (rows.get("rows") as Y.Array<Y.Array<unknown>>).toArray()) row.push([new Y.Text()]);
    const otherRows = ((blockMap(second, "tbl").get("metadata") as Y.Map<unknown>).get("table") as Y.Map<unknown>)
      .get("rows") as Y.Array<unknown>;
    otherRows.push([createYValue(["e", "f"])]);

    const result = admit(first, second);
    expect(result.repaired).toBe(true);
    const merged = expectPeersConverge(first, second, result.candidate.incrementalUpdate);
    expect((merged.blocks[0].metadata as { table: { rows: string[][] } }).table.rows)
      .toEqual([["a", "b", ""], ["c", "d", ""], ["e", "f", ""]]);
  });

  it("keeps both copies of a card that two people moved to different columns", () => {
    const kanban = {
      kanban: getKanbanData({
        kanban: {
          title: "Board",
          columns: [
            { id: "todo", title: "To do", cards: [{ id: "card1", title: "Write report" }] },
            { id: "doing", title: "Doing", cards: [] },
            { id: "done", title: "Done", cards: [] }
          ]
        }
      })
    };
    const base = createPage({ kb: { type: "KANBAN", metadata: kanban } });
    const first = fork(base);
    const second = fork(base);
    const move = (document: Y.Doc, to: number) => {
      const columns = (((blockMap(document, "kb").get("metadata") as Y.Map<unknown>).get("kanban") as Y.Map<unknown>)
        .get("columns") as Y.Array<Y.Map<unknown>>);
      const card = (columns.get(0).get("cards") as Y.Array<Y.Map<unknown>>).get(0).toJSON();
      (columns.get(0).get("cards") as Y.Array<unknown>).delete(0, 1);
      (columns.get(to).get("cards") as Y.Array<unknown>).push([createYValue(card)]);
    };
    move(first, 1);
    move(second, 2);

    const result = admit(first, second);
    expect(result.repaired).toBe(true);
    const merged = expectPeersConverge(first, second, result.candidate.incrementalUpdate);
    const columns = (merged.blocks[0].metadata as { kanban: { columns: Array<{ cards: Array<{ id: string; title: string }> }> } })
      .kanban.columns;
    const cards = columns.flatMap((column) => column.cards);
    expect(cards.map((card) => card.title)).toEqual(["Write report", "Write report"]);
    expect(new Set(cards.map((card) => card.id)).size).toBe(2);
  });

  it("moves a block to the top level when a peer deleted its new parent", () => {
    const base = createPage({ parent: { markdown: "Parent" }, child: { markdown: "My notes", sortOrder: 1 } });
    const first = fork(base);
    const second = fork(base);
    first.getMap("blocks").delete("parent");
    (blockMap(second, "child")).set("parentBlockId", createYValue("parent"));

    const result = admit(first, second);
    expect(result.repaired).toBe(true);
    const merged = expectPeersConverge(first, second, result.candidate.incrementalUpdate);
    expect(merged.blocks).toEqual([expect.objectContaining({ id: "child", markdown: "My notes", parentBlockId: null })]);
  });

  it("breaks a cycle made by two crossing moves without dropping either block", () => {
    const base = createPage({ a: { markdown: "A" }, b: { markdown: "B", sortOrder: 1 } });
    const first = fork(base);
    const second = fork(base);
    blockMap(first, "a").set("parentBlockId", createYValue("b"));
    blockMap(second, "b").set("parentBlockId", createYValue("a"));

    const result = admit(first, second);
    expect(result.repaired).toBe(true);
    const merged = expectPeersConverge(first, second, result.candidate.incrementalUpdate);
    expect(merged.blocks.map((block) => block.markdown).sort()).toEqual(["A", "B"]);
    expect(merged.blocks.filter((block) => block.parentBlockId === null)).toHaveLength(1);
  });

  it("continues text over the block limit in a new block instead of cutting it", () => {
    const filler = "x".repeat(15_000);
    const base = createPage({ note: { markdown: filler } });
    const first = fork(base);
    const second = fork(base);
    (blockMap(first, "note").get("markdown") as Y.Text).insert(15_000, "A".repeat(4_000));
    (blockMap(second, "note").get("markdown") as Y.Text).insert(0, "B".repeat(4_000));

    const result = admit(first, second);
    expect(result.repaired).toBe(true);
    const merged = expectPeersConverge(first, second, result.candidate.incrementalUpdate);
    expect(merged.blocks).toHaveLength(2);
    const text = [...merged.blocks].sort((left, right) => left.sortOrder - right.sortOrder)
      .map((block) => block.markdown).join("");
    expect(text.length).toBe(23_000);
    expect(text.split("A").length - 1).toBe(4_000);
    expect(text.split("B").length - 1).toBe(4_000);
    expect(merged.blocks.every((block) => block.markdown.length <= 20_000)).toBe(true);
  });

  it("leaves a valid merge untouched", () => {
    const base = createPage({ a: { markdown: "A" } });
    const first = fork(base);
    const second = fork(base);
    (blockMap(second, "a").get("markdown") as Y.Text).insert(1, "!");
    const result = admit(first, second);
    expect(result.repaired).toBe(false);
  });

  it("never repairs the first (bootstrap) write, which must match the saved page", () => {
    const table = { table: getTableData({ table: { rows: [["a", "b"]] } }) };
    const base = createPage({ tbl: { type: "TABLE", metadata: table } });
    const first = fork(base);
    const second = fork(base);
    const rows = ((blockMap(first, "tbl").get("metadata") as Y.Map<unknown>).get("table") as Y.Map<unknown>)
      .get("rows") as Y.Array<Y.Array<unknown>>;
    rows.get(0).push([new Y.Text()]);
    (((blockMap(second, "tbl").get("metadata") as Y.Map<unknown>).get("table") as Y.Map<unknown>)
      .get("rows") as Y.Array<unknown>).push([createYValue(["c", "d"])]);
    expect(() => admit(first, second, false)).toThrow(CollaborationDocumentError);
  });

  it("still rejects a document that cannot be repaired without guessing", () => {
    const base = createPage({ a: { markdown: "A" } });
    const second = fork(base);
    blockMap(second, "a").set("unexpected", "field");
    expect(() => admit(base, second)).toThrow(CollaborationDocumentError);
  });
});
