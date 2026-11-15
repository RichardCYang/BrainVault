export const tableLimits = {
  rows: 50,
  columns: 20,
  cellLength: 4_000
} as const;

export type TableData = {
  rows: string[][];
  /** One stable id per row, parallel to `rows` (see public/table-rows.js). */
  rowIds: string[];
  /** One stable id per column, parallel to each row's cells. */
  columnIds: string[];
  headerRow: boolean;
  headerColumn: boolean;
};

export const tableRowIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

function isValidTableRowId(value: unknown): value is string {
  return typeof value === "string" && tableRowIdPattern.test(value);
}

function uniqueRowId(id: string, used: Set<string>) {
  if (!used.has(id)) return id;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${id.slice(0, 64 - tail.length)}${tail}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Mirrors normalizeTableRowIds in public/table-rows.js exactly. Tables saved
 * before row ids existed get positional ids (row-0, row-1, ...), so every
 * browser and the server agree on an old table's rows. A repeated id (two
 * peers' merges) is renamed with a suffix so no row is lost.
 */
export function normalizeTableRowIds(rowCount: number, sourceIds: unknown): string[] {
  return normalizeTableIds(rowCount, sourceIds, "row");
}

/**
 * Mirrors normalizeTableColumnIds in public/table-rows.js. Columns carry ids
 * the same way rows do (col-0, col-1, ... for tables saved without them), so
 * deleting a column while a peer edits a cell to its right cannot shift that
 * peer's row by one cell.
 */
export function normalizeTableColumnIds(columnCount: number, sourceIds: unknown): string[] {
  return normalizeTableIds(columnCount, sourceIds, "col");
}

function normalizeTableIds(count: number, sourceIds: unknown, prefix: string): string[] {
  const ids: string[] = [];
  const used = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const raw = Array.isArray(sourceIds) ? sourceIds[index] : undefined;
    const id = uniqueRowId(isValidTableRowId(raw) ? raw : `${prefix}-${index}`, used);
    used.add(id);
    ids.push(id);
  }
  return ids;
}

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

function normalizeCell(value: unknown) {
  if (typeof value === "string") return value.slice(0, tableLimits.cellLength);
  if (value === null || value === undefined) return "";
  return String(value).slice(0, tableLimits.cellLength);
}

export function createDefaultTableData(rows = 3, columns = 3): TableData {
  const safeRows = Math.max(1, Math.min(tableLimits.rows, Math.trunc(rows) || 3));
  const safeColumns = Math.max(1, Math.min(tableLimits.columns, Math.trunc(columns) || 3));
  return {
    rows: Array.from({ length: safeRows }, () => Array.from({ length: safeColumns }, () => "")),
    rowIds: normalizeTableRowIds(safeRows, null),
    columnIds: normalizeTableColumnIds(safeColumns, null),
    headerRow: false,
    headerColumn: false
  };
}

export function getTableData(metadata: unknown): TableData {
  const table = parseMetadata(metadata)?.table;
  if (!table || typeof table !== "object" || Array.isArray(table)) return createDefaultTableData();

  const source = table as Record<string, unknown>;
  const sourceRows = Array.isArray(source.rows) ? source.rows.slice(0, tableLimits.rows) : [];
  const sourceIds = Array.isArray(source.rowIds) ? source.rowIds : [];
  const columnCount = Math.max(
    1,
    Math.min(
      tableLimits.columns,
      sourceRows.reduce((max, row) => (Array.isArray(row) ? Math.max(max, row.length) : max), 0) || 3
    )
  );

  // A dropped malformed row takes its id with it, so ids stay on their rows.
  const rows: string[][] = [];
  const keptIds: unknown[] = [];
  sourceRows.forEach((row, index) => {
    if (!Array.isArray(row)) return;
    rows.push(Array.from({ length: columnCount }, (_, column) => normalizeCell(row[column])));
    keptIds.push(sourceIds[index]);
  });
  const finalRows = rows.length ? rows : createDefaultTableData(3, columnCount).rows;

  return {
    rows: finalRows,
    rowIds: normalizeTableRowIds(finalRows.length, rows.length ? keptIds : null),
    columnIds: normalizeTableColumnIds(columnCount, source.columnIds),
    headerRow: source.headerRow === true,
    headerColumn: source.headerColumn === true
  };
}
