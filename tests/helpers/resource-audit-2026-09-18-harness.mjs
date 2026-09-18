import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

export const root = new URL("../../", import.meta.url);
export const baseline = JSON.parse(readFileSync(new URL("tests/fixtures/resource-audit-2026-09-18-baseline.json", root), "utf8"));
export function source(path, original = false) {
  return (original ? baseline.files[path].source : readFileSync(new URL(path, root), "utf8")).replace(/\r\n/g, "\n");
}
export function section(text, start, end, from = 0) {
  const a = text.indexOf(start, from);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Missing source boundary: ${start} / ${end}`);
  return text.slice(a, b);
}
export function cycleSource(original = false) {
  return section(source("src/routes/block.routes.ts", original), "function assertReorderDoesNotCreateCycle(", "function collectBlockSubtreeRows");
}
export function reorderSource(original = false) {
  const text = source("src/routes/block.routes.ts", original);
  const route = text.indexOf('blockRouter.post(\n  "/pages/:pageId/blocks/reorder"');
  if (route < 0) throw new Error("Missing reorder route");
  return section(text, "        const rowById = new Map(hierarchyRows.map", "\n        for (const item of items) {\n          const result", route);
}
const http = source("src/lib/http.ts");
const errorClass = stripTypeScriptTypes(section(http, "export class ApiError", "export ", http.indexOf("export class ApiError")).replace("export class", "class"));
export const ApiError = new Function(`${errorClass}\nreturn ApiError;`)();
export function collections(metrics) {
  return {
    Map: class extends Map {
      constructor(...args) { super(...args); metrics.maps = (metrics.maps ?? 0) + 1; }
      get(key) { metrics.mapGets = (metrics.mapGets ?? 0) + 1; return super.get(key); }
      has(key) { metrics.mapHas = (metrics.mapHas ?? 0) + 1; return super.has(key); }
    },
    Set: class extends Set {
      constructor(...args) { super(...args); metrics.sets = (metrics.sets ?? 0) + 1; }
    }
  };
}
export function cycle(original = false, metrics = null) {
  const types = metrics ? collections(metrics) : { Map, Set };
  return new Function("ApiError", "Map", "Set", stripTypeScriptTypes(cycleSource(original)) + "\nreturn assertReorderDoesNotCreateCycle;")(ApiError, types.Map, types.Set);
}
export function reorder(original = false, metrics = null) {
  const types = metrics ? collections(metrics) : { Map, Set };
  const fn = new Function("hierarchyRows", "items", "ApiError", "Map", "Set", stripTypeScriptTypes(cycleSource(original) + reorderSource(original)) + "\nreturn true;");
  return (rows, items) => fn(rows, items, ApiError, types.Map, types.Set);
}
export function outcome(fn, ...args) {
  try { return { ok: true, value: fn(...args) }; }
  catch (error) { if (!(error instanceof ApiError)) throw error; return { ok: false, status: error.statusCode, code: error.code, message: error.message }; }
}
export function lua(original = false, metrics = null) {
  let text = section(source("public/code-highlighting.js", original), "const languageDefinitions", "function highlightSource(");
  text = text.replace(/export /g, "");
  if (metrics) text = text.replace("function escapeHighlightedHtml(value) {", 'function escapeHighlightedHtml(value) { metrics.escapes = (metrics.escapes ?? 0) + 1;');
  return new Function("BLOCK_MARKDOWN_MAX_LENGTH", "metrics", text + "\nreturn { highlightLuaSource, highlightResourceLimits };")(20_000, metrics);
}
export function keyboardSource(original = false) {
  return section(source("public/treeview-block.js", original), '  tree.addEventListener("keydown", (event) => {', "\n  return editor;");
}
export function keyboard(original = false, metrics = {}) {
  const data = { nodes: [{ id: "node", parentId: null, expanded: false }] };
  const label = { dataset: { treeviewNodeId: "node" }, closest: () => null, setAttribute() {} };
  let handler;
  const tree = { contains: () => true, addEventListener: (_type, fn) => { handler = fn; } };
  new Function("tree", "data", "getNode", "getVisibleNodeIds", "getChildren", "syncSelection", "focusNode", "editor", "isReadOnly", "onDirty", "syncNodeToggleButton", 'let selectedNodeId = null;\n' + keyboardSource(original))(
    tree, data,
    () => { metrics.nodeLookups = (metrics.nodeLookups ?? 0) + 1; return data.nodes[0]; },
    () => { metrics.visibleTraversals = (metrics.visibleTraversals ?? 0) + 1; return ["node"]; },
    () => [], () => {}, () => {}, {}, () => false, () => {}, () => {}
  );
  return (key) => { let prevented = false; handler({ key, target: { closest: () => label }, preventDefault() { prevented = true; } }); return prevented; };
}
export function chain(size) {
  return Array.from({ length: size }, (_, i) => ({ id: `b${i}`, parent_block_id: i ? `b${i - 1}` : null, edit_version: 1 }));
}
export function multiParent(size = 2_000, count = 500) {
  const rows = Array.from({ length: size }, (_, i) => ({ id: `b${i}`, parent_block_id: i < count ? `b${count + i}` : null, edit_version: 1 }));
  const items = rows.slice(0, count).map(row => ({ id: row.id, expectedVersion: 1, sortOrder: 0 }));
  return { rows, items };
}
export function random(seed = 0x18a09) {
  let s = seed >>> 0;
  return (max) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % max; };
}
