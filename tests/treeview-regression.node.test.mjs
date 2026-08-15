import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getTreeViewData,
  normalizeTreeViewData,
  renderTreeViewHtml,
  summarizeTreeViewData
} from "../src/lib/treeview.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("tree view keeps a flat parent-linked hierarchy with per-node memos", () => {
  const data = normalizeTreeViewData({
    title: "Release plan",
    nodes: [
      { id: "root", parentId: null, title: "Release", note: "Top-level memo", expanded: true },
      { id: "design", parentId: "root", title: "Design", note: "Review flows", expanded: true },
      { id: "qa", parentId: "root", title: "QA", note: "Regression pass", expanded: false }
    ]
  });

  assert.equal(data.nodes.length, 3);
  assert.equal(data.nodes[1].parentId, "root");
  assert.equal(data.nodes[2].note, "Regression pass");
  assert.match(summarizeTreeViewData(data), /  - Design\n    Review flows/);
});

test("tree view normalization fails safe on missing parents and parent cycles", () => {
  const missingParent = normalizeTreeViewData({
    title: "Tree",
    nodes: [{ id: "child", parentId: "missing", title: "Child", note: "", expanded: true }]
  });
  assert.equal(missingParent.nodes[0].parentId, null);

  const cycle = normalizeTreeViewData({
    title: "Tree",
    nodes: [
      { id: "a", parentId: "b", title: "A", note: "", expanded: true },
      { id: "b", parentId: "a", title: "B", note: "", expanded: true }
    ]
  });
  assert.ok(cycle.nodes.some((node) => node.parentId === null));
});

test("tree view metadata extraction and static rendering escape note content", () => {
  const metadata = {
    treeView: {
      title: "Outline",
      nodes: [{ id: "root", parentId: null, title: "Root <script>", note: "<img src=x onerror=alert(1)>", expanded: true }]
    }
  };
  const data = getTreeViewData(metadata);
  assert.equal(data.nodes[0].title, "Root <script>");
  const html = renderTreeViewHtml(metadata);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.match(html, /Root &lt;script&gt;/);
});

test("tree view is wired through UI, accessibility, collaboration, backup, and migration paths", async () => {
  const [app, clientModule, css, collaboration, transfer, schema, migration, i18n] = await Promise.all([
    read("public/app.js"),
    read("public/treeview-block.js"),
    read("public/styles.css"),
    read("public/collaboration.js"),
    read("src/lib/data-transfer.ts"),
    read("src/utils/schemas.ts"),
    read("migrations/054_blocks_treeview_type.sql"),
    read("public/i18n.js")
  ]);

  assert.match(app, /type: "TREEVIEW", command: "\/tree"/);
  assert.match(app, /createTreeViewEditor/);
  assert.match(app, /metadata\.treeView = treeView/);
  assert.match(clientModule, /setAttribute\("role", "tree"\)/);
  assert.match(clientModule, /setAttribute\("role", "treeitem"\)/);
  assert.match(clientModule, /event\.key === "ArrowRight"/);
  assert.match(clientModule, /event\.key === "ArrowLeft"/);
  assert.match(clientModule, /treeview-add-child/);
  assert.match(clientModule, /aria-posinset/);
  assert.match(clientModule, /aria-setsize/);
  assert.match(clientModule, /treeview-node-toggle-icon/);
  assert.match(css, /\.treeview-layout[\s\S]*border: 1px solid var\(--treeview-line\)/);
  assert.match(css, /\.treeview-block-editor[\s\S]*background: transparent/);
  assert.match(css, /\.treeview-node-group > \.treeview-node-shell::before/);
  assert.match(css, /\.treeview-node-label[\s\S]*justify-content: flex-start/);
  assert.match(css, /\.treeview-node-actions[\s\S]*position: absolute/);
  assert.match(collaboration, /"TREEVIEW"/);
  assert.match(transfer, /"DATABASE", "TREEVIEW", "TIMETABLE"/);
  assert.match(schema, /"DATABASE",\s*"TREEVIEW",\s*"TIMETABLE"/);
  assert.match(migration, /'DATABASE', 'TREEVIEW', 'TIMETABLE'/);
  assert.doesNotMatch(migration, /\b(?:DELETE|DROP|TRUNCATE|UPDATE\s+blocks)\b/i);
  assert.match(i18n, /blocks\.types\.TREEVIEW/);
  assert.match(i18n, /트리뷰/);
});
