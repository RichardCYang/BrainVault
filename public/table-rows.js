// @ts-check

/**
 * Table rows carry stable ids (metadata.table.rowIds, parallel to rows) so a
 * concurrent merge can tell "a peer added a row" from "this row changed".
 * Tables saved before ids existed have none; they get positional ids
 * (row-0, row-1, ...) the first time they are read. Every browser and the
 * server derive the same ids from the same saved table, so two people opening
 * an old table agree on its rows. src/lib/table.ts mirrors this exactly.
 */
export const tableRowIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidTableRowId(value) {
  return typeof value === "string" && tableRowIdPattern.test(value);
}

function uniqueRowId(id, used) {
  if (!used.has(id)) return id;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${id.slice(0, 64 - tail.length)}${tail}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * One id per row: a valid id given for that row is kept, a missing or invalid
 * one becomes `row-<index>`, and a repeated one is renamed with a suffix.
 */
export function normalizeTableRowIds(rowCount, sourceIds) {
  return normalizeTableIds(rowCount, sourceIds, "row");
}

/**
 * Columns carry ids the same way (metadata.table.columnIds, parallel to each
 * row's cells; `col-<index>` for tables saved without them). Deleting a column
 * while a peer edited a cell to its right used to shift that peer's row.
 */
export function normalizeTableColumnIds(columnCount, sourceIds) {
  return normalizeTableIds(columnCount, sourceIds, "col");
}

function normalizeTableIds(count, sourceIds, prefix) {
  const ids = [];
  const used = new Set();
  for (let index = 0; index < count; index += 1) {
    const raw = Array.isArray(sourceIds) ? sourceIds[index] : undefined;
    const id = uniqueRowId(isValidTableRowId(raw) ? raw : `${prefix}-${index}`, used);
    used.add(id);
    ids.push(id);
  }
  return ids;
}

function createTableId(existingIds, prefix) {
  const used = new Set(existingIds);
  for (;;) {
    const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
    const id = `${prefix}_${random}`;
    if (!used.has(id)) return id;
  }
}

/** A new row's id, unique among `existingIds`. */
export function createTableRowId(existingIds = []) {
  return createTableId(existingIds, "row");
}

/** A new column's id, unique among `existingIds`. */
export function createTableColumnId(existingIds = []) {
  return createTableId(existingIds, "col");
}
