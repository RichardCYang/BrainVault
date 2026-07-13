export type FlatBlock = {
  id: string;
  parentBlockId: string | null;
  sortOrder: number;
};

export type BlockNode<T extends FlatBlock> = T & {
  children: BlockNode<T>[];
};

export function buildBlockTree<T extends FlatBlock>(blocks: T[]): BlockNode<T>[] {
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

  const sortNodes = (nodes: BlockNode<T>[]) => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    nodes.forEach((node) => sortNodes(node.children));
  };

  sortNodes(roots);
  return roots;
}
