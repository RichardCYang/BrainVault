import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const calls = [];
const queues = new Map([
  ["visible-block", { flush: async () => calls.push("visible-block") }],
  ["detached-block", { flush: async () => calls.push("detached-block") }]
]);
const visibleBlockIds = new Set(["visible-block"]);

console.log("1. Create two pending block queues; detach one row from the DOM model.");
console.log("2. Run the previous DOM-filtered navigation flush.");
await Promise.all(
  [...queues.entries()]
    .filter(([blockId]) => visibleBlockIds.has(blockId))
    .map(([, queue]) => queue.flush())
);
console.log(`   old strategy flushed: ${calls.join(", ")}`);
assert.deepEqual(calls, ["visible-block"]);
console.log("   reproduced: detached-block was skipped, so a subsequent tracking reset could drop its settlement barrier.");

console.log("3. Run the patched registry-based flush.");
calls.length = 0;
await Promise.all([...queues.values()].map((queue) => queue.flush()));
console.log(`   fixed strategy flushed: ${calls.sort().join(", ")}`);
assert.deepEqual(calls, ["detached-block", "visible-block"]);

const flushStart = appSource.indexOf("async function flushPendingPageEdits(");
const flushEnd = appSource.indexOf("\nfunction applyMaterializedHtmlCaches", flushStart);
const flushSource = appSource.slice(flushStart, flushEnd);
assert.match(flushSource, /\[\.\.\.blockSaveQueues\.values\(\)\]\.map\(\(queue\) => queue\.flush\(\)\)/);
assert.doesNotMatch(flushSource, /visibleBlockIds/);
console.log("4. Verified public/app.js implements the registry-based barrier.");
