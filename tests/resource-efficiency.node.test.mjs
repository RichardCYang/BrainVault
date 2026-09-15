import assert from "node:assert/strict";
import test from "node:test";
import { createPageDraftStore } from "../public/draft-store.js";
import {
  makeAppHarness, makeDraftNormalizer, makeHistoryFactory, makeBlocks, makeOrder, randomGenerator
} from "./helpers/resource-efficiency-harness.mjs";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
function setPage(harness, blocks = [], title = "Title") {
  harness.state.selectedPage = { id: "page_1", title, blocks };
  harness.state.allPages = [{ id: "page_1", title }, { id: "other", title: "Other" }];
  harness.state.pages = [{ id: "page_1", title }];
}
function compareTrees(roots, incoming) {
  const before = makeAppHarness("baseline");
  const after = makeAppHarness();
  setPage(before, roots); setPage(after, roots);
  const expected = before.build(incoming);
  const actual = after.build(incoming);
  assert.deepEqual(actual, expected);
  return actual;
}
for (const nested of [false, true]) {
  test(`collaboration old-tree indexing is linear (${nested ? "nested" : "flat"}) and byte-equivalent`, () => {
    const n = 600;
    const { roots, flat } = makeBlocks(n, { nested });
    const old = makeAppHarness("baseline", { instrument: true });
    const current = makeAppHarness("current", { instrument: true });
    setPage(old, roots); setPage(current, roots);
    const expected = old.build(flat);
    const actual = current.build(flat);
    assert.deepEqual(actual, expected);
    assert.equal(old.metrics.previousSearchVisits, n * (n + 1) / 2);
    assert.equal(current.metrics.previousSearchVisits, 0);
    assert.equal(current.metrics.previousIndexVisits, n);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  });
}
test("collaboration indexing preserves versions, timestamps, HTML and attachment metadata without mutating its inputs", () => {
  const roots = deepFreeze([{ id: "attachment", version: 23, createdAt: "old-created", updatedAt: "old-updated", htmlCache: "<p>safe cache</p>", type: "ATTACHMENT", markdown: "a.txt", metadata: { attachment: { id: "asset_1", size: 12 } }, children: [] }]);
  const incoming = deepFreeze([{ id: "attachment", version: 1, createdAt: "new-created", updatedAt: "new-updated", parentBlockId: null, sortOrder: 6, markdown: "b.txt", metadata: { attachment: { id: "asset_1", size: 13 } } }]);
  const result = compareTrees(roots, incoming);
  assert.equal(result[0].version, 23);
  assert.equal(result[0].createdAt, "old-created");
  assert.equal(result[0].updatedAt, "old-updated");
  assert.equal(result[0].htmlCache, "<p>safe cache</p>");
  assert.equal(result[0].markdown, "b.txt");
  assert.equal(roots[0].markdown, "a.txt");
  assert.notStrictEqual(result[0], roots[0]);
});
test("duplicate old IDs retain the first depth-first match; duplicate new IDs retain the first incoming match", () => {
  const roots = [{ id: "parent", children: [{ id: "duplicate", version: 9, children: [] }] }, { id: "duplicate", version: 99, children: [] }];
  const incoming = [{ id: "duplicate", markdown: "first", sortOrder: 2 }, { id: "duplicate", markdown: "second", sortOrder: 1 }, { id: "parent", sortOrder: 0 }];
  const result = compareTrees(roots, incoming);
  assert.equal(result[1].version, 9);
  assert.equal(result[1].markdown, "first");
});
test("snapshot-local indexes do not retain stale page/account versions", () => {
  const h = makeAppHarness();
  const incoming = [{ id: "same_id", version: 1, sortOrder: 0 }];
  setPage(h, [{ id: "same_id", version: 31, privateMarker: "account_a", children: [] }]);
  assert.equal(h.build(incoming)[0].privateMarker, "account_a");
  setPage(h, [{ id: "same_id", version: 7, children: [] }]);
  assert.equal(h.build(incoming)[0].version, 7);
  assert.equal(h.build(incoming)[0].privateMarker, undefined);
  h.state.selectedPage = null;
  assert.equal(h.build(incoming)[0].version, 1);
});
test("empty/invalid snapshots and iterable inputs retain the previous behavior", () => {
  const { roots, flat } = makeBlocks(4);
  for (const input of [undefined, null, [], [null, {}, { id: "" }], new Set(flat)]) compareTrees(roots, input);
  const h = makeAppHarness("current", { instrument: true }); setPage(h, roots);
  assert.deepEqual(h.build([null, {}]), []);
  assert.equal(h.metrics.previousIndexVisits, 0);
});
test("cycle, self-parent, orphan, sort tie, prototype-name IDs and depth-limit behavior are unchanged", () => {
  const edge = [
    { id: "__proto__", parentBlockId: "constructor", sortOrder: 1 },
    { id: "constructor", parentBlockId: "__proto__", sortOrder: 1 },
    { id: "self", parentBlockId: "self", sortOrder: 0 },
    { id: "orphan", parentBlockId: "absent", sortOrder: 1 },
    { id: "toString", parentBlockId: null, sortOrder: 1 }
  ];
  compareTrees([], edge);
  for (const depth of [127, 128, 129, 140]) {
    const input = Array.from({ length: depth + 1 }, (_, i) => ({ id: `d${i}`, parentBlockId: i ? `d${i - 1}` : null, sortOrder: 0 }));
    compareTrees([], input);
  }
  assert.equal({}.polluted, undefined);
});
test("500 deterministic randomized snapshots preserve the exact rebuilt tree", () => {
  const random = randomGenerator(0x42564155);
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const count = 1 + Math.floor(random() * 70);
    const { roots, flat } = makeBlocks(count, { nested: random() > 0.5 });
    const incoming = flat.filter(() => random() > 0.15).map(block => ({ ...block, sortOrder: Math.floor(random() * 7), markdown: random() > 0.5 ? "변경됨" : block.markdown }));
    if (incoming.length && random() > 0.5) incoming.push({ ...incoming[0], markdown: "duplicate ignored" });
    if (random() > 0.5) incoming.push({ id: "new", version: 2, parentBlockId: "missing", sortOrder: 0 });
    compareTrees(roots, incoming);
  }
});
for (const source of ["local", "remote", "recovery", undefined]) {
  test(`snapshot application preserves state/history/focus behavior for ${String(source)} origin`, () => {
    const { roots, flat } = makeBlocks(10, { nested: true });
    const before = makeAppHarness("baseline", { instrument: true });
    const after = makeAppHarness("current", { instrument: true });
    setPage(before, structuredClone(roots)); setPage(after, structuredClone(roots));
    const snapshot = { title: "한글 changed title", blocks: flat.map((b, i) => ({ ...b, markdown: i === 2 ? "changed" : b.markdown })) };
    before.apply(snapshot, { source }); after.apply(snapshot, { source });
    before.flushFrames(); after.flushFrames();
    assert.deepEqual(after.state, before.state);
    assert.deepEqual(after.events, before.events);
    assert.equal(after.metrics.signatureCalls, source === "local" ? 0 : 2);
    assert.equal(before.metrics.signatureCalls, 2);
    assert.equal(after.state.applyingCollaborationSnapshot, false);
  });
}
for (const kind of ["unchanged", "title-only", "shared-page-array", "invalid-title", "render-error", "home", "noncollaborative", "no-page"]) {
  test(`snapshot boundary and rendering regression: ${kind}`, () => {
    const { roots, flat } = makeBlocks(5);
    const outcomes = [];
    for (const mode of ["baseline", "current"]) {
      const h = makeAppHarness(mode); setPage(h, structuredClone(roots));
      if (kind === "shared-page-array") h.state.pages = h.state.allPages;
      if (kind === "home") h.state.workspaceView = "home";
      if (kind === "noncollaborative") h.setCollaborative(false);
      if (kind === "no-page") h.state.selectedPage = null;
      if (kind === "render-error") h.setRenderError(new Error("RENDER_FAILURE"));
      let title = kind === "title-only" ? "Title changed" : "Title";
      if (kind === "invalid-title") title = "x".repeat(161);
      const blocks = structuredClone(flat);
      if (kind === "render-error") blocks[0].markdown = "changed";
      let error = null;
      try { h.apply({ title, blocks }); h.flushFrames(); } catch (e) { error = e.message; }
      outcomes.push({ state: h.state, events: h.events, error });
    }
    assert.deepEqual(outcomes[1], outcomes[0]);
    assert.equal(outcomes[1].state.applyingCollaborationSnapshot, false);
  });
}
for (const count of [1, 100, 2000]) {
  test(`order recovery membership cost is linear for ${count} IDs`, () => {
    const before = makeDraftNormalizer("baseline", { instrument: true });
    const after = makeDraftNormalizer("current", { instrument: true });
    const input = deepFreeze(makeOrder(count));
    assert.deepEqual(after.normalize(input), before.normalize(input));
    assert.equal(before.metrics.includesComparisons, count * (count + 1) / 2);
    assert.equal(after.metrics.includesComparisons, 0);
    assert.equal(after.metrics.setLookups, count);
  });
}
const invalidOrderCases = {
  duplicatePrevious: x => { x.previousIds[1] = x.previousIds[0]; },
  foreignPrevious: x => { x.previousIds[0] = "not_in_order"; },
  duplicateOrdered: x => { x.orderedIds[1] = x.orderedIds[0]; },
  mismatchedItem: x => { x.items[0].id = "foreign"; },
  invalidSort: x => { x.items[0].sortOrder = 9; },
  invalidVersion: x => { x.items[0].expectedVersion = Number.MAX_SAFE_INTEGER + 1; },
  versionString: x => { x.items[0].expectedVersion = "1"; },
  mixedParent: x => { x.items[0].parentBlockId = "other_parent"; },
  extraWrapper: x => { x.futureField = "preserve instead of overwriting"; },
  extraItem: x => { x.items[0].futureField = true; },
  hiddenWrapper: x => { Object.defineProperty(x, "hidden", { value: 1 }); },
  accessorWrapper: x => { Object.defineProperty(x, "mutationId", { enumerable: true, get() { throw new Error("getter must not run"); } }); },
  missingPrevious: x => { x.previousIds.pop(); },
  emptyIds: x => { x.orderedIds = []; x.items = []; x.previousIds = []; },
  invalidTimestamp: x => { x.updatedAt = NaN; },
  nullParentMismatch: x => { x.parentBlockId = undefined; },
  nonStringId: x => { x.orderedIds[0] = 2; },
  extraSymbol: x => { x[Symbol("private")] = 1; }
};
for (const [name, mutate] of Object.entries(invalidOrderCases)) {
  test(`recovery rejects ${name} without weakening validation`, () => {
    const input = makeOrder(4); mutate(input);
    const before = makeDraftNormalizer("baseline"); const after = makeDraftNormalizer();
    assert.equal(before.normalize(input), null);
    assert.equal(after.normalize(input), null);
  });
}
test("legacy null/absent previousIds, special string IDs and defensive copies remain supported", () => {
  const after = makeDraftNormalizer(); const before = makeDraftNormalizer("baseline");
  for (const previous of [null, undefined]) {
    const x = makeOrder(3); x.previousIds = previous;
    assert.deepEqual(after.normalize(x), before.normalize(x));
  }
  const x = makeOrder(4); x.orderedIds = ["__proto__", "constructor", "toString", "🌐한국어"];
  x.previousIds = [...x.orderedIds].reverse(); x.items.forEach((item, i) => { item.id = x.orderedIds[i]; });
  const out = after.normalize(x);
  assert.deepEqual(out, before.normalize(x));
  out.orderedIds[0] = "changed"; out.items[0].id = "changed"; out.previousIds[0] = "changed";
  assert.equal(x.orderedIds[0], "__proto__"); assert.equal(x.items[0].id, "__proto__");
  assert.equal(x.previousIds[0], "🌐한국어");
  assert.equal({}.polluted, undefined);
});
test("500 randomized order permutations and corruptions retain exact acceptance/output", () => {
  const random = randomGenerator(0x51a73);
  const before = makeDraftNormalizer("baseline"); const after = makeDraftNormalizer();
  for (let i = 0; i < 500; i += 1) {
    const input = makeOrder(1 + Math.floor(random() * 100));
    for (let j = input.previousIds.length - 1; j > 0; j -= 1) {
      const k = Math.floor(random() * (j + 1)); [input.previousIds[j], input.previousIds[k]] = [input.previousIds[k], input.previousIds[j]];
    }
    if (random() > 0.65) input.previousIds[0] = "foreign";
    assert.deepEqual(after.normalize(input), before.normalize(input));
  }
});
class MemoryStorage {
  values = new Map(); failWrites = false;
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.failWrites) throw new Error("quota"); this.values.set(key, value); }
  removeItem(key) { if (this.failWrites) throw new Error("unavailable"); this.values.delete(key); }
}
test("real draft-store API preserves source/account scope, exact acknowledgements, and the original durable bytes on failure", () => {
  const storage = new MemoryStorage();
  const store = createPageDraftStore(storage, { sourceId: "tab_a" });
  const other = createPageDraftStore(storage, { sourceId: "tab_b" });
  const payload = { ...makeOrder(40), userId: "user_a", pageId: "page_a" };
  delete payload.updatedAt;
  assert.equal(store.saveBlockOrder(payload), true);
  assert.equal(other.saveBlockOrder({ ...payload, mutationId: "other_tab" }), true);
  assert.equal(store.loadPage("user_b", "page_a"), null);
  assert.deepEqual(store.loadPage("user_a", "page_a", "tab_a").blockOrder.orderedIds, payload.orderedIds);
  const stable = [...storage.values];
  const bad = { ...payload, previousIds: [...payload.previousIds] }; bad.previousIds[0] = "foreign";
  assert.equal(store.saveBlockOrder(bad), false); assert.deepEqual([...storage.values], stable);
  storage.failWrites = true;
  assert.equal(store.saveBlockOrder({ ...payload, mutationId: "write_failed" }), false);
  assert.deepEqual([...storage.values], stable); storage.failWrites = false;
  assert.equal(store.acknowledgeBlockOrder({ userId: "user_a", pageId: "page_a", sourceId: "tab_a", mutationId: "stale_id" }), true);
  assert.ok(store.loadPage("user_a", "page_a", "tab_a").blockOrder);
  assert.equal(store.acknowledgeBlockOrder({ userId: "user_a", pageId: "page_a", sourceId: "tab_a", mutationId: payload.mutationId }), true);
  assert.equal(store.loadPage("user_a", "page_a", "tab_a"), null);
  assert.equal(other.loadPage("user_a", "page_a", "tab_b").blockOrder.mutationId, "other_tab");
});
for (const cloneMode of ["native", "json-fallback"]) {
  test(`history keeps defensive copy isolation and exact undo/redo behavior (${cloneMode})`, () => {
    const factory = makeHistoryFactory("current", { clone: cloneMode === "native" ? globalThis.structuredClone : null });
    const history = factory({ captureTimeout: 0 });
    const initial = { markdown: "처음", metadata: { rows: [{ value: 1 }] } };
    history.seed("p", "b", initial); initial.metadata.rows[0].value = 999;
    const next = { markdown: "다음", metadata: { rows: [{ value: 2 }] } };
    const meta = { kind: "block", ids: ["b"] };
    history.record({ pageId: "p", key: "b", value: next, meta, coalesce: false });
    next.metadata.rows[0].value = 999; meta.ids[0] = "tampered";
    let entry = history.peek("p", "undo");
    assert.equal(entry.before.metadata.rows[0].value, 1); assert.equal(entry.after.metadata.rows[0].value, 2);
    assert.equal(entry.meta.ids[0], "b");
    entry.after.metadata.rows[0].value = 777; entry.before.markdown = "outside";
    assert.equal(history.peek("p", "undo").after.metadata.rows[0].value, 2);
    history.commit("p", "undo"); assert.equal(history.peek("p", "redo").before.markdown, "처음");
    history.commit("p", "redo");
    history.record({ pageId: "p", key: "b", value: { markdown: "마지막", metadata: { rows: [{ value: 3 }] } }, coalesce: false });
    assert.equal(history.peek("p", "undo").before.metadata.rows[0].value, 2);
  });
}
test("history removes two redundant structured clones per changed record without changing bytes/depth", () => {
  const results = [];
  for (const mode of ["baseline", "current"]) {
    let clones = 0;
    const history = makeHistoryFactory(mode, { clone: value => { clones += 1; return structuredClone(value); } })();
    history.seed("p", "b", { value: "initial" }); clones = 0;
    for (let i = 0; i < 100; i += 1) history.record({ pageId: "p", key: "b", value: { value: `${i}` }, now: i });
    results.push({ clones, state: history.getState("p") });
  }
  assert.equal(results[0].clones, 400); assert.equal(results[1].clones, 200);
  assert.deepEqual(results[0].state, results[1].state);
});
test("history no-op, oversize, trimming, coalescing, capture boundaries and page reset preserve behavior", () => {
  const histories = [makeHistoryFactory("baseline")({ maxEntries: 3, maxBytes: 1500, captureTimeout: 20 }), makeHistoryFactory()({ maxEntries: 3, maxBytes: 1500, captureTimeout: 20 })];
  const operations = [
    ["seed", "p", "b", { value: "0" }],
    ["record", { pageId: "p", key: "b", value: { value: "0" }, now: 0 }],
    ...Array.from({ length: 8 }, (_, i) => ["record", { pageId: "p", key: "b", value: { value: String(i + 1) }, now: i * 40, coalesce: i > 4 }]),
    ["commit", "p", "undo"], ["commit", "p", "redo"], ["stopCapturing"],
    ["record", { pageId: "p", key: "b", value: { value: "x".repeat(5000) }, now: 400 }],
    ["record", { pageId: "p", key: "b", value: { value: "small" }, now: 420 }],
    ["discard", "p", "undo"], ["clear", "p"], ["setPage", "other"], ["seed", "other", "b", "new account"], ["setPage", "p"]
  ];
  for (const [method, ...args] of operations) {
    const results = histories.map(h => h[method](...args)); assert.deepEqual(results[1], results[0]);
    const states = histories.map(h => h.getState()); assert.deepEqual(states[1], states[0]);
    for (const direction of ["undo", "redo"]) assert.deepEqual(histories[1].peek(states[1].pageId, direction), histories[0].peek(states[0].pageId, direction));
  }
});
for (const useNative of [true, false]) {
  test(`2000 deterministic history operations preserve every observable state (${useNative ? "native" : "fallback"})`, () => {
    const random = randomGenerator(0x7e5700 + Number(useNative));
    const histories = ["baseline", "current"].map(mode => makeHistoryFactory(mode, { clone: useNative ? globalThis.structuredClone : null })({ maxEntries: 12, maxBytes: 4096, captureTimeout: 60 }));
    let pageId = "p"; let timestamp = 1000;
    for (let i = 0; i < 2000; i += 1) {
      const key = `b${Math.floor(random() * 8)}`; const action = random(); let method; let args;
      if (action < 0.13) { method = "seed"; args = [pageId, key, { markdown: `seed ${i}`, metadata: { checked: i % 2 === 0 } }]; }
      else if (action < 0.64) { method = "record"; args = [{ pageId, key, value: { markdown: `한글 ${i}`, metadata: { rows: [i, i + 1], checked: i % 2 === 0 } }, meta: { type: "BLOCK", key }, captureGroup: i % 3 ? key : "other", coalesce: random() > 0.25, now: timestamp += Math.floor(random() * 80) }]; }
      else if (action < 0.76) { method = "commit"; args = [pageId, random() > 0.5 ? "undo" : "redo"]; }
      else if (action < 0.85) { method = "discard"; args = [pageId, random() > 0.5 ? "undo" : "redo"]; }
      else if (action < 0.93) { method = "stopCapturing"; args = []; }
      else if (action < 0.97) { method = "clear"; args = [pageId]; }
      else { pageId = pageId === "p" ? "q" : "p"; method = "setPage"; args = [pageId]; }
      const results = histories.map(h => h[method](...structuredClone(args))); assert.deepEqual(results[1], results[0], `${i}: ${method}`);
      assert.deepEqual(histories[1].getState(pageId), histories[0].getState(pageId), `state at ${i}`);
      for (const direction of ["undo", "redo"]) assert.deepEqual(histories[1].peek(pageId, direction), histories[0].peek(pageId, direction), `${direction} at ${i}`);
    }
  });
}

for (const source of ["local", "remote"]) {
  test(`real page-title length boundary is retained for ${source} snapshots`, () => {
    for (const mode of ["baseline", "current"]) {
      const h = makeAppHarness(mode); setPage(h);
      h.apply({ title: "x".repeat(160), blocks: [] }, { source });
      assert.equal(h.state.selectedPage.title.length, 160);
      const before = structuredClone(h.state);
      assert.throws(() => h.apply({ title: "x".repeat(161), blocks: [] }, { source }), error => {
        assert.equal(error.code, "EDITOR_CONTENT_LIMIT_EXCEEDED");
        assert.equal(error.maxLength, 160);
        return true;
      });
      assert.deepEqual(h.state, before);
    }
  });
}
