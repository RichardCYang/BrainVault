export type BlockHierarchyRow = {
  id: string;
  parent_block_id: string | null;
  sort_order: number;
};

export type BlockHierarchyUpdate = {
  id: string;
  parentBlockId: string | null;
  sortOrder: number;
};

export type BlockPreserveChildrenPlan<T extends BlockHierarchyRow> = {
  target: T;
  immediateChildren: T[];
  resultingSiblings: T[];
  updates: BlockHierarchyUpdate[];
};

export class BlockPreserveChildrenIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockPreserveChildrenIntegrityError";
  }
}

function normalizedParentId(parentBlockId: string | null | undefined) {
  return parentBlockId ?? null;
}

function rowsShareParent(left: string | null | undefined, right: string | null | undefined) {
  return normalizedParentId(left) === normalizedParentId(right);
}

function compareBlockOrder(left: BlockHierarchyRow, right: BlockHierarchyRow) {
  return Number(left.sort_order) - Number(right.sort_order) || left.id.localeCompare(right.id);
}

export function planBlockDeletePreservingChildren<T extends BlockHierarchyRow>(
  targetId: string,
  hierarchyRows: T[]
): BlockPreserveChildrenPlan<T> {
  const rowById = new Map(hierarchyRows.map((row) => [row.id, row]));
  const target = rowById.get(targetId);
  if (!target) throw new BlockPreserveChildrenIntegrityError("The target block is missing from its page hierarchy");

  const siblings = hierarchyRows
    .filter((row) => rowsShareParent(row.parent_block_id, target.parent_block_id))
    .sort(compareBlockOrder);
  const immediateChildren = hierarchyRows
    .filter((row) => row.parent_block_id === target.id)
    .sort(compareBlockOrder);
  const targetIndex = siblings.findIndex((row) => row.id === target.id);
  if (targetIndex < 0) {
    throw new BlockPreserveChildrenIntegrityError("The target block is missing from its sibling order");
  }

  const resultingSiblings = siblings.filter((row) => row.id !== target.id);
  resultingSiblings.splice(targetIndex, 0, ...immediateChildren);
  const parentBlockId = normalizedParentId(target.parent_block_id);
  const updates = resultingSiblings
    .map((row, sortOrder) => ({ id: row.id, parentBlockId, sortOrder }))
    .filter((update) => {
      const current = rowById.get(update.id);
      return Boolean(
        current
          && (!rowsShareParent(current.parent_block_id, update.parentBlockId)
            || Number(current.sort_order) !== update.sortOrder)
      );
    });

  return { target, immediateChildren, resultingSiblings, updates };
}
