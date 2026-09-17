/**
 * Plan a direct-editor insertion from committed server responses, without a GET.
 * This is not optimistic persistence: unknown/stale/incomplete responses return
 * null, leaving the caller on its existing canonical refresh/conflict path.
 * Authentication, navigation, permissions and pending-draft guards are enforced
 * by the caller immediately before applying the returned tree.
 */
export function planConfirmedBlockInsertion({
  pageId,
  baseContentVersion,
  currentContentVersion,
  beforeBlocks,
  currentBlocks,
  parentBlockId = null,
  orderedIds,
  createResult,
  orderResult = null
} = {}) {
  const positiveVersion = (value) => Number.isSafeInteger(value) && value > 0;
  const parent = (block) => block.parentBlockId ?? null;
  const sameOrder = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
  const created = createResult?.block;
  const result = orderResult ?? createResult;
  const delta = orderResult === null ? 1 : 2;
  if (
    typeof pageId !== "string" || !pageId
    || !positiveVersion(baseContentVersion)
    || !positiveVersion(result?.pageContentVersion)
    || createResult?.pageContentVersionAuthoritative !== true
    || createResult.pageContentVersion !== baseContentVersion + 1
    || result.pageContentVersion !== baseContentVersion + delta
    || currentContentVersion !== result.pageContentVersion
    || typeof result.pageUpdatedAt !== "string" || !Number.isFinite(Date.parse(result.pageUpdatedAt))
    || !created?.id
    || !Array.isArray(beforeBlocks)
    || !Array.isArray(currentBlocks)
    || !Array.isArray(orderedIds)
  ) return null;

  // Reuse one operation-local membership index. Repeated includes() calls for
  // every sibling otherwise rescan the full order list quadratically.
  const orderedIdSet = new Set(orderedIds);
  if (orderedIdSet.size !== orderedIds.length) return null;

  const indexBlocks = (blocks) => {
    if (!Array.isArray(blocks)) return null;
    const byId = new Map();
    for (const block of blocks) {
      if (
        !block || typeof block.id !== "string" || !block.id
        || block.pageId !== pageId || byId.has(block.id)
        || !positiveVersion(block.version)
        || !Number.isSafeInteger(block.sortOrder) || block.sortOrder < 0
        || (parent(block) !== null && (typeof parent(block) !== "string" || !parent(block)))
      ) return null;
      byId.set(block.id, block);
    }
    return byId;
  };
  const before = indexBlocks(beforeBlocks);
  const current = indexBlocks(currentBlocks);
  if (
    !before || !current || !indexBlocks([created])
    || before.has(created.id) || current.has(created.id)
    || before.size !== current.size
    || parent(created) !== parentBlockId
    || (parentBlockId !== null && !before.has(parentBlockId))
  ) return null;

  // No local/unrelated structural changes may have raced with this operation.
  for (const [id, block] of before) {
    const known = current.get(id);
    if (!known || parent(known) !== parent(block)) return null;
    if (orderResult === null && (known.version !== block.version || known.sortOrder !== block.sortOrder)) return null;
  }
  const originalSiblings = beforeBlocks.filter((block) => parent(block) === parentBlockId);
  if (
    orderedIds.length !== originalSiblings.length + 1
    || !orderedIdSet.has(created.id)
    || originalSiblings.some((block) => !orderedIdSet.has(block.id))
  ) return null;

  const canonical = orderResult === null ? [...currentBlocks, created] : orderResult.blocks;
  const byId = indexBlocks(canonical);
  if (!byId || byId.size !== before.size + 1 || !byId.has(created.id)) return null;
  // Reordering bumps only the requested siblings by exactly one version. A
  // version gap/replayed later state must use the canonical refresh instead.
  const reorderedIds = orderResult === null ? new Set() : orderedIdSet;
  for (const [id, block] of byId) {
    const initial = id === created.id ? created : before.get(id);
    if (
      !initial || parent(block) !== parent(initial)
      || block.version !== initial.version + (reorderedIds.has(id) ? 1 : 0)
      || (current.has(id) && block.version < current.get(id).version)
    ) return null;
    if (!reorderedIds.has(id) && block.sortOrder !== initial.sortOrder) return null;
  }
  const canonicalSiblings = canonical
    .filter((block) => parent(block) === parentBlockId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  if (!sameOrder(canonicalSiblings.map((block) => block.id), orderedIds)) return null;
  // Ambiguous duplicate positions are not proof of the intended server order.
  if (new Set(canonicalSiblings.map((block) => block.sortOrder)).size !== canonicalSiblings.length) return null;

  // Validate the entire hierarchy before constructing a tree. Never silently
  // drop a missing-parent block or truncate a cycle/deep tree to make it fit.
  const depths = new Map();
  for (const id of byId.keys()) {
    // An earlier leaf-first walk may already have validated this entire path.
    if (depths.has(id)) continue;
    let cursor = id;
    const trail = [];
    const seen = new Set();
    while (cursor !== null && !depths.has(cursor)) {
      if (!byId.has(cursor) || seen.has(cursor) || trail.length > 128) return null;
      seen.add(cursor);
      trail.push(cursor);
      cursor = parent(byId.get(cursor));
    }
    let depth = cursor === null ? -1 : depths.get(cursor);
    while (trail.length) {
      if (++depth > 128) return null;
      depths.set(trail.pop(), depth);
    }
  }
  const nodes = new Map();
  for (const block of canonical) {
    const { children: _children, depth: _depth, ...record } = block;
    nodes.set(block.id, { ...record, parentBlockId: parent(block), children: [] });
  }
  const roots = [];
  for (const block of nodes.values()) {
    (block.parentBlockId === null ? roots : nodes.get(block.parentBlockId).children).push(block);
  }
  const sort = (siblings) => siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  sort(roots);
  for (const block of nodes.values()) sort(block.children);
  return { blocks: roots, createdBlock: nodes.get(created.id), pageUpdatedAt: result.pageUpdatedAt };
}
