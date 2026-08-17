import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createLatestWriteQueue } from "../public/save-queue.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function structuredMetadataError() {
  return Object.assign(new Error("Structured block data exceeds the lossless storage limits. Nothing was saved."), {
    status: 400,
    code: "BLOCK_METADATA_WOULD_TRUNCATE"
  });
}

test("a definitive structured metadata rejection does not remain in the retry slot", async () => {
  const calls = [];
  const error = structuredMetadataError();
  const queue = createLatestWriteQueue(async (task) => {
    calls.push(task);
    if (task === "invalid") throw error;
    return task;
  }, {
    shouldRetry: (caught) => caught?.ambiguous === true
  });

  await assert.rejects(queue.enqueue("invalid"), (caught) => caught === error);
  assert.equal(queue.busy, false);
  assert.equal(await queue.enqueue("valid"), "valid");
  assert.deepEqual(calls, ["invalid", "valid"]);
});

test("a newer canonical structured payload supersedes an older rejected snapshot", async () => {
  const first = deferred();
  const calls = [];
  const error = structuredMetadataError();
  const queue = createLatestWriteQueue(async (task) => {
    calls.push(task);
    if (task === "stale") await first.promise;
    return task;
  }, {
    shouldRetry: () => false,
    canSupersede: (caught) => caught?.code === "BLOCK_METADATA_WOULD_TRUNCATE"
  });

  const saving = queue.enqueue("stale");
  queue.enqueue("canonical");
  await Promise.resolve();
  first.reject(error);

  assert.equal(await saving, "canonical");
  assert.deepEqual(calls, ["stale", "canonical"]);
  assert.equal(queue.busy, false);
});

test("an ambiguous write is still retried before a newer edit", async () => {
  const first = deferred();
  const calls = [];
  let staleAttempts = 0;
  const queue = createLatestWriteQueue(async (task) => {
    calls.push(task);
    if (task === "stale" && staleAttempts++ === 0) await first.promise;
    return task;
  }, {
    shouldRetry: (caught) => caught?.ambiguous === true
  });

  const saving = queue.enqueue("stale");
  queue.enqueue("latest");
  await Promise.resolve();
  first.reject(Object.assign(new Error("response lost"), { ambiguous: true }));

  await assert.rejects(saving, /response lost/);
  assert.equal(await queue.flush(), "latest");
  assert.deepEqual(calls, ["stale", "stale", "latest"]);
  assert.equal(queue.busy, false);
});


test("the browser block queue wires HTTP-aware retry and structured supersession policies", async () => {
  const client = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(client, /function canSupersedeBlockSaveError\(error\)/);
  assert.match(client, /error\?\.code === "BLOCK_METADATA_WOULD_TRUNCATE"/);
  assert.match(
    client,
    /shouldRetry: isAmbiguousApiError,\s*canSupersede: canSupersedeBlockSaveError/
  );
});

test("discard exposes a settlement barrier for an in-flight write and drops queued work", async () => {
  const first = deferred();
  const calls = [];
  const queue = createLatestWriteQueue(async (task) => {
    calls.push(task);
    if (task === "running") return first.promise;
    return task;
  });

  const running = queue.enqueue("running");
  queue.enqueue("pending");
  await Promise.resolve();

  let barrierSettled = false;
  const discarded = queue.discard().then(() => { barrierSettled = true; });
  await Promise.resolve();
  assert.equal(barrierSettled, false, "discard must wait for the request already on the wire");

  first.resolve("committed");
  await discarded;
  assert.equal(await running, "committed");
  assert.deepEqual(calls, ["running"], "the queued edit must remain discarded");
  assert.equal(queue.busy, false);
});

test("direct block deletions await discarded in-flight saves before taking deletion snapshots", async () => {
  const client = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const discardStart = client.indexOf("function discardBlockSave(blockId)");
  const discardEnd = client.indexOf("function lockPageEdits", discardStart);
  const discardSource = client.slice(discardStart, discardEnd);
  assert.match(discardSource, /const discardedSaveSettlement = blockSaveQueues\.get\(blockId\)\?\.discard\(\) \?\? Promise\.resolve\(\);/);
  assert.match(discardSource, /return discardedSaveSettlement;/);

  const awaitedDiscards = [...client.matchAll(/await discardBlockSave\(blockId\);/g)];
  assert.equal(awaitedDiscards.length, 3, "every direct destructive block-delete path must wait for settlement");
  for (const match of awaitedDiscards) {
    const after = client.slice(match.index, match.index + 220);
    assert.match(after, /await deleteBlockWithVersionCheck\(blockId/);
  }
});
