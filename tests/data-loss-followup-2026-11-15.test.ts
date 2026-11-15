import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
// @ts-expect-error Browser module without type declarations.
import { mergeConcurrentValue, reconcileYMap } from "../public/collaboration.js";
// @ts-expect-error Browser module without type declarations.
import { normalizeTableRowIds as normalizeClientRowIds } from "../public/table-rows.js";
import {
  lostRepairText,
  readCollaborationMaterialization,
  validateCollaborationCandidate
} from "../src/lib/collaboration-materialization.js";
import { getKanbanData } from "../src/lib/kanban.js";
import { assertCanonicalStructuredMetadataModel } from "../src/lib/structured-metadata-canonical.js";
import { assertStructuredBlockMetadataIntegrity } from "../src/lib/structured-metadata-integrity.js";
import { getTableData, normalizeTableRowIds } from "../src/lib/table.js";
import { applyValidatedYjsStateUpdate } from "../src/lib/yjs-validation.js";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const maxStateBytes = 16 * 1024 * 1024;

type Table = { rows: string[][]; rowIds?: string[]; headerRow: boolean; headerColumn: boolean };
const table = (rows: string[][], rowIds?: string[]): { table: Table } => ({
  table: { rows, ...(rowIds ? { rowIds } : {}), headerRow: false, headerColumn: false }
});
const merge = (base: unknown, live: unknown, local: unknown) =>
  (mergeConcurrentValue(base, live, local) as { table: Table }).table;

describe("table rows have stable ids, so concurrent edits merge row by row", () => {
  const base = table([["a", "b"], ["c", "d"]], ["r1", "r2"]);

  it("keeps both rows when two people add a row at once", () => {
    const merged = merge(
      base,
      table([["a", "b"], ["c", "d"], ["PEER", ""]], ["r1", "r2", "p"]),
      table([["a", "b"], ["c", "d"], ["MINE", ""]], ["r1", "r2", "m"])
    );
    expect(merged.rows).toEqual([["a", "b"], ["c", "d"], ["MINE", ""], ["PEER", ""]]);
    expect(merged.rowIds).toEqual(["r1", "r2", "m", "p"]);
  });

  it("keeps a peer's edit to another row when this editor deletes a row", () => {
    const merged = merge(base, table([["a", "b"], ["c", "PEER"]], ["r1", "r2"]), table([["c", "d"]], ["r2"]));
    expect(merged.rows).toEqual([["c", "PEER"]]);
  });

  it("keeps a row this editor deleted when a peer changed it meanwhile", () => {
    const merged = merge(base, table([["PEER", "b"], ["c", "d"]], ["r1", "r2"]), table([["c", "d"]], ["r2"]));
    expect(merged.rows).toEqual([["PEER", "b"], ["c", "d"]]);
  });

  it("merges with a table saved before row ids existed", () => {
    const merged = merge(
      table([["a", "b"], ["c", "d"]], ["row-0", "row-1"]),
      table([["a", "b"], ["c", "PEER"]]),
      table([["a", "b"], ["c", "d"], ["NEW", ""]], ["row-0", "row-1", "n"])
    );
    expect(merged.rows).toEqual([["a", "b"], ["c", "PEER"], ["NEW", ""]]);
  });

  it("pads this editor's new row when a peer added a column", () => {
    const merged = merge(
      base,
      table([["a", "b", ""], ["c", "d", "Z"]], ["r1", "r2"]),
      table([["a", "b"], ["c", "d"], ["NEW", "x"]], ["r1", "r2", "n"])
    );
    expect(merged.rows).toEqual([["a", "b", ""], ["c", "d", "Z"], ["NEW", "x", ""]]);
  });
});

