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

function parentWouldCycle(nodeId: string, parentId: string, parentById: Map<string, string | null>) {
  const seen = new Set([nodeId]);
  let current: string | null = parentId;
  while (current) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = parentById.get(current) ?? null;
  }
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
  for (const node of nodes) {
    if (node.parentId && parentWouldCycle(node.id, node.parentId, parentById)) {
      node.parentId = null;
      parentById.set(node.id, null);
    }
  }

  return {
    title: stringValue(source.title, fallback.title, treeViewLimits.titleLength),
    nodes
  };
}

export function getTreeViewData(metadata: unknown) {
  return normalizeTreeViewData(recordValue(parseMetadata(metadata).treeView));
}

function getChildren(data: TreeViewData, parentId: string | null) {
  return data.nodes.filter((node) => node.parentId === parentId);
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

function renderTreeBranch(data: TreeViewData, parentId: string | null): string {
  const children = getChildren(data, parentId);
  if (!children.length) return "";
  const items = children.map((node) => {
    const descendants = renderTreeBranch(data, node.id);
    const marker = descendants ? '<span class="rendered-treeview-chevron" aria-hidden="true">⌄</span>' : '<span class="rendered-treeview-leaf" aria-hidden="true">•</span>';
    return `<li class="rendered-treeview-node"><div>${marker}<span>${escapeHtml(node.title || "Untitled item")}</span></div>${descendants}</li>`;
  }).join("");
  return `<ul class="rendered-treeview-branch">${items}</ul>`;
}

function getNodePath(data: TreeViewData, node: TreeViewNode) {
  const labels = [node.title || "Untitled item"];
  const byId = new Map(data.nodes.map((candidate) => [candidate.id, candidate]));
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
  const lines = [data.title];
  const visit = (parentId: string | null, depth: number) => {
    for (const node of getChildren(data, parentId)) {
      lines.push(`${"  ".repeat(depth)}- ${node.title}`);
      if (node.note) lines.push(`${"  ".repeat(depth + 1)}${node.note}`);
      visit(node.id, depth + 1);
    }
  };
  visit(null, 0);
  return lines.filter(Boolean).join("\n").slice(0, 20_000);
}

export function renderTreeViewHtml(metadata: unknown) {
  const data = getTreeViewData(metadata);
  const tree = renderTreeBranch(data, null) || '<div class="rendered-treeview-empty">No items yet.</div>';
  const notes = data.nodes
    .filter((node) => node.note.trim())
    .map((node) => `<article class="rendered-treeview-note"><header><strong>${escapeHtml(node.title || "Untitled item")}</strong><small>${escapeHtml(getNodePath(data, node))}</small></header><div>${noteHtml(node.note)}</div></article>`)
    .join("") || '<div class="rendered-treeview-empty-note">No item memos yet.</div>';

  return `<section class="rendered-treeview"><header><h3>${escapeHtml(data.title || "Tree view")}</h3><span>Tree view · ${data.nodes.length} items</span></header><div class="rendered-treeview-layout"><div class="rendered-treeview-tree"><strong>Structure</strong>${tree}</div><div class="rendered-treeview-notes"><strong>Memos</strong>${notes}</div></div></section>`;
}
