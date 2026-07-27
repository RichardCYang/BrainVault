export type CollaborationHierarchyBlock = {
  id: string;
  parentBlockId: string | null;
  sortOrder: number;
};

export class CollaborationDocumentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CollaborationDocumentError";
    this.code = code;
  }
}

export function validateCollaborationBlockHierarchy<T extends CollaborationHierarchyBlock>(blocks: T[]) {
  const byId = new Map<string, T>();
  for (const block of blocks) {
    if (byId.has(block.id)) {
      throw new CollaborationDocumentError(
        "DUPLICATE_BLOCK_ID",
        "A collaboration snapshot contains duplicate block ids"
      );
    }
    byId.set(block.id, block);
  }

  for (const block of blocks) {
    if (block.parentBlockId && !byId.has(block.parentBlockId)) {
      throw new CollaborationDocumentError(
        "INVALID_PARENT_BLOCK",
        "Parent block must exist in the collaboration snapshot"
      );
    }
    if (block.parentBlockId === block.id) {
      throw new CollaborationDocumentError("INVALID_PARENT_BLOCK", "A block cannot be its own parent");
    }
  }

  const depthCache = new Map<string, number>();
  const visitState = new Map<string, "visiting" | "done">();
  for (const block of blocks) {
    if (visitState.get(block.id) === "done") continue;
    const path: T[] = [];
    let current: T | undefined = block;
    while (current) {
      const state = visitState.get(current.id);
      if (state === "visiting") {
        throw new CollaborationDocumentError("INVALID_PARENT_BLOCK", "Block hierarchy cannot contain a cycle");
      }
      if (state === "done") break;
      visitState.set(current.id, "visiting");
      path.push(current);
      current = current.parentBlockId ? byId.get(current.parentBlockId) : undefined;
    }

    let nextDepth = current ? (depthCache.get(current.id) ?? 0) + 1 : 0;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const item = path[index];
      if (nextDepth > 128) {
        throw new CollaborationDocumentError(
          "BLOCK_NESTING_TOO_DEEP",
          "Block nesting cannot exceed 128 levels"
        );
      }
      depthCache.set(item.id, nextDepth);
      visitState.set(item.id, "done");
      nextDepth += 1;
    }
  }

  return [...blocks].sort((left, right) =>
    (depthCache.get(left.id) ?? 0) - (depthCache.get(right.id) ?? 0)
    || left.sortOrder - right.sortOrder
    || left.id.localeCompare(right.id)
  );
}
