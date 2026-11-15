import { describe, expect, it } from "vitest";
import * as Y from "yjs";
// @ts-expect-error Browser module without type declarations.
import { mergeConcurrentValue, reconcileYMap } from "../public/collaboration.js";
// @ts-expect-error Browser module without type declarations.
import { normalizeTableColumnIds as normalizeClientColumnIds } from "../public/table-rows.js";
// @ts-expect-error Browser module without type declarations.
import { collectBlockSubtree, isDeletionTooLargeForHistory } from "../public/deletion-history-budget.js";
import { boundPageVersionChanges, type PageVersionChange } from "../src/lib/page-version-history.js";
import { assertCanonicalStructuredMetadataModel } from "../src/lib/structured-metadata-canonical.js";
import { assertStructuredBlockMetadataIntegrity } from "../src/lib/structured-metadata-integrity.js";
import { getTableData, normalizeTableColumnIds } from "../src/lib/table.js";

type Table = { rows: string[][]; rowIds?: string[]; columnIds?: string[]; headerRow: boolean; headerColumn: boolean };
const table = (rows: string[][], rowIds: string[], columnIds?: string[]): { table: Table } => ({
  table: { rows, rowIds, ...(columnIds ? { columnIds } : {}), headerRow: false, headerColumn: false }
});
const mergeTable = (base: unknown, live: unknown, local: unknown) =>
  (mergeConcurrentValue(base, live, local) as { table: Table }).table;

describe("table columns have stable ids, so a column delete cannot shift a peer's row", () => {
  const base = table([["a", "b", "c"], ["d", "e", "f"]], ["r1", "r2"], ["c1", "c2", "c3"]);

  it("keeps every row aligned when a peer deletes a column while this editor edits a cell", () => {
    const merged = mergeTable(
      base,
      table([["a", "c"], ["d", "f"]], ["r1", "r2"], ["c1", "c3"]),
      table([["A!", "b", "c"], ["d", "e", "f"]], ["r1", "r2"], ["c1", "c2", "c3"])
    );
    expect(merged.rows).toEqual([["A!", "c"], ["d", "f"]]);
    expect(merged.columnIds).toEqual(["c1", "c3"]);
  });

  it("keeps a column a peer deleted when this editor wrote into it meanwhile", () => {
    const merged = mergeTable(
      base,
      table([["a", "c"], ["d", "f"]], ["r1", "r2"], ["c1", "c3"]),
      table([["a", "b", "c"], ["d", "MINE", "f"]], ["r1", "r2"], ["c1", "c2", "c3"])
    );
    expect(merged.rows).toEqual([["a", "b", "c"], ["d", "MINE", "f"]]);
    expect(merged.columnIds).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps both columns when two people add one at once, each with its text", () => {
    const merged = mergeTable(
      base,
      table([["a", "b", "c", "P"], ["d", "e", "f", ""]], ["r1", "r2"], ["c1", "c2", "c3", "cp"]),
      table([["a", "b", "c", ""], ["d", "e", "f", "M"]], ["r1", "r2"], ["c1", "c2", "c3", "cm"])
    );
    expect(merged.columnIds).toEqual(["c1", "c2", "c3", "cm", "cp"]);
    expect(merged.rows).toEqual([["a", "b", "c", "", "P"], ["d", "e", "f", "M", ""]]);
  });

  it("deletes a row and a column deleted on different sides", () => {
    const merged = mergeTable(
      base,
      table([["a", "c"], ["d", "f"]], ["r1", "r2"], ["c1", "c3"]),
      table([["d", "e", "f"]], ["r2"], ["c1", "c2", "c3"])
    );
    expect(merged.rows).toEqual([["d", "f"]]);
    expect(merged.rowIds).toEqual(["r2"]);
  });

  it("leaves a table nobody saved with column ids in its old shape", () => {
    const merged = mergeTable(
      { table: { rows: [["a"], ["b"]], rowIds: ["r1", "r2"], headerRow: false, headerColumn: false } },
      { table: { rows: [["a"], ["PEER"]], rowIds: ["r1", "r2"], headerRow: false, headerColumn: false } },
      { table: { rows: [["MINE"], ["b"]], rowIds: ["r1", "r2"], headerRow: false, headerColumn: false } }
    );
    expect(merged.rows).toEqual([["MINE"], ["PEER"]]);
    expect("columnIds" in merged).toBe(false);
  });
});

