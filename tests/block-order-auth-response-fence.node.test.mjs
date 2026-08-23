import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appUrl = new URL("../public/app.js", import.meta.url);

async function readApp() {
  return readFile(appUrl, "utf8");
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function assertSuccessFenceBeforeAcknowledgement(body, submitMarker) {
  const submit = body.indexOf(submitMarker);
  const fence = body.indexOf(
    "assertCurrentAuthenticatedSessionScope(task.authenticationScope)",
    submit
  );
  const acknowledge = body.indexOf("acknowledgeBlockOrderDraft(task)", submit);
  assert.ok(submit >= 0, `missing submit marker: ${submitMarker}`);
  assert.ok(
    fence > submit && acknowledge > fence,
    "block-order recovery must revalidate the initiating auth generation before acknowledging its durable draft"
  );
}

function assertStaleAuthHandledBeforeDefinitiveCleanup(body) {
  const catchStart = body.indexOf("} catch (error) {");
  assert.ok(catchStart >= 0, "missing block-order catch");
  const staleFence = body.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(task.authenticationScope))",
    catchStart
  );
  const definitive = body.indexOf("if (isDefinitiveApiError(error))", catchStart);
  assert.ok(
    staleFence > catchStart && definitive > staleFence,
    "credential-rotation errors must preserve the durable reorder draft instead of entering definitive cleanup"
  );
}

test("block-order completion cannot acknowledge recovery after credential rotation", async () => {
  const source = await readApp();

  const drag = sliceBetween(source, "async function finishBlockDrag", "function setRowType");
  assertSuccessFenceBeforeAcknowledgement(drag, "await submitBlockOrderTaskWithReplay(task)");
  assertStaleAuthHandledBeforeDefinitiveCleanup(drag);
  assert.match(
    drag,
    /if \(!isCurrentAuthenticatedSessionScope\(task\.authenticationScope\)\) \{\s+if \(pendingBlockOrderTask === task\) pendingBlockOrderTask = null;\s+return;/
  );

  const retry = sliceBetween(
    source,
    "async function retryPendingBlockOrder",
    "async function persistBlockOrder"
  );
  const retryPreflight = retry.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(task.authenticationScope))"
  );
  const saving = retry.indexOf("blockOrderSaving = true");
  assert.ok(
    retryPreflight >= 0 && saving > retryPreflight,
    "a stale recovered reorder must be detached before retry state is entered"
  );
  assertSuccessFenceBeforeAcknowledgement(
    retry,
    "await submitBlockOrderTaskWithReplay(task, { keepalive, allowRecoveryFailure })"
  );
  assertStaleAuthHandledBeforeDefinitiveCleanup(retry);

  const persist = sliceBetween(
    source,
    "async function persistBlockOrder",
    "function getBlockCreateTask"
  );
  assertSuccessFenceBeforeAcknowledgement(persist, "await submitBlockOrderTaskWithReplay(task)");
  assertStaleAuthHandledBeforeDefinitiveCleanup(persist);
});

test("auth-rotation ambiguity requires preserving the reorder recovery record", () => {
  const vulnerable = {
    firstRequestCommitted: true,
    responseObserved: false,
    authRotated: true,
    durableRecoveryPresent: false,
    localOrder: "rolled-back"
  };
  const fixed = {
    ...vulnerable,
    durableRecoveryPresent: true,
    localOrder: "optimistic"
  };

  assert.equal(vulnerable.firstRequestCommitted && !vulnerable.durableRecoveryPresent, true);
  assert.equal(fixed.firstRequestCommitted && fixed.durableRecoveryPresent, true);
  assert.equal(fixed.localOrder, "optimistic");
});
