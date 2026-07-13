export const tableLimits = {
  rows: 50,
  columns: 20,
  cellLength: 4_000
} as const;

export type TableData = {
  rows: string[][];
  headerRow: boolean;
  headerColumn: boolean;
};

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
    headerRow: false,
    headerColumn: false
  };
}

export function getTableData(metadata: unknown): TableData {
  const table = parseMetadata(metadata)?.table;
  if (!table || typeof table !== "object" || Array.isArray(table)) return createDefaultTableData();

  const source = table as Record<string, unknown>;
  const sourceRows = Array.isArray(source.rows) ? source.rows.slice(0, tableLimits.rows) : [];
  const columnCount = Math.max(
    1,
    Math.min(
      tableLimits.columns,
      sourceRows.reduce((max, row) => (Array.isArray(row) ? Math.max(max, row.length) : max), 0) || 3
    )
  );

  const rows = sourceRows
    .filter(Array.isArray)
    .map((row) => Array.from({ length: columnCount }, (_, index) => normalizeCell(row[index])));

  return {
    rows: rows.length ? rows : createDefaultTableData(3, columnCount).rows,
    headerRow: source.headerRow === true,
    headerColumn: source.headerColumn === true
  };
}
