import { assertHierarchyDepth, maxBlockHierarchyDepth } from "./hierarchy.js";

export type FlatBlock = {
  id: string;
  parentBlockId: string | null;
  sortOrder: number;
};

export type BlockNode<T extends FlatBlock> = T & {
  children: BlockNode<T>[];
};

export function buildBlockTree<T extends FlatBlock>(blocks: T[]): BlockNode<T>[] {
  assertHierarchyDepth(new Map(blocks.map((block) => [block.id, block.parentBlockId])), maxBlockHierarchyDepth, "BLOCK");
  const byId = new Map<string, BlockNode<T>>();
  const roots: BlockNode<T>[] = [];

  for (const block of blocks) {
    byId.set(block.id, { ...block, children: [] });
  }

  for (const node of byId.values()) {
    if (node.parentBlockId && byId.has(node.parentBlockId)) {
      byId.get(node.parentBlockId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const pending = [roots];
  while (pending.length) {
    const nodes = pending.pop()!;
    nodes.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    for (const node of nodes) if (node.children.length) pending.push(node.children);
  }
  return roots;
}
