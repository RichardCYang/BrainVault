import { ApiError } from "../lib/http.js";

export const maxBlockHierarchyDepth = 128;
export const maxPageHierarchyDepth = 256;

export function assertBlockParentChangesDepth(
  rows: Array<{ id: string; parent_block_id: string | null }>,
  items: Array<{ id: string; parentBlockId?: string | null }>
) {
  const parents = new Map(rows.map((row) => [row.id, row.parent_block_id]));
  for (const item of items) {
    if (item.parentBlockId !== undefined) parents.set(item.id, item.parentBlockId);
  }
  assertHierarchyDepth(parents, maxBlockHierarchyDepth, "BLOCK");
}

// Memoize completed paths so even reverse-ordered chains take linear time.
// Missing parents terminate a path; callers separately enforce parent scope.
export function assertHierarchyDepth(
  parents: ReadonlyMap<string, string | null>,
  maxDepth: number,
  kind: "BLOCK" | "PAGE"
) {
  const depths = new Map<string, number>();
  for (const id of parents.keys()) {
    if (depths.has(id)) continue;
    const path: string[] = [];
    const visiting = new Set<string>();
    let current: string | null = id;
    while (current !== null && parents.has(current) && !depths.has(current)) {
      if (visiting.has(current)) {
        throw new ApiError(400, `INVALID_PARENT_${kind}`, `${kind} hierarchy cannot contain a cycle`);
      }
      visiting.add(current);
      path.push(current);
      if (path.length > maxDepth) {
        throw new ApiError(413, `${kind}_HIERARCHY_TOO_DEEP`, `${kind} hierarchy cannot exceed ${maxDepth} levels`);
      }
      current = parents.get(current) ?? null;
    }
    let depth = current === null ? 0 : depths.get(current) ?? 0;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      depth += 1;
      if (depth > maxDepth) {
        throw new ApiError(413, `${kind}_HIERARCHY_TOO_DEEP`, `${kind} hierarchy cannot exceed ${maxDepth} levels`);
      }
      depths.set(path[index], depth);
    }
  }
}
