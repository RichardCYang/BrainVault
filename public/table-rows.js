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
  const ids = [];
  const used = new Set();
  for (let index = 0; index < rowCount; index += 1) {
    const raw = Array.isArray(sourceIds) ? sourceIds[index] : undefined;
    const id = uniqueRowId(isValidTableRowId(raw) ? raw : `row-${index}`, used);
    used.add(id);
    ids.push(id);
  }
  return ids;
}

/** A new row's id, unique among `existingIds`. */
export function createTableRowId(existingIds = []) {
  const used = new Set(existingIds);
  for (;;) {
    const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
    const id = `row_${random}`;
    if (!used.has(id)) return id;
  }
}
