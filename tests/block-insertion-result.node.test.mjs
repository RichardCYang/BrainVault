import assert from "node:assert/strict";
import test from "node:test";
import { planConfirmedBlockInsertion } from "../public/block-insertion-result.js";

function block(id, sortOrder, overrides = {}) {
  return { id, pageId: "p", parentBlockId: null, sortOrder, version: 1, type: "MARKDOWN", markdown: id, metadata: null, ...overrides };
}
function fixture({ reorder = false } = {}) {
  const a = block("a", 0);
  const b = block("b", 1);
  const created = block("new", 2);
  const ordered = reorder ? ["a", "new", "b"] : ["a", "b", "new"];
  const canonical = [a, created, b].map((item, sortOrder) => ({ ...item, version: 2, sortOrder }));
  return {
    pageId: "p", baseContentVersion: 10, currentContentVersion: reorder ? 12 : 11,
    beforeBlocks: structuredClone([a, b]),
    currentBlocks: structuredClone(reorder ? canonical.filter((item) => item.id !== "new") : [a, b]),
    parentBlockId: null, orderedIds: ordered,
    createResult: { block: created, pageContentVersion: 11, pageUpdatedAt: "2026-09-15T10:00:00.000Z", pageContentVersionAuthoritative: true },
    orderResult: reorder ? { blocks: canonical, pageContentVersion: 12, pageUpdatedAt: "2026-09-15T10:00:01.000Z" } : null
  };
}