describe("table cells are written to the shared document by column id", () => {
  const sync = (a: Y.Doc, b: Y.Doc) => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  };

  it("does not lose a peer's typing to the right of a column deleted at the same moment", () => {
    const initial = { rows: [["a", "b", "c"]], rowIds: ["r1"], columnIds: ["c1", "c2", "c3"] };
    const a = new Y.Doc();
    a.transact(() => reconcileYMap(Y, a.getMap("t"), initial));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.transact(() => reconcileYMap(Y, a.getMap("t"), { rows: [["a", "c"]], rowIds: ["r1"], columnIds: ["c1", "c3"] }));
    b.transact(() => reconcileYMap(Y, b.getMap("t"), { rows: [["a", "b", "c typed"]], rowIds: ["r1"], columnIds: ["c1", "c2", "c3"] }));
    sync(a, b);
    expect(a.getMap("t").toJSON()).toEqual({ rows: [["a", "c typed"]], rowIds: ["r1"], columnIds: ["c1", "c3"] });
    expect(b.getMap("t").toJSON()).toEqual(a.getMap("t").toJSON());
  });

  it("upgrades a shared table without column ids and writes by id from then on", () => {
    const a = new Y.Doc();
    a.transact(() => reconcileYMap(Y, a.getMap("t"), { rows: [["1", "2"]], rowIds: ["r1"] }));
    a.transact(() => reconcileYMap(Y, a.getMap("t"), { rows: [["1", "2"]], rowIds: ["r1"], columnIds: ["col-0", "col-1"] }));
    a.transact(() => reconcileYMap(Y, a.getMap("t"), { rows: [["2"]], rowIds: ["r1"], columnIds: ["col-1"] }));
    expect(a.getMap("t").toJSON()).toEqual({ rows: [["2"]], rowIds: ["r1"], columnIds: ["col-1"] });
  });
});

describe("the server and the browser agree on table column ids", () => {
  it("derives the same ids, and still accepts tables saved without them", () => {
    for (const [count, ids] of [[3, undefined], [3, ["a", "a", "a"]], [2, ["ok", "bad id!"]]] as const) {
      expect(normalizeTableColumnIds(count, ids)).toEqual(normalizeClientColumnIds(count, ids));
    }
    expect(getTableData({ table: { rows: [["x", "y"]] } }).columnIds).toEqual(["col-0", "col-1"]);
    const legacy = { table: { rows: [["a", "b"]], rowIds: ["row-0"], headerRow: false, headerColumn: false } };
    expect(() => assertCanonicalStructuredMetadataModel("TABLE", assertStructuredBlockMetadataIntegrity("TABLE", legacy)))
      .not.toThrow();
    const current = { table: getTableData(legacy) };
    expect(() => assertCanonicalStructuredMetadataModel("TABLE", current)).not.toThrow();
    expect(() => assertCanonicalStructuredMetadataModel("TABLE", { table: { ...current.table, columnIds: ["col-0"] } }))
      .toThrow();
    expect(() => assertStructuredBlockMetadataIntegrity("TABLE", { table: { rows: [["a"]], columnIds: ["bad id!"] } }))
      .toThrow();
  });
});

describe("lists without ids keep what both sides added", () => {
  const turn = (question: string, answer = "") => ({ question, answer, answeredAt: "2026-11-15T00:00:00.000Z" });

  it("keeps a peer's AI chat turn asked at the same moment", () => {
    const merged = mergeConcurrentValue(
      { aiChat: { turns: [turn("q0", "a0")] } },
      { aiChat: { turns: [turn("q0", "a0"), turn("peer", "peer answer")] } },
      { aiChat: { turns: [turn("q0", "a0"), turn("mine", "my answer")] } }
    ) as { aiChat: { turns: Array<{ question: string }> } };
    expect(merged.aiChat.turns.map((item) => item.question)).toEqual(["q0", "mine", "peer"]);
  });

  it("keeps a peer's turn when this editor's own pending turn gets its answer", () => {
    const merged = mergeConcurrentValue(
      { aiChat: { turns: [turn("q0", "a0"), turn("mine")] } },
      { aiChat: { turns: [turn("q0", "a0"), turn("peer", "peer answer"), turn("mine")] } },
      { aiChat: { turns: [turn("q0", "a0"), turn("mine", "my answer")] } }
    ) as { aiChat: { turns: Array<{ question: string; answer: string }> } };
    expect(merged.aiChat.turns.map((item) => [item.question, item.answer])).toEqual([
      ["q0", "a0"], ["peer", "peer answer"], ["mine", "my answer"]
    ]);
  });

  it("keeps both tags two people added to a card, and one copy of a tag both added", () => {
    const card = (tags: string[]) => ({ kanban: { columns: [{ id: "c1", title: "T", cards: [{ id: "k1", title: "x", tags }] }] } });
    const tagsOf = (value: unknown) =>
      (value as { kanban: { columns: Array<{ cards: Array<{ tags: string[] }> }> } }).kanban.columns[0].cards[0].tags;
    expect(tagsOf(mergeConcurrentValue(card(["a"]), card(["a", "peer"]), card(["a", "mine"])))).toEqual(["a", "mine", "peer"]);
    expect(tagsOf(mergeConcurrentValue(card(["a"]), card(["a", "x"]), card(["a", "x", "y"])))).toEqual(["a", "x", "y"]);
  });

  it("keeps a peer's addition when this editor removed another item", () => {
    const merged = mergeConcurrentValue({ list: ["a", "b"] }, { list: ["a", "b", "peer"] }, { list: ["b"] });
    expect((merged as { list: string[] }).list).toEqual(["b", "peer"]);
  });
});

