// @ts-check

/**
 * Clamp a collaboration block order to the same range accepted by the browser
 * document normalizer.
 *
 * @param {unknown} value
 */
function normalizeSortOrder(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(2_147_483_647, Math.max(0, Math.trunc(numeric)))
    : 0;
}

/**
 * @param {unknown} value
 */
function normalizeBlockId(value) {
  return value ? String(value).slice(0, 64) : null;
}

/**
 * Merge immutable server-authoritative attachment content with the mutable
 * position already present in the durable Yjs document.
 *
 * SQL can legitimately lag the Yjs update log between an acknowledged move and
 * the next relational materialization. Reapplying SQL parent/sort fields during
 * reconnect would therefore publish stale location data as a newer Yjs update.
 * Existing Yjs location wins; SQL location is used only when the attachment is
 * genuinely absent from the collaboration document.
 *
 * @template {Record<string, unknown>} T
 * @param {T} canonicalAttachment normalized attachment returned by the server
 * @param {Record<string, unknown> | null} currentAttachment normalized current Yjs block
 * @param {Iterable<string>} availableBlockIds active, non-tombstoned block ids
 * @returns {T & { parentBlockId: string | null, sortOrder: number }}
 */
export function reconcileCanonicalAttachment(
  canonicalAttachment,
  currentAttachment,
  availableBlockIds
) {
  const canonicalId = normalizeBlockId(canonicalAttachment?.id);
  const activeIds = availableBlockIds instanceof Set
    ? availableBlockIds
    : new Set(availableBlockIds ?? []);
  const currentMatchesCanonical = Boolean(
    currentAttachment
      && normalizeBlockId(currentAttachment.id) === canonicalId
  );
  const locationSource = currentMatchesCanonical ? currentAttachment : canonicalAttachment;
  const requestedParentId = normalizeBlockId(locationSource?.parentBlockId);
  const parentBlockId = requestedParentId
    && requestedParentId !== canonicalId
    && activeIds.has(requestedParentId)
      ? requestedParentId
      : null;

  return {
    ...canonicalAttachment,
    parentBlockId,
    sortOrder: normalizeSortOrder(locationSource?.sortOrder)
  };
}