describe("table rows are written to the shared document by id", () => {
  const sync = (a: Y.Doc, b: Y.Doc) => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  };
  const peers = (initial: unknown) => {
    const a = new Y.Doc();
    a.transact(() => reconcileYMap(Y, a.getMap("t"), initial));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    return [a, b] as const;
  };

  it("does not lose a peer's typing in a later row when a row is deleted at the same moment", () => {
    const [a, b] = peers({ rows: [["1"], ["2"], ["3"]], rowIds: ["r1", "r2", "r3"] });
    a.transact(() => reconcileYMap(Y, a.getMap("t"), { rows: [["2"], ["3"]], rowIds: ["r2", "r3"] }));
    b.transact(() => reconcileYMap(Y, b.getMap("t"), { rows: [["1"], ["2"], ["3 typed"]], rowIds: ["r1", "r2", "r3"] }));
    sync(a, b);
    expect(a.getMap("t").toJSON()).toEqual({ rows: [["2"], ["3 typed"]], rowIds: ["r2", "r3"] });
    expect(b.getMap("t").toJSON()).toEqual(a.getMap("t").toJSON());
  });

  it("keeps both rows two peers append at once", () => {
    const [a, b] = peers({ rows: [["1"]], rowIds: ["r1"] });
    a.transact(() => reconcileYMap(Y, a.getMap("t"), { rows: [["1"], ["A"]], rowIds: ["r1", "ra"] }));
    b.transact(() => reconcileYMap(Y, b.getMap("t"), { rows: [["1"], ["B"]], rowIds: ["r1", "rb"] }));
    sync(a, b);
    const merged = a.getMap("t").toJSON() as { rows: string[][]; rowIds: string[] };
    expect(merged.rows.flat().sort()).toEqual(["1", "A", "B"]);
    expect(merged.rows.length).toBe(merged.rowIds.length);
  });

  it("moves rows and upgrades an old table without ids", () => {
    const [a] = peers({ rows: [["1"], ["2"]] });
    a.transact(() => reconcileYMap(Y, a.getMap("t"), { rows: [["1"], ["2"]], rowIds: ["row-0", "row-1"] }));
    a.transact(() => reconcileYMap(Y, a.getMap("t"), { rows: [["2"], ["1"]], rowIds: ["row-1", "row-0"] }));
    expect(a.getMap("t").toJSON()).toEqual({ rows: [["2"], ["1"]], rowIds: ["row-1", "row-0"] });
  });
});

describe("the server and the browser agree on table row ids", () => {
  it("derives the same ids for old tables, renames repeats and drops invalid ones", () => {
    for (const [count, ids] of [
      [3, undefined],
      [3, ["a", "a", "a"]],
      [2, ["ok", "bad id!"]],
      [2, ["x".repeat(64), "x".repeat(64)]]
    ] as const) {
      expect(normalizeTableRowIds(count, ids)).toEqual(normalizeClientRowIds(count, ids));
    }
    expect(normalizeTableRowIds(3, ["a", "a", "a"])).toEqual(["a", "a-2", "a-3"]);
    expect(getTableData({ table: { rows: [["x"], ["y"]] } }).rowIds).toEqual(["row-0", "row-1"]);
  });

  it("still accepts a table saved without ids, and requires one id per row once present", () => {
    const legacy = { table: { rows: [["a"], ["b"]], headerRow: false, headerColumn: false } };
    expect(() => assertCanonicalStructuredMetadataModel("TABLE", assertStructuredBlockMetadataIntegrity("TABLE", legacy)))
      .not.toThrow();
    const current = { table: getTableData(legacy) };
    expect(() => assertCanonicalStructuredMetadataModel("TABLE", current)).not.toThrow();
    const missingId = { table: { ...current.table, rowIds: ["row-0"] } };
    expect(() => assertCanonicalStructuredMetadataModel("TABLE", missingId)).toThrow();
    expect(() => assertStructuredBlockMetadataIntegrity("TABLE", { table: { rows: [["a"]], rowIds: ["bad id!"] } }))
      .toThrow();
  });
});

