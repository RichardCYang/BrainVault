import { formatNumber, t } from "./i18n.js";

export const treeViewLimits = Object.freeze({
  titleLength: 120,
  nodes: 300,
  nodeTitleLength: 300,
  noteLength: 8000,
  idLength: 64
});

function createId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`.slice(0, treeViewLimits.idLength);
}

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value, fallback, maxLength) {
  return (typeof value === "string" ? value : fallback).slice(0, maxLength);
}

function safeId(value, fallback) {
  const id = typeof value === "string" ? value.trim().slice(0, treeViewLimits.idLength) : "";
  return id || fallback;
}

function uniqueId(requested, seen, fallbackPrefix) {
  let id = requested;
  let attempt = 1;
  while (seen.has(id)) {
    id = `${fallbackPrefix}-${attempt}`.slice(0, treeViewLimits.idLength);
    attempt += 1;
  }
  seen.add(id);
  return id;
}

function parentWouldCycle(nodeId, parentId, parentById) {
  const seen = new Set([nodeId]);
  let current = parentId;
  while (current) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = parentById.get(current) ?? null;
  }
  return false;
}

export function createDefaultTreeViewData() {
  return {
    title: t("treeview.defaultTitle"),
    nodes: [
      {
        id: createId("tree-node"),
        parentId: null,
        title: t("treeview.defaultNodeTitle", { number: formatNumber(1) }),
        note: "",
        expanded: true
      }
    ]
  };
}

export function normalizeTreeViewData(value) {
  const source = recordValue(value) ?? {};
  const fallback = createDefaultTreeViewData();
  const sources = Array.isArray(source.nodes) ? source.nodes.slice(0, treeViewLimits.nodes) : fallback.nodes;
  const seen = new Set();
  const nodes = sources
    .map(recordValue)
    .filter(Boolean)
    .map((node, index) => ({
      id: uniqueId(safeId(node.id, createId("tree-node")), seen, `tree-node-${index + 1}`),
      parentId: typeof node.parentId === "string" ? node.parentId.trim().slice(0, treeViewLimits.idLength) || null : null,
      title: stringValue(
        node.title,
        t("treeview.defaultNodeTitle", { number: formatNumber(index + 1) }),
        treeViewLimits.nodeTitleLength
      ),
      note: stringValue(node.note, "", treeViewLimits.noteLength),
      expanded: node.expanded !== false
    }));

  const ids = new Set(nodes.map((node) => node.id));
  nodes.forEach((node) => {
    if (node.parentId === node.id || (node.parentId && !ids.has(node.parentId))) node.parentId = null;
  });

  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  nodes.forEach((node) => {
    if (node.parentId && parentWouldCycle(node.id, node.parentId, parentById)) {
      node.parentId = null;
      parentById.set(node.id, null);
    }
  });

  return {
    title: stringValue(source.title, fallback.title, treeViewLimits.titleLength),
    nodes
  };
}

function getChildren(data, parentId) {
  return data.nodes.filter((node) => node.parentId === parentId);
}

function getNode(data, nodeId) {
  return data.nodes.find((node) => node.id === nodeId) ?? null;
}

function getNodePath(data, nodeId) {
  const labels = [];
  const seen = new Set();
  let current = getNode(data, nodeId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    labels.unshift(current.title || t("treeview.defaultNodeTitle", { number: formatNumber(labels.length + 1) }));
    current = current.parentId ? getNode(data, current.parentId) : null;
  }
  return labels.join(" / ");
}

function getVisibleNodeIds(data) {
  const visible = [];
  const visit = (parentId) => {
    for (const node of getChildren(data, parentId)) {
      visible.push(node.id);
      if (node.expanded) visit(node.id);
    }
  };
  visit(null);
  return visible;
}

function focusNode(editor, nodeId) {
  requestAnimationFrame(() => {
    editor.querySelector(`[data-action="treeview-select-node"][data-treeview-node-id="${CSS.escape(nodeId)}"]`)?.focus();
  });
}

function makeActionButton(action, nodeId, label, text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "treeview-node-action";
  button.dataset.action = action;
  button.dataset.treeviewNodeId = nodeId;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  return button;
}

function syncNodeToggleButton(button, expanded) {
  if (!button) return;
  button.classList.toggle("is-expanded", expanded);
  button.setAttribute("aria-expanded", String(expanded));
  button.title = t(expanded ? "treeview.collapseNode" : "treeview.expandNode");
  button.setAttribute("aria-label", button.title);
}

export function createTreeViewEditor(row, value, options = {}) {
  const { onDirty, selectedNodeId: requestedSelectedNodeId = null } = options;
  const data = normalizeTreeViewData(value);
  let selectedNodeId = data.nodes.some((node) => node.id === requestedSelectedNodeId)
    ? requestedSelectedNodeId
    : data.nodes[0]?.id ?? null;
  const isReadOnly = () => row?.getAttribute("aria-readonly") === "true" || row?.classList.contains("is-read-only");

  const editor = document.createElement("div");
  editor.className = "treeview-block-editor";
  editor.treeViewData = data;
  editor.treeViewSelectedNodeId = selectedNodeId;

  const heading = document.createElement("div");
  heading.className = "treeview-heading";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "treeview-title-input";
  titleInput.maxLength = treeViewLimits.titleLength;
  titleInput.value = data.title;
  titleInput.placeholder = t("treeview.titlePlaceholder");
  titleInput.setAttribute("aria-label", t("treeview.titleAria"));

  const count = document.createElement("span");
  count.className = "treeview-count";
  count.textContent = t("treeview.nodeCount", { count: formatNumber(data.nodes.length) });

  const addRoot = document.createElement("button");
  addRoot.type = "button";
  addRoot.className = "treeview-add-root";
  addRoot.dataset.action = "treeview-add-root";
  addRoot.disabled = data.nodes.length >= treeViewLimits.nodes;
  addRoot.textContent = `＋ ${t("treeview.addRoot")}`;
  addRoot.setAttribute("aria-label", t("treeview.addRoot"));
  heading.append(titleInput, count, addRoot);

  const layout = document.createElement("div");
  layout.className = "treeview-layout";

  const treePane = document.createElement("section");
  treePane.className = "treeview-tree-pane";
  treePane.setAttribute("aria-label", t("treeview.structure"));

  const treePaneHeading = document.createElement("div");
  treePaneHeading.className = "treeview-pane-heading";
  const treePaneLabel = document.createElement("strong");
  treePaneLabel.textContent = t("treeview.structure");
  treePaneHeading.append(treePaneLabel);

  const tree = document.createElement("div");
  tree.className = "treeview-tree";
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", t("treeview.structure"));

  const emptyTree = document.createElement("div");
  emptyTree.className = "treeview-empty";
  emptyTree.hidden = data.nodes.length > 0;
  emptyTree.textContent = t("treeview.emptyState");

  const renderBranch = (parentId, level, host) => {
    const children = getChildren(data, parentId);
    for (const [childIndex, node] of children.entries()) {
      const shell = document.createElement("div");
      shell.className = "treeview-node-shell";
      shell.dataset.treeviewNodeId = node.id;

      const rowElement = document.createElement("div");
      rowElement.className = "treeview-node-row";
      rowElement.classList.toggle("is-selected", node.id === selectedNodeId);

      const nodeChildren = getChildren(data, node.id);
      if (nodeChildren.length) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "treeview-node-toggle";
        toggle.dataset.action = "treeview-toggle-node";
        toggle.dataset.treeviewNodeId = node.id;
        toggle.dataset.readModeAllowed = "true";
        const toggleIcon = document.createElement("span");
        toggleIcon.className = "treeview-node-toggle-icon";
        toggleIcon.setAttribute("aria-hidden", "true");
        toggle.append(toggleIcon);
        syncNodeToggleButton(toggle, node.expanded);
        rowElement.append(toggle);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "treeview-node-toggle-spacer";
        spacer.setAttribute("aria-hidden", "true");
        rowElement.append(spacer);
      }

      const label = document.createElement("button");
      label.type = "button";
      label.className = "treeview-node-label";
      label.dataset.action = "treeview-select-node";
      label.dataset.treeviewNodeId = node.id;
      label.dataset.readModeAllowed = "true";
      label.setAttribute("role", "treeitem");
      label.setAttribute("aria-level", String(level));
      label.setAttribute("aria-posinset", String(childIndex + 1));
      label.setAttribute("aria-setsize", String(children.length));
      label.setAttribute("aria-selected", String(node.id === selectedNodeId));
      if (nodeChildren.length) label.setAttribute("aria-expanded", String(node.expanded));
      label.tabIndex = node.id === selectedNodeId || (!selectedNodeId && data.nodes[0]?.id === node.id) ? 0 : -1;
      const dot = document.createElement("span");
      dot.className = "treeview-node-dot";
      dot.setAttribute("aria-hidden", "true");
      const labelText = document.createElement("span");
      labelText.className = "treeview-node-label-text";
      labelText.textContent = node.title || t("treeview.defaultNodeTitle", { number: formatNumber(1) });
      label.append(dot, labelText);

      const actions = document.createElement("div");
      actions.className = "treeview-node-actions";
      const siblings = getChildren(data, node.parentId);
      const siblingIndex = siblings.findIndex((candidate) => candidate.id === node.id);
      const addChild = makeActionButton("treeview-add-child", node.id, t("treeview.addChild"), "+");
      addChild.disabled = data.nodes.length >= treeViewLimits.nodes;
      const moveUp = makeActionButton("treeview-move-up", node.id, t("treeview.moveUp"), "↑");
      moveUp.disabled = siblingIndex <= 0;
      const moveDown = makeActionButton("treeview-move-down", node.id, t("treeview.moveDown"), "↓");
      moveDown.disabled = siblingIndex < 0 || siblingIndex >= siblings.length - 1;
      const indent = makeActionButton("treeview-indent", node.id, t("treeview.indent"), "→");
      indent.disabled = siblingIndex <= 0;
      const outdent = makeActionButton("treeview-outdent", node.id, t("treeview.outdent"), "←");
      outdent.disabled = !node.parentId;
      const remove = makeActionButton("treeview-delete-node", node.id, t("treeview.deleteNode"), "⌫");
      remove.classList.add("treeview-node-delete");
      actions.append(addChild, moveUp, moveDown, indent, outdent, remove);
      rowElement.append(label, actions);
      shell.append(rowElement);

      if (nodeChildren.length) {
        const group = document.createElement("div");
        group.className = "treeview-node-group";
        group.setAttribute("role", "group");
        group.hidden = !node.expanded;
        renderBranch(node.id, level + 1, group);
        shell.append(group);
      }
      host.append(shell);
    }
  };
  renderBranch(null, 1, tree);
  treePane.append(treePaneHeading, tree, emptyTree);

  const notePane = document.createElement("section");
  notePane.className = "treeview-note-pane";
  notePane.setAttribute("aria-label", t("treeview.memo"));

  const noteHeading = document.createElement("div");
  noteHeading.className = "treeview-note-heading";
  const noteLabel = document.createElement("strong");
  noteLabel.textContent = t("treeview.memo");
  const path = document.createElement("span");
  path.className = "treeview-note-path";
  noteHeading.append(noteLabel, path);

  const nodeTitleInput = document.createElement("input");
  nodeTitleInput.type = "text";
  nodeTitleInput.className = "treeview-note-title-input";
  nodeTitleInput.maxLength = treeViewLimits.nodeTitleLength;
  nodeTitleInput.placeholder = t("treeview.nodeTitlePlaceholder");
  nodeTitleInput.setAttribute("aria-label", t("treeview.nodeTitleAria"));

  const noteInput = document.createElement("textarea");
  noteInput.className = "treeview-note-input";
  noteInput.rows = 9;
  noteInput.maxLength = treeViewLimits.noteLength;
  noteInput.placeholder = t("treeview.notePlaceholder");
  noteInput.setAttribute("aria-label", t("treeview.noteAria"));

  const noSelection = document.createElement("div");
  noSelection.className = "treeview-no-selection";
  noSelection.textContent = t("treeview.noSelection");

  notePane.append(noteHeading, nodeTitleInput, noteInput, noSelection);
  layout.append(treePane, notePane);
  editor.append(heading, layout);

  const syncSelection = () => {
    selectedNodeId = data.nodes.some((node) => node.id === selectedNodeId) ? selectedNodeId : data.nodes[0]?.id ?? null;
    editor.treeViewSelectedNodeId = selectedNodeId;
    for (const label of editor.querySelectorAll('[data-action="treeview-select-node"]')) {
      const selected = label.dataset.treeviewNodeId === selectedNodeId;
      label.setAttribute("aria-selected", String(selected));
      label.tabIndex = selected ? 0 : -1;
      label.closest(".treeview-node-row")?.classList.toggle("is-selected", selected);
    }
    const selectedNode = selectedNodeId ? getNode(data, selectedNodeId) : null;
    nodeTitleInput.hidden = !selectedNode;
    noteInput.hidden = !selectedNode;
    noSelection.hidden = Boolean(selectedNode);
    path.textContent = selectedNode ? getNodePath(data, selectedNode.id) : "";
    if (selectedNode) {
      nodeTitleInput.value = selectedNode.title;
      noteInput.value = selectedNode.note;
      noteInput.setAttribute("aria-label", t("treeview.memoFor", { title: selectedNode.title || t("treeview.memo") }));
    }
  };
  syncSelection();

  const replaceEditor = ({ focusId = selectedNodeId, focusNote = false } = {}) => {
    const replacement = createTreeViewEditor(row, data, {
      onDirty,
      selectedNodeId: focusId
    });
    editor.replaceWith(replacement);
    onDirty?.();
    requestAnimationFrame(() => {
      if (focusNote) replacement.querySelector(".treeview-note-title-input")?.focus();
      else if (focusId) focusNode(replacement, focusId);
    });
    return replacement;
  };

  titleInput.addEventListener("input", () => {
    if (isReadOnly()) return;
    data.title = titleInput.value.slice(0, treeViewLimits.titleLength);
    editor.treeViewData = data;
    onDirty?.();
  });

  nodeTitleInput.addEventListener("input", () => {
    if (isReadOnly() || !selectedNodeId) return;
    const node = getNode(data, selectedNodeId);
    if (!node) return;
    node.title = nodeTitleInput.value.slice(0, treeViewLimits.nodeTitleLength);
    const label = editor.querySelector(`[data-action="treeview-select-node"][data-treeview-node-id="${CSS.escape(node.id)}"] .treeview-node-label-text`);
    if (label) label.textContent = node.title || t("treeview.nodeTitlePlaceholder");
    path.textContent = getNodePath(data, node.id);
    editor.treeViewData = data;
    onDirty?.();
  });

  noteInput.addEventListener("input", () => {
    if (isReadOnly() || !selectedNodeId) return;
    const node = getNode(data, selectedNodeId);
    if (!node) return;
    node.note = noteInput.value.slice(0, treeViewLimits.noteLength);
    editor.treeViewData = data;
    onDirty?.();
  });

  editor.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || !editor.contains(button)) return;
    const action = button.dataset.action;
    const nodeId = button.dataset.treeviewNodeId ?? null;

    if (action === "treeview-select-node" && nodeId && getNode(data, nodeId)) {
      selectedNodeId = nodeId;
      syncSelection();
      return;
    }

    if (action === "treeview-toggle-node" && nodeId) {
      const node = getNode(data, nodeId);
      if (!node || !getChildren(data, node.id).length) return;
      node.expanded = !node.expanded;
      syncNodeToggleButton(button, node.expanded);
      const shell = button.closest(".treeview-node-shell");
      const group = shell?.querySelector(":scope > .treeview-node-group");
      if (group) group.hidden = !node.expanded;
      const label = shell?.querySelector(':scope > .treeview-node-row [data-action="treeview-select-node"]');
      label?.setAttribute("aria-expanded", String(node.expanded));
      editor.treeViewData = data;
      if (!isReadOnly()) onDirty?.();
      return;
    }

    if (isReadOnly()) return;

    if (action === "treeview-add-root") {
      if (data.nodes.length >= treeViewLimits.nodes) return;
      const node = {
        id: createId("tree-node"),
        parentId: null,
        title: t("treeview.defaultNodeTitle", { number: formatNumber(data.nodes.length + 1) }),
        note: "",
        expanded: true
      };
      data.nodes.push(node);
      selectedNodeId = node.id;
      replaceEditor({ focusId: node.id, focusNote: true });
      return;
    }

    if (!nodeId) return;
    const node = getNode(data, nodeId);
    if (!node) return;
    const siblings = getChildren(data, node.parentId);
    const siblingIndex = siblings.findIndex((candidate) => candidate.id === node.id);

    if (action === "treeview-add-child") {
      if (data.nodes.length >= treeViewLimits.nodes) return;
      node.expanded = true;
      const child = {
        id: createId("tree-node"),
        parentId: node.id,
        title: t("treeview.defaultNodeTitle", { number: formatNumber(data.nodes.length + 1) }),
        note: "",
        expanded: true
      };
      data.nodes.push(child);
      selectedNodeId = child.id;
      replaceEditor({ focusId: child.id, focusNote: true });
      return;
    }

    if (action === "treeview-move-up" && siblingIndex > 0) {
      const previous = siblings[siblingIndex - 1];
      const nodeIndex = data.nodes.findIndex((candidate) => candidate.id === node.id);
      const previousIndex = data.nodes.findIndex((candidate) => candidate.id === previous.id);
      [data.nodes[nodeIndex], data.nodes[previousIndex]] = [data.nodes[previousIndex], data.nodes[nodeIndex]];
      replaceEditor({ focusId: node.id });
      return;
    }

    if (action === "treeview-move-down" && siblingIndex >= 0 && siblingIndex < siblings.length - 1) {
      const next = siblings[siblingIndex + 1];
      const nodeIndex = data.nodes.findIndex((candidate) => candidate.id === node.id);
      const nextIndex = data.nodes.findIndex((candidate) => candidate.id === next.id);
      [data.nodes[nodeIndex], data.nodes[nextIndex]] = [data.nodes[nextIndex], data.nodes[nodeIndex]];
      replaceEditor({ focusId: node.id });
      return;
    }

    if (action === "treeview-indent" && siblingIndex > 0) {
      const previous = siblings[siblingIndex - 1];
      node.parentId = previous.id;
      previous.expanded = true;
      replaceEditor({ focusId: node.id });
      return;
    }

    if (action === "treeview-outdent" && node.parentId) {
      const parent = getNode(data, node.parentId);
      node.parentId = parent?.parentId ?? null;
      replaceEditor({ focusId: node.id });
      return;
    }

    if (action === "treeview-delete-node") {
      const parentId = node.parentId;
      for (const child of data.nodes) {
        if (child.parentId === node.id) child.parentId = parentId;
      }
      data.nodes = data.nodes.filter((candidate) => candidate.id !== node.id);
      editor.treeViewData = data;
      const fallbackId = parentId && getNode(data, parentId)
        ? parentId
        : data.nodes[Math.min(data.nodes.length - 1, Math.max(0, data.nodes.findIndex((candidate) => candidate.parentId === parentId)))]?.id ?? null;
      selectedNodeId = fallbackId;
      replaceEditor({ focusId: fallbackId });
    }
  });

  tree.addEventListener("keydown", (event) => {
    const label = event.target.closest('[data-action="treeview-select-node"]');
    if (!label || !tree.contains(label)) return;
    const nodeId = label.dataset.treeviewNodeId;
    const node = getNode(data, nodeId);
    if (!node) return;
    const visible = getVisibleNodeIds(data);
    const index = visible.indexOf(node.id);
    let focusId = null;

    if (event.key === "ArrowDown") focusId = visible[index + 1] ?? null;
    else if (event.key === "ArrowUp") focusId = visible[index - 1] ?? null;
    else if (event.key === "Home") focusId = visible[0] ?? null;
    else if (event.key === "End") focusId = visible.at(-1) ?? null;
    else if (event.key === "ArrowRight") {
      const children = getChildren(data, node.id);
      if (children.length && !node.expanded) {
        node.expanded = true;
        const shell = label.closest(".treeview-node-shell");
        const group = shell?.querySelector(":scope > .treeview-node-group");
        if (group) group.hidden = false;
        const toggle = shell?.querySelector(':scope > .treeview-node-row [data-action="treeview-toggle-node"]');
        if (toggle) syncNodeToggleButton(toggle, true);
        label.setAttribute("aria-expanded", "true");
        editor.treeViewData = data;
        if (!isReadOnly()) onDirty?.();
        event.preventDefault();
        return;
      }
      focusId = children[0]?.id ?? null;
    } else if (event.key === "ArrowLeft") {
      if (getChildren(data, node.id).length && node.expanded) {
        node.expanded = false;
        const shell = label.closest(".treeview-node-shell");
        const group = shell?.querySelector(":scope > .treeview-node-group");
        if (group) group.hidden = true;
        const toggle = shell?.querySelector(':scope > .treeview-node-row [data-action="treeview-toggle-node"]');
        if (toggle) syncNodeToggleButton(toggle, false);
        label.setAttribute("aria-expanded", "false");
        editor.treeViewData = data;
        if (!isReadOnly()) onDirty?.();
        event.preventDefault();
        return;
      }
      focusId = node.parentId;
    } else if (event.key === "Enter" || event.key === " ") {
      selectedNodeId = node.id;
      syncSelection();
      event.preventDefault();
      return;
    } else {
      return;
    }

    if (focusId) {
      event.preventDefault();
      selectedNodeId = focusId;
      syncSelection();
      focusNode(editor, focusId);
    }
  });

  return editor;
}

export function extractTreeViewData(row) {
  return normalizeTreeViewData(row?.querySelector(".treeview-block-editor")?.treeViewData);
}

export function summarizeTreeViewData(value) {
  const data = normalizeTreeViewData(value);
  const lines = [data.title];
  const visit = (parentId, depth) => {
    for (const node of getChildren(data, parentId)) {
      lines.push(`${"  ".repeat(depth)}- ${node.title}`);
      if (node.note) lines.push(`${"  ".repeat(depth + 1)}${node.note}`);
      visit(node.id, depth + 1);
    }
  };
  visit(null, 0);
  return lines.filter(Boolean).join("\n").slice(0, 20000);
}
