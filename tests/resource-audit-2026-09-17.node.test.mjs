import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { planConfirmedBlockInsertion } from "../public/block-insertion-result.js";
import {
  resourceAuditBaseline, makeAuditBlock, insertionFixture, loadInsertion,
  measureInsertionReads, collaborationTreeFixture, loadCollaborationTree,
  seededRandom, freezeAuditInput
} from "./helpers/resource-audit-2026-09-17-harness.mjs";

for (const [name, record] of Object.entries(resourceAuditBaseline.records)) {
  test(`resource audit: byte-exact original fixture (${name})`, () => {
    assert.equal(createHash("sha256").update(record.source).digest("hex"), record.sha256);
  });
}

for (const reorder of [false, true]) {
  test(`2,000 siblings: linear ID membership, exact confirmed insertion (${reorder ? "reorder" : "tail"})`, () => {
    const input = freezeAuditInput(insertionFixture(2000, reorder));
    const before = measureInsertionReads(loadInsertion("baseline"), input);
    const after = measureInsertionReads(planConfirmedBlockInsertion, input);
    assert.deepEqual(after.result, before.result);
    assert.equal(before.indexedReads, reorder ? 2009004 : 2007003);
    assert.equal(after.indexedReads, 4002);
    assert.equal(after.result.createdBlock.version, reorder ? 2 : 1);
  });
}

test("insertion: 1,000 deterministic valid and rejected mutations preserve the fail-closed result", () => {
  const before = loadInsertion("baseline"), random = seededRandom();
  const mutations = [
    input => {},
    input => { input.createResult.pageContentVersionAuthoritative = false; },
    input => { input.currentContentVersion += 1; },
    input => { input.orderedIds[0] = "missing"; },
    input => { input.orderedIds.push(input.orderedIds[0]); },
    input => { input.createResult.block.pageId = "another-account-page"; },
    input => { input.parentBlockId = "missing-parent"; },
    input => { if (input.currentBlocks[0]) input.currentBlocks[0].version += 1; },
    input => { if (input.beforeBlocks[0]) input.beforeBlocks[0].parentBlockId = "missing"; },
    input => { input.createResult.pageUpdatedAt = "invalid"; },
    input => { input.createResult.block.sortOrder = -1; },
    input => { input.orderedIds.reverse(); }
  ];
  for (let index = 0; index < 1000; index += 1) {
    const input = insertionFixture(Math.floor(random() * 70), random() < 0.5);
    mutations[index % mutations.length](input);
    freezeAuditInput(input);
    assert.deepEqual(planConfirmedBlockInsertion(input), before(input), `case ${index}`);
  }
});

test("insertion: leaf-first validated ancestors preserve nested children and the 128-level boundary", () => {
  const before = loadInsertion("baseline");
  for (const depth of [1, 2, 127, 128, 129, 130, 260]) {
    const input = insertionFixture(0);
    const blocks = collaborationTreeFixture(depth, depth, true);
    input.beforeBlocks = blocks;
    input.currentBlocks = structuredClone(blocks);
    input.orderedIds = ["d0", "new"];
    input.createResult.block.sortOrder = depth;
    freezeAuditInput(input);
    const actual = planConfirmedBlockInsertion(input);
    assert.deepEqual(actual, before(input));
    assert.equal(actual === null, depth > 129);
  }
});

for (const leafFirst of [false, true]) {
  test(`collaboration: 2,000 nodes sharing a depth-128 path keep identical data (${leafFirst ? "leaf-first" : "root-first"})`, () => {
    const input = freezeAuditInput(collaborationTreeFixture(2000, 128, leafFirst));
    const before = loadCollaborationTree("baseline", { instrument: true });
    const after = loadCollaborationTree("current", { instrument: true });
    assert.deepEqual(after.run(input), before.run(input));
    assert.equal(before.metrics.mapGets, 251743);
    assert.equal(before.metrics.setAllocations, 1999);
    assert.ok(after.metrics.mapGets < 9000, JSON.stringify(after.metrics));
    assert.equal(after.metrics.setAllocations, 1);
  });
}

