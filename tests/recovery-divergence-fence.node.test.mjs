import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `${startText} must exist`);
  assert.notEqual(end, -1, `${endText} must exist after ${startText}`);
  return source.slice(start, end).trim();
}

const recoverySource = sliceBetween(
  client,
  "function applyPersistedPageDraft(page)",
  "function findRenderedBlockRow"
);

function runRecovery({ page, records }) {
  const context = {
    pageDraftStore: {
      inspectPageDrafts: () => ({ records, reliable: true, unreadableKeys: [] }),
      acknowledgeTitle: () => true,
      acknowledgeBlock: () => true,
      acknowledgeBlockOrder: () => true
    },
    getDraftScope: () => ({ userId: "user-1", pageId: page.id }),
    assertBrowserRecoveryInspectionSafe: (inspection) => {
      if (!inspection.reliable || inspection.unreadableKeys.length) throw new Error("unsafe recovery");
    },
    checkDraftStoreWrite: () => true,
    getPositiveVersion: (value) => Number(value),
    getBlockById: (id, blocks) => blocks.find((block) => block.id === id) ?? null,
    normalizeRecoveredBlockPayload: (payload) => payload,
    jsonValuesMatch: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    blockPayloadsMatch: (block, payload) =>
      block.type === payload.type
      && (block.markdown ?? "") === (payload.markdown ?? "")
      && Boolean(block.checked) === Boolean(payload.checked)
      && JSON.stringify(block.metadata ?? null) === JSON.stringify(payload.metadata ?? null),
    getPageBlockSiblings: (currentPage, parentBlockId) =>
      currentPage.blocks.filter((block) => (block.parentBlockId ?? null) === (parentBlockId ?? null)),
    reorderPageBlockSiblings: () => true
  };
  vm.createContext(context);
  vm.runInContext(`${recoverySource}\nthis.applyPersistedPageDraft = applyPersistedPageDraft;`, context);
  return context.applyPersistedPageDraft(page);
}

function emptyRecord(sourceId) {
  return { sourceId, title: null, blocks: {}, blockOrder: null };
}

test("divergent same-base title drafts are conflicts and cannot enter the auto-save branch", () => {
  const a = emptyRecord("tab-a");
  a.title = { value: "Recovered A", expectedVersion: 7, revision: 1, updatedAt: 1000 };
  const b = emptyRecord("tab-b");
  b.title = { value: "Recovered B", expectedVersion: 7, revision: 1, updatedAt: 2000 };

  const recovery = runRecovery({
    page: { id: "page-1", title: "Server", version: 7, blocks: [] },
    records: [a, b]
  });

  assert.equal(recovery.title.value, "Recovered B");
  assert.equal(recovery.title.conflict, true);
  assert.equal(recovery.alternates.length, 1);
  assert.equal(recovery.conflictCount, 1);

  const activation = sliceBetween(client, "function activatePersistedPageDraft", "function getWorkspaceCreateRequestKey");
  const conflictGate = activation.indexOf("if (recovery.title.conflict)");
  const autoSave = activation.indexOf("savePageTitleNow().catch");
  assert.ok(conflictGate >= 0 && autoSave > conflictGate);
});

test("divergent same-base block drafts are marked conflicting before any automatic save", () => {
  const a = emptyRecord("tab-a");
  a.blocks = {
    b1: {
      payload: { type: "MARKDOWN", markdown: "A", checked: false, metadata: null },
      expectedVersion: 4,
      revision: 1,
      updatedAt: 1000
    }
  };
  const b = emptyRecord("tab-b");
  b.blocks = {
    b1: {
      payload: { type: "MARKDOWN", markdown: "B", checked: false, metadata: null },
      expectedVersion: 4,
      revision: 1,
      updatedAt: 2000
    }
  };

  const recovery = runRecovery({
    page: {
      id: "page-1",
      title: "Server",
      version: 1,
      blocks: [{ id: "b1", type: "MARKDOWN", markdown: "Server", checked: false, metadata: null, version: 4 }]
    },
    records: [a, b]
  });

  assert.equal(recovery.blocks.length, 1);
  assert.equal(recovery.blocks[0].conflict, true);
  assert.equal(recovery.alternates.length, 1);
  assert.equal(recovery.conflictCount, 1);
});

test("divergent same-base block orders are never classified as auto-replayable recovery", () => {
  const makeOrder = (sourceId, orderedIds, updatedAt) => ({
    sourceId,
    title: null,
    blocks: {},
    blockOrder: {
      parentBlockId: null,
      orderedIds,
      previousIds: ["a", "b", "c"],
      items: orderedIds.map((id) => ({ id, expectedVersion: 1 })),
      mutationId: `mutation-${sourceId}`,
      updatedAt
    }
  });

  const recovery = runRecovery({
    page: {
      id: "page-1",
      title: "Server",
      version: 1,
      blocks: [
        { id: "a", parentBlockId: null, version: 1 },
        { id: "b", parentBlockId: null, version: 1 },
        { id: "c", parentBlockId: null, version: 1 }
      ]
    },
    records: [
      makeOrder("tab-a", ["b", "a", "c"], 1000),
      makeOrder("tab-b", ["c", "a", "b"], 2000)
    ]
  });

  assert.equal(recovery.blockOrder, null);
  assert.equal(recovery.orderConflicts.length, 2);
  assert.equal(recovery.conflictCount, 1);
});

test("unreadable direct recovery aborts restoration instead of looking like no draft", () => {
  const context = {
    pageDraftStore: {
      inspectPageDrafts: () => ({ records: [], reliable: true, unreadableKeys: ["corrupt-key"] })
    },
    getDraftScope: () => ({ userId: "user-1", pageId: "page-1" }),
    assertBrowserRecoveryInspectionSafe: () => { throw new Error("unsafe recovery"); }
  };
  vm.createContext(context);
  vm.runInContext(`${recoverySource}\nthis.applyPersistedPageDraft = applyPersistedPageDraft;`, context);
  assert.throws(
    () => context.applyPersistedPageDraft({ id: "page-1", title: "Server", version: 1, blocks: [] }),
    /unsafe recovery/
  );
});