describe("the delete prompt knows when history cannot keep a block and its nested blocks", () => {
  // A valid table of about `bytes` (cells hold at most 4,000 characters).
  const tableOf = (bytes: number) => {
    const cells = Math.max(1, Math.round(bytes / 3_004));
    const rows = Array.from({ length: Math.ceil(cells / 20) }, (_, row) =>
      Array.from({ length: 20 }, (_, column) => (row * 20 + column < cells ? "x".repeat(3_000) : "")));
    return { table: { rows, headerRow: false, headerColumn: false } };
  };
  const block = (id: string, metadataBytes: number, children: unknown[] = [], markdown = "") => ({
    id, parentBlockId: null, type: metadataBytes ? "TABLE" : "TOGGLE", markdown, checked: false, sortOrder: 0,
    metadata: metadataBytes ? tableOf(metadataBytes) : null, children
  });
  const serverKeepsEverything = (blocks: ReturnType<typeof block>[]) => {
    const changes = blocks.map((item) => ({
      kind: "block-deleted",
      block: {
        id: item.id, parentBlockId: item.parentBlockId, type: item.type, markdown: item.markdown,
        checked: item.checked, sortOrder: item.sortOrder, metadata: item.metadata
      }
    })) as PageVersionChange[];
    const bounded = boundPageVersionChanges(changes);
    return bounded.length === changes.length
      && bounded.every((change) => change.kind !== "block-deleted" || !change.block.metadataOmitted);
  };

  it("warns for three 100 KB tables nested under one toggle, which history cannot all keep", () => {
    const root = block("p", 0, [block("t1", 100_000), block("t2", 100_000), block("t3", 100_000)]);
    const subtree = collectBlockSubtree(root);
    expect(subtree).toHaveLength(4);
    expect(serverKeepsEverything(subtree)).toBe(false);
    expect(isDeletionTooLargeForHistory(subtree)).toBe(true);
  });

  it("never stays silent when the server would leave something out", () => {
    let seed = 7;
    const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let trial = 0; trial < 120; trial += 1) {
      const children = Array.from({ length: random(6) }, (_, index) =>
        block(`c${index}`, random(2) ? 1_000 + random(140_000) : 0, [], "가".repeat(random(20_000))));
      const subtree = collectBlockSubtree(block("root", random(2) ? random(60_000) + 100 : 0, children));
      if (!serverKeepsEverything(subtree)) expect(isDeletionTooLargeForHistory(subtree)).toBe(true);
    }
    expect(isDeletionTooLargeForHistory(collectBlockSubtree(block("small", 2_000, [block("c", 3_000)])))).toBe(false);
  });
});

describe("a backup too large for this server's memory says why, before reading it", () => {
  it("refuses with its own code and numbers before any shard is read, in every language", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8");
    const loader = source.slice(source.indexOf("async function loadBackupShards("));
    expect(loader.indexOf("throw dataRestoreMemoryBudgetError(requiredBytes, dataBudget)"))
      .toBeLessThan(loader.indexOf("readZipEntryBuffer("));
    expect(source).toContain('"DATA_RESTORE_MEMORY_BUDGET_EXCEEDED"');
    const i18n = (await import("../public/i18n.js")) as unknown as {
      setLanguage: (language: string, options: { persist: boolean }) => string;
      t: (key: string, variables?: Record<string, string>) => string;
    };
    for (const language of ["en", "ja", "ko", "fr", "de", "es", "pt"]) {
      i18n.setLanguage(language, { persist: false });
      const message = i18n.t("errors.DATA_RESTORE_MEMORY_BUDGET_EXCEEDED", { requiredMb: "900", maxMb: "400" });
      expect(message).toContain("900");
      expect(message).toContain("400");
      expect(i18n.t("confirm.deleteIncludesUnrestorable")).not.toBe("confirm.deleteIncludesUnrestorable");
    }
    i18n.setLanguage("en", { persist: false });
  });
});

describe("a peer's table update never moves this person's typing into another cell", () => {
  it("finds the focused cell and the toolbar's active cell again by row and column id", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const body = (name: string) => {
      const start = app.indexOf(`function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      return app.slice(start, app.indexOf("\n}\n", start));
    };
    // Reproduced with two browsers: both added a row, the rebuild put Bob's
    // caret in Alice's row by position, and his typing went into her cell.
    expect(body("captureCollaborationEditorFocus")).toMatch(/cellRowId: [^\n]*tableRowId/);
    expect(body("restoreCollaborationEditorFocus"))
      .toMatch(/control = findTableCellById\(row, tableFocus\.cellRowId, tableFocus\.cellColumnId\)/);
    // "Delete row" after a peer's row moved the old position.
    expect(body("handleTableAction")).toMatch(/resolveTableActiveCell\(row, data\)/);
    // Keys pressed right after Enter added a row were lost until the next frame.
    const focus = body("focusTableCell");
    expect(focus.indexOf("input?.focus();")).toBeLessThan(focus.indexOf("requestAnimationFrame("));
    expect(focus).toMatch(/if \(target\.value === valueAtFocus\) target\.select\(\);/);
  });
});