test("collaboration: flat snapshots allocate no depth cache or path sets", () => {
  const input = freezeAuditInput(collaborationTreeFixture(2000, 0));
  const before = loadCollaborationTree("baseline", { instrument: true });
  const after = loadCollaborationTree("current", { instrument: true });
  assert.deepEqual(after.run(input), before.run(input));
  assert.deepEqual(after.metrics, before.metrics);
});

test("collaboration: all 1,296 four-node parent graphs retain input-order cycle and orphan repair", () => {
  const before = loadCollaborationTree("baseline"), after = loadCollaborationTree();
  const parents = [null, "absent", "n0", "n1", "n2", "n3"];
  for (let graph = 0; graph < parents.length ** 4; graph += 1) {
    let code = graph;
    const input = Array.from({ length: 4 }, (_, index) => {
      const parent = parents[code % parents.length]; code = Math.floor(code / parents.length);
      return makeAuditBlock(`n${index}`, index, parent);
    });
    for (const ordered of [input, [...input].reverse()]) {
      freezeAuditInput(ordered);
      assert.deepEqual(after.run(ordered), before.run(ordered), `graph ${graph}`);
    }
  }
});

test("collaboration: depth boundaries, late orphan-root repairs and cycle repairs remain exact", () => {
  const before = loadCollaborationTree("baseline"), after = loadCollaborationTree();
  const random = seededRandom(0x117);
  for (const depth of [127, 128, 129, 130, 131, 256, 300]) {
    for (const orphan of [false, true]) {
      for (let order = 0; order < 4; order += 1) {
        const input = collaborationTreeFixture(depth + 50, depth);
        if (orphan) input[0].parentBlockId = "missing";
        if (order === 1) input.reverse();
        if (order === 2) { const node = input.shift(); input.push(node); }
        if (order === 3) for (let i = input.length - 1; i > 0; i -= 1) {
          const j = Math.floor(random() * (i + 1)); [input[i], input[j]] = [input[j], input[i]];
        }
        freezeAuditInput(input);
        assert.deepEqual(after.run(input), before.run(input), `depth ${depth}, orphan ${orphan}, order ${order}`);
      }
    }
  }
});

test("collaboration: 2,000 seeded malformed graphs keep snapshot bytes, metadata and first-match inheritance", () => {
  const before = loadCollaborationTree("baseline"), after = loadCollaborationTree();
  const random = seededRandom(0x7ac4);
  const old = [
    { ...makeAuditBlock("n0"), version: 8, createdAt: "old", children: [{ ...makeAuditBlock("n1"), version: 9 }] },
    { ...makeAuditBlock("n1"), version: 999 }
  ];
  before.state.selectedPage.blocks = after.state.selectedPage.blocks = freezeAuditInput(old);
  for (let run = 0; run < 2000; run += 1) {
    const count = Math.floor(random() * 160);
    const input = Array.from({ length: count }, (_, index) => makeAuditBlock(
      `n${index}`, Math.floor(random() * 6),
      random() < 0.15 ? null : `n${Math.floor(random() * (count + 3))}`
    ));
    if (input.length && run % 5 === 0) input.push(structuredClone(input[0]));
    if (run % 9 === 0) input.push(null, { id: "" });
    if (run % 3 === 0) input.reverse();
    freezeAuditInput(input);
    assert.deepEqual(after.run(input), before.run(input), `seeded graph ${run}`);
  }
  assert.equal({}.polluted, undefined);
});

test("collaboration: no depth cache persists across snapshots, pages or account transitions", () => {
  const before = loadCollaborationTree("baseline"), after = loadCollaborationTree();
  const input = collaborationTreeFixture(150, 127);
  for (let run = 0; run < 30; run += 1) {
    input[0].parentBlockId = run % 2 ? "missing" : "d100";
    input[149].parentBlockId = run % 3 ? "d126" : null;
    after.state.selectedPage = before.state.selectedPage = run % 2 ? null : { blocks: [] };
    assert.deepEqual(after.run(input), before.run(input));
  }
});