test("confirmed tail insertion needs no reorder or page reload and does not mutate inputs", () => {
  const input = fixture();
  const original = structuredClone(input);
  const result = planConfirmedBlockInsertion(input);
  assert.deepEqual(result.blocks.map((item) => item.id), ["a", "b", "new"]);
  assert.equal(result.createdBlock.version, 1);
  assert.deepEqual(input, original);
  assert.notEqual(result.blocks[0], input.currentBlocks[0]);
});
test("confirmed middle insertion uses the newest block version from the full reorder response", () => {
  const result = planConfirmedBlockInsertion(fixture({ reorder: true }));
  assert.deepEqual(result.blocks.map((item) => item.id), ["a", "new", "b"]);
  assert.equal(result.createdBlock.version, 2, "never reuse create version 1 after reorder");
});
test("empty page insertion preserves complete structured metadata and sanitized renderer fields", () => {
  const input = fixture(); input.beforeBlocks = []; input.currentBlocks = []; input.orderedIds = ["new"];
  Object.assign(input.createResult.block, { type: "TABLE", sortOrder: 0, metadata: { table: { rows: [["한글", "😀", "<script>x</script>"]] } }, htmlCache: "<p>safe</p>" });
  const result = planConfirmedBlockInsertion(input);
  assert.deepEqual(result.createdBlock.metadata, input.createResult.block.metadata);
  assert.equal(result.createdBlock.htmlCache, "<p>safe</p>");
});
test("nested tail insertion preserves all children and unrelated root blocks", () => {
  const input = fixture();
  const child = block("child", 0, { parentBlockId: "a", metadata: { unknown: [1, 2, 3] } });
  input.beforeBlocks.push(child); input.currentBlocks.push(child);
  input.parentBlockId = "a"; input.orderedIds = ["child", "new"];
  Object.assign(input.createResult.block, { parentBlockId: "a", sortOrder: 1 });
  const result = planConfirmedBlockInsertion(input);
  assert.deepEqual(result.blocks.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(result.blocks[0].children.map((item) => item.id), ["child", "new"]);
  assert.deepEqual(result.blocks[0].children[0].metadata, child.metadata);
});
test("sparse but unambiguous canonical sort positions are retained, not silently renumbered", () => {
  const input = fixture(); input.beforeBlocks[1].sortOrder = 5; input.currentBlocks[1].sortOrder = 5; input.createResult.block.sortOrder = 6;
  assert.deepEqual(planConfirmedBlockInsertion(input).blocks.map((item) => item.sortOrder), [0, 5, 6]);
});

const rejections = {
  "unknown authority": (x) => { delete x.createResult.pageContentVersionAuthoritative; },
  "explicitly stale create authority": (x) => { x.createResult.pageContentVersionAuthoritative = false; },
  "string authority is not true": (x) => { x.createResult.pageContentVersionAuthoritative = "true"; },
  "missing timestamp from older server": (x) => { delete x.createResult.pageUpdatedAt; },
  "invalid timestamp": (x) => { x.createResult.pageUpdatedAt = "not-a-date"; },
  "missing create generation": (x) => { delete x.createResult.pageContentVersion; },
  "intervening content generation": (x) => { x.currentContentVersion += 1; },
  "unsafe content version": (x) => { x.baseContentVersion = Number.MAX_SAFE_INTEGER; },
  "string generation": (x) => { x.createResult.pageContentVersion = "11"; },
  "wrong page": (x) => { x.createResult.block.pageId = "another"; },
  "unknown parent": (x) => { x.parentBlockId = "absent"; x.createResult.block.parentBlockId = "absent"; },
  "unexpected parent": (x) => { x.createResult.block.parentBlockId = "a"; },
  "duplicate created ID": (x) => { x.createResult.block.id = "a"; },
  "duplicate old ID": (x) => { x.beforeBlocks[1].id = "a"; },
  "duplicate requested ID": (x) => { x.orderedIds = ["a", "new", "new"]; },
  "missing requested sibling": (x) => { x.orderedIds = ["a", "new"]; },
  "unknown requested sibling": (x) => { x.orderedIds = ["alien", "b", "new"]; },
  "locally added block": (x) => { x.currentBlocks.push(block("raced", 9)); },
  "locally removed block": (x) => { x.currentBlocks.pop(); },
  "locally changed version": (x) => { x.currentBlocks[0].version += 1; },
  "locally changed order": (x) => { x.currentBlocks[0].sortOrder = 8; },
  "locally changed hierarchy": (x) => { x.currentBlocks[0].parentBlockId = "b"; },
  "middle insert still needs reorder": (x) => { x.orderedIds = ["a", "new", "b"]; },
  "ambiguous duplicate sort positions": (x) => { x.createResult.block.sortOrder = 1; },
  "negative sort position": (x) => { x.createResult.block.sortOrder = -1; },
  "unsafe block version": (x) => { x.createResult.block.version = Number.MAX_SAFE_INTEGER + 1; },
  "cyclic hierarchy": (x) => { for (const rows of [x.beforeBlocks, x.currentBlocks]) { rows[0].parentBlockId = "b"; rows[1].parentBlockId = "a"; } x.orderedIds = ["new"]; },
  "orphan hierarchy": (x) => { for (const rows of [x.beforeBlocks, x.currentBlocks]) rows[0].parentBlockId = "absent"; x.orderedIds = ["b", "new"]; }
};
for (const [reason, mutate] of Object.entries(rejections)) {
  test(`fallback instead of unsafe fast path: ${reason}`, () => {
    const input = fixture(); mutate(input);
    assert.equal(planConfirmedBlockInsertion(input), null);
  });
}
for (const [reason, mutate] of Object.entries({
  "missing canonical block": (x) => { x.orderResult.blocks.pop(); },
  "extra canonical block": (x) => { x.orderResult.blocks.push(block("alien", 8)); },
  "missing canonical collection": (x) => { delete x.orderResult.blocks; },
  "wrong canonical page": (x) => { x.orderResult.blocks[0].pageId = "another"; },
  "stale canonical block version": (x) => { x.orderResult.blocks[1].version = 1; },
  "later replayed canonical state": (x) => { x.orderResult.pageContentVersion = 13; x.currentContentVersion = 13; },
  "unexpected canonical version gap": (x) => { x.orderResult.blocks[0].version = 3; },
  "wrong committed order": (x) => { x.orderResult.blocks[1].sortOrder = 8; },
  "changed canonical hierarchy": (x) => { x.orderResult.blocks[1].parentBlockId = "a"; }
})) {
  test(`reorder fallback: ${reason}`, () => {
    const input = fixture({ reorder: true }); mutate(input);
    assert.equal(planConfirmedBlockInsertion(input), null);
  });
}

test("very deep hierarchy is rejected rather than silently truncated", () => {
  const input = fixture();
  input.beforeBlocks = Array.from({ length: 131 }, (_, i) => block(`d${i}`, 0, { parentBlockId: i ? `d${i - 1}` : null }));
  input.currentBlocks = structuredClone(input.beforeBlocks);
  input.orderedIds = ["d0", "new"];
  assert.equal(planConfirmedBlockInsertion(input), null);
});
test("missing or malformed arguments conservatively fail closed", () => {
  assert.equal(planConfirmedBlockInsertion(), null);
  for (const value of [null, {}, "bad", 7]) {
    assert.equal(planConfirmedBlockInsertion({ ...fixture(), currentBlocks: value }), null);
  }
});
