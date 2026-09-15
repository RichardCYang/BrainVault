// Dependency-free harness. App excerpts are taken verbatim from the current
// source; surrounding UI callbacks are explicit spies, not a full app/server.
import { readFileSync } from "node:fs";
import { requirePageTitleWithinLimit } from "../../public/editor-content-limits.js";

export const baseline = JSON.parse(readFileSync(new URL("../fixtures/resource-efficiency-baseline.json", import.meta.url), "utf8"));
export const currentSources = {
  app: readFileSync(new URL("../../public/app.js", import.meta.url), "utf8"),
  draft: readFileSync(new URL("../../public/draft-store.js", import.meta.url), "utf8"),
  history: readFileSync(new URL("../../public/editor-history.js", import.meta.url), "utf8")
};
export function extractFunction(source, name) {
  const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, "m"));
  if (!match) throw new Error(`Cannot extract ${name}`);
  return match[0];
}
export function getAppParts(mode = "current") {
  return mode === "baseline" ? { ...baseline.app } : Object.fromEntries(
    Object.keys(baseline.app).map(name => [name, extractFunction(currentSources.app, name)])
  );
}
export function makeAppHarness(mode = "current", { instrument = false } = {}) {
  const parts = getAppParts(mode);
  if (instrument) {
    parts.getBlockById = parts.getBlockById.replace("for (const block of blocks) {", "for (const block of blocks) { metrics.previousSearchVisits += 1;");
    parts.buildCollaborationBlockTree = parts.buildCollaborationBlockTree.replace("if (!previousById.has(block.id))", "metrics.previousIndexVisits += 1; if (!previousById.has(block.id))");
    parts.getCollaborationBlockSignature = parts.getCollaborationBlockSignature.replace("{", "{ metrics.signatureCalls += 1;");
  }
  const factory = new Function("requirePageTitleWithinLimit", `
    const metrics = { previousSearchVisits: 0, previousIndexVisits: 0, signatureCalls: 0 };
    const state = { selectedPage: null, workspaceView: "page", allPages: [], pages: [], applyingCollaborationSnapshot: false };
    const events = [];
    const frames = [];
    const elements = { pageTitle: { value: "" } };
    let collaborative = true;
    let renderError = null;
    const isCollaborativePage = () => collaborative;
    const getPageSummaryLookup = pages => new Map(pages.map(page => [page.id, page]));
    const syncBeforeUnloadProtection = () => events.push("beforeunload");
    const pageEditorHistory = { clear: pageId => events.push(["clearHistory", pageId]) };
    const updateInputValuePreservingSelection = (input, title) => { input.value = title; events.push(["title", title]); };
    const renderPageHeader = page => events.push(["header", page.id]);
    const syncPageTitleSummaryPresentation = (id, title) => events.push(["summary", id, title]);
    const renderCollaborationPresence = () => events.push("presence");
    const captureCollaborationEditorFocus = () => { events.push("captureFocus"); return { blockId: "focus-block", start: 2, end: 4 }; };
    const restoreCollaborationEditorFocus = focus => events.push(["restoreFocus", focus]);
    const renderSelectedPage = () => { events.push(["render", state.applyingCollaborationSnapshot]); if (renderError) throw renderError; };
    const requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    ${Object.values(parts).join("\n")}
    return {
      state, events, metrics, elements, build: buildCollaborationBlockTree, apply: applyCollaborationSnapshot,
      signature: getCollaborationBlockSignature, flatten: flattenBlocks,
      setCollaborative(value) { collaborative = value; },
      setRenderError(error) { renderError = error; },
      flushFrames() { while (frames.length) frames.shift()(); },
      resetMetrics() { for (const key of Object.keys(metrics)) metrics[key] = 0; }
    };
  `);
  return factory(requirePageTitleWithinLimit);
}
export function makeDraftNormalizer(mode = "current", { instrument = false } = {}) {
  let source = mode === "baseline" ? baseline.draftPrelude : currentSources.draft
    .slice(0, currentSources.draft.indexOf("function normalizeRecord("))
    .replace('import { inspectStorageKeys } from "./storage-snapshot.js";', "");
  if (instrument) source = source
    .replace("orderedIds.includes(id)", "countedIncludes(orderedIds, id)")
    .replace("orderedIdSet.has(id)", "(metrics.setLookups += 1, orderedIdSet.has(id))");
  return new Function(`
    const metrics = { includesComparisons: 0, setLookups: 0 };
    function countedIncludes(values, target) {
      for (const value of values) { metrics.includesComparisons += 1; if (value === target) return true; }
      return false;
    }
    ${source}
    return { normalize: normalizeBlockOrderDraft, metrics };
  `)();
}
export function makeHistoryFactory(mode = "current", { clone = globalThis.structuredClone } = {}) {
  const source = (mode === "baseline" ? baseline.editorHistory : currentSources.history).replace(/^export /gm, "");
  return new Function("structuredClone", "TextEncoder", `${source}\nreturn createEditorHistory;`)(clone, globalThis.TextEncoder);
}
export function makeBlocks(count, { nested = false } = {}) {
  const roots = [];
  const flat = [];
  for (let index = 0; index < count; index += 1) {
    const parent = nested && index % 8 !== 0 ? flat[index - (index % 8)] : null;
    const block = {
      id: `block_${String(index).padStart(6, "0")}`, type: "MARKDOWN", markdown: `한글 note ${index}`,
      version: index + 2, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z",
      parentBlockId: parent?.id ?? null, sortOrder: parent ? parent.children.length : roots.length,
      metadata: { label: `m${index}`, nested: { safe: true } }, children: []
    };
    if (parent) parent.children.push(block); else roots.push(block);
    flat.push(block);
  }
  return { roots, flat: flat.map(({ children, ...block }) => ({ ...block, version: 1 })) };
}
export function makeOrder(count) {
  const previousIds = Array.from({ length: count }, (_, i) => `block_${String(i).padStart(6, "0")}`);
  const orderedIds = [...previousIds].reverse();
  return {
    parentBlockId: null, mutationId: "order_resource_audit", orderedIds, previousIds, updatedAt: 1_789_459_200_000,
    items: orderedIds.map((id, index) => ({ id, sortOrder: index, parentBlockId: null, expectedVersion: index + 1 }))
  };
}
export function randomGenerator(seed) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 2 ** 32; };
}
