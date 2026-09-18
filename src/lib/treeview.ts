export const treeViewLimits = {
  titleLength: 120,
  nodes: 300,
  nodeTitleLength: 300,
  noteLength: 8_000,
  idLength: 64
} as const;

type TreeViewNode = {
  id: string;
  parentId: string | null;
  title: string;
  note: string;
  expanded: boolean;
};

export type TreeViewData = {
  title: string;
  nodes: TreeViewNode[];
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown, fallback: string, maxLength: number) {
  return (typeof value === "string" ? value : fallback).slice(0, maxLength);
}

function safeId(value: unknown, fallback: string) {
  const id = typeof value === "string" ? value.trim().slice(0, treeViewLimits.idLength) : "";
  return id || fallback;
}

function uniqueId(requested: string, seen: Set<string>, fallbackPrefix: string) {
  let id = requested;
  let attempt = 1;
  while (seen.has(id)) {
    id = `${fallbackPrefix}-${attempt}`.slice(0, treeViewLimits.idLength);
    attempt += 1;
  }
  seen.add(id);
  return id;
}

function parseMetadata(metadata: unknown) {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) return metadata as Record<string, unknown>;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return recordValue(parsed) ?? {};
    } catch {
      return {};
    }
  }
  return {};
}

function parentWouldCycle(
  nodeId: string,
  parentId: string,
  parentById: Map<string, string | null>,
  acyclicIds: Set<string>
) {
  // This cache belongs only to the current normalization. Parent links below
  // can only be removed, so a path already proved acyclic stays acyclic.
  if (acyclicIds.has(nodeId) || acyclicIds.has(parentId)) return false;
  const seen = new Set([nodeId]);
  let current: string | null = parentId;
  while (current) {
    if (acyclicIds.has(current)) break;
    if (seen.has(current)) return true;
    seen.add(current);
    current = parentById.get(current) ?? null;
  }
  // Do not cache a cyclic path: preserve the original input-order repair rule,
  // including nodes outside a cycle whose ancestors enter that cycle.
  for (const id of seen) acyclicIds.add(id);
  return false;
}

export function createDefaultTreeViewData(): TreeViewData {
  return {
    title: "Tree view",
    nodes: [
      {
        id: "tree-node-1",
        parentId: null,
        title: "Item 1",
        note: "",
        expanded: true
      }
    ]
  };
}

export function normalizeTreeViewData(value: unknown): TreeViewData {
  const source = recordValue(value) ?? {};
  const fallback = createDefaultTreeViewData();
  const rawNodes = Array.isArray(source.nodes) ? source.nodes.slice(0, treeViewLimits.nodes) : fallback.nodes;
  const seen = new Set<string>();
  const nodes = rawNodes
    .map(recordValue)
    .filter((node): node is Record<string, unknown> => Boolean(node))
    .map((node, index) => ({
      id: uniqueId(safeId(node.id, `tree-node-${index + 1}`), seen, `tree-node-${index + 1}`),
      parentId: typeof node.parentId === "string" ? node.parentId.trim().slice(0, treeViewLimits.idLength) || null : null,
      title: stringValue(node.title, `Item ${index + 1}`, treeViewLimits.nodeTitleLength),
      note: stringValue(node.note, "", treeViewLimits.noteLength),
      expanded: node.expanded !== false
    }));

  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    if (node.parentId === node.id || (node.parentId && !ids.has(node.parentId))) node.parentId = null;
  }
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  // Flat outlines need no ancestor cache or extra retained IDs.
  let acyclicIds: Set<string> | null = null;
  for (const node of nodes) {
    if (!node.parentId) continue;
    acyclicIds ??= new Set<string>();
    if (parentWouldCycle(node.id, node.parentId, parentById, acyclicIds)) {
      node.parentId = null;
      parentById.set(node.id, null);
    }
    acyclicIds.add(node.id);
  }

  return {
    title: stringValue(source.title, fallback.title, treeViewLimits.titleLength),
    nodes
  };
}

export function getTreeViewData(metadata: unknown) {
  return normalizeTreeViewData(recordValue(parseMetadata(metadata).treeView));
}

