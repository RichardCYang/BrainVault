import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const ganttClient = readFileSync(new URL("../public/gantt-block.js", import.meta.url), "utf8");
const accordionClient = readFileSync(new URL("../public/accordion-block.js", import.meta.url), "utf8");

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `${startText} must exist`);
  assert.notEqual(end, -1, `${endText} must exist after ${startText}`);
  return source.slice(start, end).trim();
}

function loadBlockDragFinishHarness({ writable }) {
  const source = sliceBetween(client, "async function finishBlockDrag", "function setRowType");
  let lockCalls = 0;
  let submitCalls = 0;
  let reorderCalls = 0;

  const handle = {
    classList: { remove() {} },
    setAttribute() {},
    hasPointerCapture() { return false; },
    releasePointerCapture() {}
  };
  const row = { dataset: { blockId: "block-1" } };
  const context = {
    activeBlockDrag: {
      pointerId: 1,
      handle,
      row,
      parentBlockId: null,
      active: true,
      targetIndex: 1,
      initialIndex: 0,
      groupRows: [row],
      candidates: [{ dataset: { blockId: "block-2" } }],
      indicator: { remove() {} }
    },
    Date,
    document: { body: { classList: { remove() {} } } },
    clearBlockDragVisuals() {},
    requireWritablePage() { return writable; },
    captureAuthenticatedSessionScope() { return Object.freeze({ generation: 1, targetKey: "user-1" }); },
    isCurrentAuthenticatedSessionScope(scope) { return scope?.generation === 1 && scope?.targetKey === "user-1"; },
    async withPageEditLock(callback) {
      lockCalls += 1;
      return callback();
    },
    getBlockSiblings() { return [{ id: "block-1" }, { id: "block-2" }]; },
    isCollaborativePage() { return false; },
    createBlockOrderTask(parentBlockId, orderedIds, _options, extra) {
      return { parentBlockId, orderedIds, ...extra };
    },
    persistBlockOrderDraft() {},
    reorderBlockSiblingsInState() {
      reorderCalls += 1;
      return true;
    },
    renderSelectedPage() {},
    syncPageModeUi() {},
    syncBeforeUnloadProtection() {},
    setStatus() {},
    t(key) { return key; },
    async submitBlockOrderTaskWithReplay() { submitCalls += 1; },
    acknowledgeBlockOrderDraft() {},
    isDefinitiveApiError() { return false; },
    blockOrderSaving: false,
    pendingBlockOrderTask: null,
    suppressBlockHandleClickUntil: 0
  };

  vm.createContext(context);
  vm.runInContext(`${source}\nthis.finishBlockDrag = finishBlockDrag;`, context);
  return {
    context,
    calls: () => ({ lockCalls, submitCalls, reorderCalls })
  };
}

test("an active block drag cannot commit after the page becomes read-only", async () => {
  const { context, calls } = loadBlockDragFinishHarness({ writable: false });
  await context.finishBlockDrag({ pointerId: 1, preventDefault() {} });
  assert.deepEqual(calls(), { lockCalls: 0, submitCalls: 0, reorderCalls: 0 });
});

test("an active block drag still commits normally while the page remains writable", async () => {
  const { context, calls } = loadBlockDragFinishHarness({ writable: true });
  await context.finishBlockDrag({ pointerId: 1, preventDefault() {} });
  assert.deepEqual(calls(), { lockCalls: 1, submitCalls: 1, reorderCalls: 1 });
});

test("kanban drag commit paths re-check write permission at drop time", () => {
  const columnFinish = sliceBetween(client, "function finishKanbanColumnDrag", "function clearKanbanDropTargets");
  const cardDrop = sliceBetween(client, "function dropKanbanCard", "function makeTableActionButton");
  const replaceData = sliceBetween(client, "function replaceKanbanData", "function getKanbanColumnInsertionIndex");

  assert.match(columnFinish, /if \(!requireWritablePage\(\{ announce: false \}\)\) return;/);
  assert.match(cardDrop, /if \(!requireWritablePage\(\{ announce: false \}\)\) return;/);
  assert.match(replaceData, /if \(!requireWritablePage\(\{ announce: false \}\)\) return;/);
});

test("gantt pointer drags roll back instead of committing after read mode activates", () => {
  assert.match(ganttClient, /const shouldCommit = commit && !isReadOnly\(\);/);
  assert.match(
    ganttClient,
    /bar\.addEventListener\("pointermove", \(event\) => \{\s*if \(!drag \|\| event\.pointerId !== drag\.pointerId\) return;\s*if \(isReadOnly\(\)\) \{\s*finishDrag\(false\);/s
  );
});

test("accordion input and drag/drop handlers reject mutations after read mode activates", () => {
  assert.match(accordionClient, /const isReadOnly = \(\) => row\?\.getAttribute\("aria-readonly"\) === "true"/);
  assert.match(accordionClient, /editor\.addEventListener\("input", \(event\) => \{\s*if \(isReadOnly\(\)\) return;/s);
  assert.match(accordionClient, /editor\.addEventListener\("click", \(event\) => \{\s*if \(isReadOnly\(\)\) return;/s);
  assert.match(accordionClient, /list\.addEventListener\("dragstart", \(event\) => \{\s*if \(isReadOnly\(\)\) \{/s);
  assert.match(accordionClient, /list\.addEventListener\("drop", \(event\) => \{\s*if \(!draggedId\) return;\s*if \(isReadOnly\(\)\) \{/s);
});
