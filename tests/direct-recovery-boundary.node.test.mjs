import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { submitWithFreshMutationIdOnReuse } from "../public/mutation-id.js";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("mutation-id rotation waits for durable identity persistence before retry", async () => {
  const task = { mutationId: "mut_collision" };
  const events = [];
  let releasePersistence;
  const persistenceBarrier = new Promise((resolve) => { releasePersistence = resolve; });

  const resultPromise = submitWithFreshMutationIdOnReuse(
    task,
    async () => {
      events.push("submit");
      if (events.filter((event) => event === "submit").length === 1) {
        throw Object.assign(new Error("collision"), { code: "MUTATION_ID_REUSED" });
      }
      return "saved";
    },
    async () => {
      events.push("persist-start");
      await persistenceBarrier;
      events.push("persist-complete");
    }
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["submit", "persist-start"]);
  releasePersistence();
  assert.equal(await resultPromise, "saved");
  assert.deepEqual(events, ["submit", "persist-start", "persist-complete", "submit"]);
});

test("block-order submit cannot start before the direct recovery durability barrier", () => {
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const source = section(
    client,
    "async function requireBlockOrderRecoveryDurability(",
    "async function retryPendingBlockOrder("
  );
  const firstBarrier = source.indexOf("await requireBlockOrderRecoveryDurability({ allowRecoveryFailure });");
  const submission = source.indexOf("return submitWithFreshMutationIdOnReuse(");
  assert.ok(firstBarrier >= 0 && firstBarrier < submission);

  const rotatedPersistence = source.indexOf("persistBlockOrderDraft(task);", submission);
  const rotatedBarrier = source.indexOf(
    "await requireBlockOrderRecoveryDurability({ allowRecoveryFailure });",
    rotatedPersistence
  );
  assert.ok(rotatedPersistence > submission && rotatedBarrier > rotatedPersistence);
});

test("recovered titles are fenced from automatic authoritative promotion", () => {
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const selection = section(client, "function applyPersistedPageDraft(page)", "function findRenderedBlockRow");
  assert.match(selection, /const conflict = true;/);
  assert.match(selection, /serverConflict,/);

  const activation = section(client, "function activatePersistedPageDraft(recovery)", "function getWorkspaceCreateRequestKey");
  const gate = activation.indexOf("if (recovery.title.conflict)");
  const autoSave = activation.indexOf("savePageTitleNow().catch");
  assert.ok(gate >= 0 && autoSave > gate, "auto-save must remain behind the recovery conflict gate");
});