describe("a merge repair moves what does not fit instead of cutting it", () => {
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
  const page = (title: string, blocks: Record<string, Record<string, unknown>>) => {
    const document = new Y.Doc();
    document.getText("title").insert(0, title);
    for (const [id, block] of Object.entries(blocks)) {
      document.getMap("blocks").set(id, createYValue({
        type: "MARKDOWN", markdown: "", checked: false, parentBlockId: null, sortOrder: 0, metadata: null, ...block
      }));
    }
    return document;
  };
  const fork = (document: Y.Doc) => {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
    return copy;
  };
  const admit = (first: Y.Doc, second: Y.Doc) => validateCollaborationCandidate(
    applyValidatedYjsStateUpdate(Y.encodeStateAsUpdate(first), Y.encodeStateAsUpdate(second), maxStateBytes),
    { maxStateBytes, allowRepair: true }
  );
  const ordered = (document: Y.Doc) => {
    Y.applyUpdate(document, Y.encodeStateAsUpdate(document));
    return [...readCollaborationMaterialization(document).blocks]
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  };

  it("opens the page with the part of a title two people pushed past its limit", () => {
    const base = page("T".repeat(150), { first: { markdown: "first", sortOrder: 0 } });
    const one = fork(base);
    const two = fork(base);
    one.getText("title").insert(150, "A".repeat(10));
    two.getText("title").insert(0, "B".repeat(10));
    const result = admit(one, two);
    expect(result.relocatedBlocks).toBe(1);
    Y.applyUpdate(one, result.candidate.incrementalUpdate);
    const title = one.getText("title").toString();
    const blocks = ordered(one);
    expect(title.length).toBe(160);
    expect(title + blocks[0].markdown).toHaveLength(170);
    expect(blocks.map((block) => block.markdown).slice(1)).toEqual(["first"]);
  });

  it("keeps a code block's overflow as code, right after it", () => {
    const base = page("Page", {
      code: { type: "CODE", markdown: "x".repeat(15_000), sortOrder: 0, metadata: { codeLanguage: "python" } },
      next: { markdown: "next", sortOrder: 1 }
    });
    const one = fork(base);
    const two = fork(base);
    ((one.getMap("blocks").get("code") as Y.Map<unknown>).get("markdown") as Y.Text).insert(15_000, "A".repeat(4_000));
    ((two.getMap("blocks").get("code") as Y.Map<unknown>).get("markdown") as Y.Text).insert(0, "B".repeat(4_000));
    const result = admit(one, two);
    Y.applyUpdate(one, result.candidate.incrementalUpdate);
    const blocks = ordered(one);
    expect(blocks.map((block) => block.type)).toEqual(["CODE", "CODE", "MARKDOWN"]);
    expect(blocks[1].metadata).toEqual({ codeLanguage: "python" });
    expect(blocks[2].markdown).toBe("next");
    expect(blocks.map((block) => block.sortOrder)).toEqual([0, 1, 2]);
  });

  it("moves cards a board can no longer hold into a block below instead of dropping them", () => {
    const cards = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, title: `${prefix} card ${index}` }));
    const board = (list: Array<{ id: string; title: string }>) => ({
      kanban: getKanbanData({ kanban: { title: "Board", columns: [{ id: "todo", title: "To do", cards: list }] } })
    });
    const base = page("Page", { kb: { type: "KANBAN", metadata: board(cards("base", 48)), sortOrder: 0 } });
    const one = fork(base);
    const two = fork(base);
    const column = (document: Y.Doc) => ((((document.getMap("blocks").get("kb") as Y.Map<unknown>)
      .get("metadata") as Y.Map<unknown>).get("kanban") as Y.Map<unknown>).get("columns") as Y.Array<Y.Map<unknown>>)
      .get(0).get("cards") as Y.Array<unknown>;
    const append = (document: Y.Doc, prefix: string) => {
      for (const card of getKanbanData({ kanban: { columns: [{ id: "c", cards: cards(prefix, 2) }] } }).columns[0].cards) {
        column(document).push([createYValue(card)]);
      }
    };
    append(one, "one");
    append(two, "two");
    const result = admit(one, two);
    expect(result.relocatedBlocks).toBe(1);
    Y.applyUpdate(one, result.candidate.incrementalUpdate);
    const blocks = ordered(one);
    const kept = (blocks[0].metadata as { kanban: { columns: Array<{ cards: Array<{ title: string }> }> } })
      .kanban.columns[0].cards.map((card) => card.title);
    const moved = blocks[1].markdown.split("\n");
    expect(kept).toHaveLength(50);
    expect([...kept, ...moved].filter((title) => /card/.test(title)).sort()).toEqual([
      ...cards("base", 48), ...cards("one", 2), ...cards("two", 2)
    ].map((card) => card.title).sort());
  });

  it("reports only written text as lost, not ids a repair renamed", () => {
    expect(lostRepairText({ cards: [{ id: "a", title: "x" }, { id: "a", title: "y" }] },
      { cards: [{ id: "a", title: "x" }, { id: "a-2", title: "y" }] })).toBe("");
    expect(lostRepairText({ description: "long text" }, { description: "long" })).toBe("long text");
  });

  it("tells everyone on the page when text was moved", () => {
    expect(read("src/lib/collaboration-server.ts")).toMatch(/type: "repair-notice", updateId: result\.updateId, relocatedBlocks/);
    expect(read("public/collaboration.js")).toMatch(/message\.type === "repair-notice"/);
    expect(read("public/app.js")).toMatch(/status\.collaborationRepairRelocated/);
  });
});