function indexTreeViewChildren(data: TreeViewData) {
  // The normalized snapshot is stable for one render/summary. Do not cache
  // indexes across edits or accounts, where parent links may have changed.
  const childrenByParentId = new Map<string | null, TreeViewNode[]>();
  for (const node of data.nodes) {
    let children = childrenByParentId.get(node.parentId);
    if (!children) {
      children = [];
      childrenByParentId.set(node.parentId, children);
    }
    children.push(node);
  }
  return childrenByParentId;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function noteHtml(note: string) {
  return escapeHtml(note).replaceAll("\n", "<br>");
}

function renderTreeBranch(childrenByParentId: Map<string | null, TreeViewNode[]>, parentId: string | null): string {
  const children = childrenByParentId.get(parentId) ?? [];
  if (!children.length) return "";
  const items = children.map((node) => {
    const descendants = renderTreeBranch(childrenByParentId, node.id);
    const marker = descendants ? '<span class="rendered-treeview-chevron" aria-hidden="true">⌄</span>' : '<span class="rendered-treeview-leaf" aria-hidden="true">•</span>';
    return `<li class="rendered-treeview-node"><div>${marker}<span>${escapeHtml(node.title || "Untitled item")}</span></div>${descendants}</li>`;
  }).join("");
  return `<ul class="rendered-treeview-branch">${items}</ul>`;
}

function getNodePath(byId: Map<string, TreeViewNode>, node: TreeViewNode, pathsById: Map<string, string> | null) {
  if (pathsById) {
    const cached = pathsById.get(node.id);
    if (cached !== undefined) return cached;
    const pending: TreeViewNode[] = [];
    const seen = new Set<string>();
    let current: TreeViewNode | undefined = node;
    let prefix = "";
    while (current) {
      const cachedPath = pathsById.get(current.id);
      if (cachedPath !== undefined) {
        prefix = cachedPath;
        break;
      }
      // Normalization already removes cycles. Retain a defensive guard without
      // caching a partial cyclic path, whose meaning depends on its start node.
      if (seen.has(current.id)) {
        return pending.map((item) => item.title || "Untitled item").reverse().join(" / ");
      }
      seen.add(current.id);
      pending.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const item = pending[index]!;
      const label = item.title || "Untitled item";
      prefix = prefix ? `${prefix} / ${label}` : label;
      pathsById.set(item.id, prefix);
    }
    return prefix;
  }

  const labels = [node.title || "Untitled item"];
  const seen = new Set([node.id]);
  let parent = node.parentId ? byId.get(node.parentId) : undefined;
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    labels.unshift(parent.title || "Untitled item");
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return labels.join(" / ");
}

export function summarizeTreeViewData(value: unknown) {
  const data = normalizeTreeViewData(value);
  const childrenByParentId = indexTreeViewChildren(data);
  const limit = 20_000;
  let summary = "";
  const appendLine = (line: string) => {
    if (!line || summary.length >= limit) return;
    summary += `${summary ? "\n" : ""}${line}`.slice(0, limit - summary.length);
  };
  appendLine(data.title);
  const visit = (parentId: string | null, depth: number) => {
    for (const node of childrenByParentId.get(parentId) ?? []) {
      if (summary.length >= limit) return;
      appendLine(`${"  ".repeat(depth)}- ${node.title}`);
      if (node.note) appendLine(`${"  ".repeat(depth + 1)}${node.note}`);
      visit(node.id, depth + 1);
    }
  };
  // The search summary has always been a 20k-code-unit prefix. Keep complete
  // metadata/normalization, but do not construct the discarded multi-MB suffix.
  visit(null, 0);
  return summary;
}

export function renderTreeViewHtml(metadata: unknown) {
  const data = getTreeViewData(metadata);
  const childrenByParentId = indexTreeViewChildren(data);
  const tree = renderTreeBranch(childrenByParentId, null) || '<div class="rendered-treeview-empty">No items yet.</div>';
  const memoNodes = data.nodes.filter((node) => node.note.trim());
  // Only memo paths need ID lookup; construct it once, not once per memo.
  const byId = new Map(memoNodes.length ? data.nodes.map((node) => [node.id, node] as const) : []);
  // Reuse shared ancestor paths only within this immutable render snapshot.
  // A single memo or flat outline has nothing to share; keep its uncached path.
  const pathsById = memoNodes.length > 1 && memoNodes.some((node) => node.parentId) ? new Map<string, string>() : null;
  const notes = memoNodes
    .map((node) => `<article class="rendered-treeview-note"><header><strong>${escapeHtml(node.title || "Untitled item")}</strong><small>${escapeHtml(getNodePath(byId, node, pathsById))}</small></header><div>${noteHtml(node.note)}</div></article>`)
    .join("") || '<div class="rendered-treeview-empty-note">No item memos yet.</div>';

  return `<section class="rendered-treeview"><header><h3>${escapeHtml(data.title || "Tree view")}</h3><span>Tree view · ${data.nodes.length} items</span></header><div class="rendered-treeview-layout"><div class="rendered-treeview-tree"><strong>Structure</strong>${tree}</div><div class="rendered-treeview-notes"><strong>Memos</strong>${notes}</div></div></section>`;
}
