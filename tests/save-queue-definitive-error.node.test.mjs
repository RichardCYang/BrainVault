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

test("an enqueue during drain settlement starts a fresh writer run", async () => {
  const first = deferred();
  const calls = [];
  const queue = createLatestWriteQueue((task) => {
    calls.push(task);
    if (task === "first") return first.promise;
    return Promise.resolve(task);
  });

  const firstCompletion = queue.enqueue("first");
  await Promise.resolve();

  let lateCompletion;
  first.promise.then(() => {
    lateCompletion = queue.enqueue("late");
  });
  first.resolve("first-result");

  assert.equal(await firstCompletion, "first-result");
  assert.equal(await lateCompletion, "late");
  assert.deepEqual(calls, ["first", "late"]);
  assert.equal(queue.busy, false);
});

test("an enqueue after discard gets a fresh runner when the discarded write later fails", async () => {
  const first = deferred();
  const calls = [];
  const error = new Error("discarded write failed");
  const queue = createLatestWriteQueue(async (task) => {
    calls.push(task);
    if (task === "old") await first.promise;
    return task;
  }, {
    shouldRetry: () => false
  });

  const oldCompletion = queue.enqueue("old");
  const oldRejection = assert.rejects(oldCompletion, (caught) => caught === error);
  await Promise.resolve();

  const discardBarrier = queue.discard();
  const newCompletion = queue.enqueue("new");
  first.reject(error);

  await discardBarrier;
  await oldRejection;
  assert.equal(await newCompletion, "new");
  assert.deepEqual(calls, ["old", "new"]);
  assert.equal(queue.busy, false);
});

test("a flush started before discard never adopts post-discard writes", async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const queue = createLatestWriteQueue(async (task) => {
    calls.push(task);
    if (task === "old") return first.promise;
    if (task === "new") return second.promise;
    return task;
  }, { shouldRetry: () => false });

  const oldCompletion = queue.enqueue("old");
  await Promise.resolve();
  let flushSettled = false;
  const oldFlush = queue.flush().then((value) => {
    flushSettled = true;
    return value;
  });
  await Promise.resolve();

  queue.discard();
  const newCompletion = queue.enqueue("new");
  first.resolve("old-result");

  assert.equal(await oldCompletion, "old-result");
  assert.equal(await oldFlush, "old-result");
  assert.equal(flushSettled, true);
  assert.deepEqual(calls, ["old", "new"]);

  second.resolve("new-result");
  assert.equal(await newCompletion, "new-result");
  assert.equal(queue.busy, false);
});

test("a discarded successful write cannot seed the next generation's empty flush", async () => {
  const first = deferred();
  const queue = createLatestWriteQueue(async (task) => {
    if (task === "old") await first.promise;
    return `${task}-result`;
  }, { shouldRetry: () => false });

  const oldCompletion = queue.enqueue("old");
  await Promise.resolve();

  const discardBarrier = queue.discard();
  first.resolve();

  assert.equal(await oldCompletion, "old-result");
  await discardBarrier;
  assert.equal(
    await queue.flush(),
    undefined,
    "the new generation must not inherit the discarded generation's acknowledgement"
  );

  assert.equal(await queue.enqueue("new"), "new-result");
  assert.equal(await queue.flush(), "new-result");
});

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

test("a definitive rejection drops a non-superseding queued edit instead of arming a later flush", async () => {
  const first = deferred();
  const calls = [];
  const error = Object.assign(new Error("optimistic conflict"), {
    status: 409,
    code: "PAGE_EDIT_CONFLICT"
  });
  const queue = createLatestWriteQueue(async (task) => {
    calls.push(task);
    if (task === "stale") await first.promise;
    return task;
  }, {
    shouldRetry: () => false
  });

  const firstCompletion = queue.enqueue("stale");
  const queuedCompletion = queue.enqueue("newer-local");
  const firstRejection = assert.rejects(firstCompletion, (caught) => caught === error);
  const queuedRejection = assert.rejects(queuedCompletion, (caught) => caught === error);
  await Promise.resolve();
  first.reject(error);

  await firstRejection;
  await queuedRejection;
  assert.deepEqual(calls, ["stale"]);
  assert.equal(queue.busy, false);
  assert.equal(await queue.flush(), undefined);
  assert.deepEqual(calls, ["stale"], "a later flush must not resurrect the rejected generation");
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


test("direct optimistic-lock conflicts require explicit overwrite admission", async () => {
  const client = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const titleSaveStart = client.indexOf("async function savePageTitleNow");
  const titleSaveEnd = client.indexOf("function schedulePageTitleSave", titleSaveStart);
  const titleSave = client.slice(titleSaveStart, titleSaveEnd);
  assert.match(titleSave, /error\?\.code === "PAGE_EDIT_CONFLICT"[\s\S]*pageTitleDraftConflict = true/);

  const blockSaveStart = client.indexOf("async function saveBlockRow");
  const blockSaveEnd = client.indexOf("function scheduleBlockSave", blockSaveStart);
  const blockSave = client.slice(blockSaveStart, blockSaveEnd);
  assert.match(blockSave, /error\?\.code === "BLOCK_EDIT_CONFLICT"[\s\S]*currentRow\.dataset\.draftConflict = "true"/);
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
    const after = client.slice(match.index, match.index + 700);
    // Auth may be revalidated in a combined auth/navigation guard; the key
    // invariant is that settlement is followed by a fail-closed auth check
    // before any destructive delete request is submitted.
    assert.match(
      after,
      /if\s*\([\s\S]{0,260}!isCurrentAuthenticatedSessionScope\(authenticationScope\)[\s\S]{0,260}\)\s*return(?: data)?;/
    );
    assert.match(after, /await deleteBlockWithVersionCheck\(blockId/);
  }
});