describe("a collection administrator's deletion can be undone by the owner", () => {
  const routes = read("src/routes/page.routes.ts");
  const deleteRoute = routes.slice(routes.indexOf('pageRouter.delete(\n  "/:pageId"'));
  const snapshots = read("src/lib/workspace-snapshots.ts");

  it("saves the owner's workspace before a delegate deletes nested pages, and never lets the delegate skip it", () => {
    expect(deleteRoute).not.toMatch(/pageOwnerHint\?\.owner_id === user\.id\n\s*&& req\.header/);
    expect(deleteRoute).toMatch(/delegatedDeletion \|\| req\.header\(deleteSafetySnapshotSkipHeader\) !== "1"/);
    expect(deleteRoute).toMatch(/needsPreDeleteSafetySnapshot\(workspaceOwnerId, user\.id, mutationId, pageId\)/);
    expect(deleteRoute).toMatch(/OWNER_DELETE_SAFETY_SNAPSHOT_FAILED/);
    expect(deleteRoute).toMatch(/deleteSafetySnapshotOwnerHeader/);
  });

  it("checks the delegate's own session and locks both accounts in order", () => {
    const boundary = snapshots.slice(snapshots.indexOf("async function assertSnapshotBoundary("));
    expect(boundary).toMatch(/\[actor\.userId, userId\]\.sort\(\)/);
    expect(boundary).toMatch(/ORDER BY id ASC FOR UPDATE/);
    expect(boundary).toMatch(/assertCurrentAuthSessionBoundary\(actor\.userId, authScope, client\)/);
  });

  it("lets a delegate prune only the owner's automatic snapshots", () => {
    expect(snapshots).toMatch(/delegated && row\.kind !== "PRE_RESTORE" && row\.kind !== "PRE_DELETE"/);
    expect(snapshots).toMatch(/Only the owner can create a manual snapshot/);
  });
});

describe("recovery points stay possible and honest", () => {
  it("prunes before-restore and before-deletion snapshots apart", () => {
    const snapshots = read("src/lib/workspace-snapshots.ts");
    expect(snapshots).toMatch(/\(\["PRE_RESTORE", "PRE_DELETE"\] as const\)\.flatMap/);
    expect(snapshots).toMatch(/history_entries_omitted/);
    expect(read("migrations/089_workspace_snapshot_history_omitted.sql")).toMatch(/ADD COLUMN history_entries_omitted/);
  });

  it("keeps a workspace within what one backup holds and warns before it gets there", () => {
    expect(read("src/routes/page.routes.ts")).toMatch(/await assertWorkspacePageCapacity\(client, pageOwnerId\)/);
    expect(read("src/routes/snapshot.routes.ts")).toMatch(/getWorkspaceBackupCapacity\(user\.id\)/);
    expect(read("src/lib/workspace-snapshots.ts")).toMatch(/reason: "WORKSPACE_TOO_LARGE"/);
    expect(read("public/app.js")).toMatch(/function getWorkspaceBackupCapacityWarning\(capacity\)/);
  });

  it("does not let a large reorder block text saves when the tab is hidden", () => {
    const app = read("public/app.js");
    const flush = app.slice(app.indexOf("async function flushPendingPageEdits("));
    expect(flush).toMatch(/getBlockOrderPayloadBytes\(pendingBlockOrderTask\) <= keepaliveSaveBudgetBytes/);
    expect(flush).toMatch(/if \(!keepalive\) throw error;\n\s*blockOrderError = error;/);
  });

  it("merges a split paste's first part with a concurrent change instead of dropping it", () => {
    const app = read("public/app.js");
    const paste = app.slice(app.indexOf("async function pasteAcrossBlocks("));
    expect(paste).toMatch(/setSplitPasteSourceLocked\(sourceId, true\)/);
    expect(paste).toMatch(/rebaseTextEdit\(original, sourceTextarea\.value, chunks\[0\]\)/);
  });
});
