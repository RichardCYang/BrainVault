import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function flushFunctionSource() {
  const start = appSource.indexOf("async function flushPendingPageEdits(");
  const end = appSource.indexOf("\nfunction applyMaterializedHtmlCaches", start);
  assert.notEqual(start, -1, "flushPendingPageEdits must exist");
  assert.notEqual(end, -1, "flushPendingPageEdits source boundary must exist");
  return appSource.slice(start, end);
}

test("page edit flush drains every registered block save queue", () => {
  const source = flushFunctionSource();

  assert.match(
    source,
    /\[\.\.\.blockSaveQueues\.values\(\)\]\.map\(\(queue\) => queue\.flush\(\)\)/,
    "navigation/destructive flushes must wait for queues even when their rows are detached from the DOM"
  );
  assert.doesNotMatch(
    source,
    /visibleBlockIds|querySelectorAll\([^)]*data-block-id[^)]*\)[\s\S]*blockSaveQueues/,
    "queue settlement must not depend on currently rendered rows"
  );
});

test("detached queues reproduce the old visibility-filter data-loss window", async () => {
  const calls = [];
  const queues = new Map([
    ["visible", { flush: async () => calls.push("visible") }],
    ["detached", { flush: async () => calls.push("detached") }]
  ]);
  const visibleBlockIds = new Set(["visible"]);

  await Promise.all(
    [...queues.entries()]
      .filter(([blockId]) => visibleBlockIds.has(blockId))
      .map(([, queue]) => queue.flush())
  );
  assert.deepEqual(calls, ["visible"], "the old strategy silently skips the detached queue");

  calls.length = 0;
  await Promise.all([...queues.values()].map((queue) => queue.flush()));
  assert.deepEqual(calls.sort(), ["detached", "visible"], "the fixed strategy drains the registry");
});

test("explicit block deletion still owns queue discard/removal", () => {
  const start = appSource.indexOf("function discardBlockSave(");
  const end = appSource.indexOf("\nfunction ", start + 1);
  assert.notEqual(start, -1, "discardBlockSave must exist");
  const source = appSource.slice(start, end === -1 ? undefined : end);

  assert.match(source, /blockSaveQueues\.get\(blockId\)\?\.discard\(\)/, "deletion must discard an existing queue generation");
  assert.match(source, /blockSaveQueues\.delete\(blockId\)/, "deletion must remove the queue from the registry");
});
