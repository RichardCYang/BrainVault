import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPageTransitionLock } from "../public/page-transition-lock.js";

function createMemoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
}

function createQueuedLockManager() {
  const resources = new Map();
  const stateFor = (name) => {
    let state = resources.get(name);
    if (!state) {
      state = { held: [], queue: [] };
      resources.set(name, state);
    }
    return state;
  };

  const process = (name) => {
    const state = stateFor(name);
    if (!state.queue.length) return;
    const first = state.queue[0];
    const hasExclusive = state.held.some((lock) => lock.mode === "exclusive");

    if (first.mode === "exclusive") {
      if (state.held.length) return;
      grant(name, state, first);
      return;
    }
    if (hasExclusive) return;
    while (state.queue[0]?.mode === "shared") grant(name, state, state.queue[0]);
  };

  const grant = (name, state, request) => {
    state.queue.shift();
    request.signal?.removeEventListener("abort", request.onAbort);
    const lock = { name, mode: request.mode };
    state.held.push(lock);
    Promise.resolve()
      .then(() => request.callback(lock))
      .then(request.resolve, request.reject)
      .finally(() => {
        const index = state.held.indexOf(lock);
        if (index >= 0) state.held.splice(index, 1);
        process(name);
      });
  };

  return {
    request(name, options = {}, callback) {
      const state = stateFor(name);
      const mode = options.mode ?? "exclusive";
      if (options.ifAvailable) {
        const unavailable = state.held.length > 0 || state.queue.length > 0;
        if (unavailable) return Promise.resolve(callback(null));
      }
      if (options.signal?.aborted) {
        return Promise.reject(new DOMException("Lock request aborted", "AbortError"));
      }
      return new Promise((resolve, reject) => {
        const request = { mode, callback, resolve, reject, signal: options.signal, onAbort: null };
        request.onAbort = () => {
          const index = state.queue.indexOf(request);
          if (index < 0) return;
          state.queue.splice(index, 1);
          reject(new DOMException("Lock request aborted", "AbortError"));
          process(name);
        };
        request.signal?.addEventListener("abort", request.onAbort, { once: true });
        state.queue.push(request);
        process(name);
      });
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("exclusive page transition waits for a slow shared writer drain instead of a timer", async () => {
  const storage = createMemoryStorage();
  const lockManager = createQueuedLockManager();
  const writer = createPageTransitionLock(storage, { sourceId: "writer", lockManager });
  const destructive = createPageTransitionLock(storage, { sourceId: "destructive", lockManager });
  const writerReady = deferred();
  const releaseWriter = deferred();

  const writerRun = writer.runWriterShared(
    ["page-1", "__workspace__:user-1"],
    async () => {
      writerReady.resolve();
      await releaseWriter.promise;
    }
  );
  await writerReady.promise;

  let destructiveRan = false;
  const destructiveRun = destructive.runWriterExclusive("page-1", async () => {
    destructiveRan = true;
    return "archived";
  });

  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(destructiveRan, false, "the old 50 ms window must not authorize destruction");

  releaseWriter.resolve();
  await writerRun;
  const result = await destructiveRun;
  assert.equal(result.acquired, true);
  assert.equal(result.value, "archived");
  assert.equal(destructiveRan, true);
});

test("workspace writer barrier waits for every page writer in the workspace", async () => {
  const storage = createMemoryStorage();
  const lockManager = createQueuedLockManager();
  const first = createPageTransitionLock(storage, { sourceId: "tab-a", lockManager });
  const second = createPageTransitionLock(storage, { sourceId: "tab-b", lockManager });
  const transition = createPageTransitionLock(storage, { sourceId: "transition", lockManager });
  const readyA = deferred();
  const readyB = deferred();
  const releaseA = deferred();
  const releaseB = deferred();

  const writerA = first.runWriterShared(["page-a", "__workspace__:user-1"], async () => {
    readyA.resolve();
    await releaseA.promise;
  });
  const writerB = second.runWriterShared(["page-b", "__workspace__:user-1"], async () => {
    readyB.resolve();
    await releaseB.promise;
  });
  await Promise.all([readyA.promise, readyB.promise]);

  let ran = false;
  const exclusive = transition.runWriterExclusive("__workspace__:user-1", async () => {
    ran = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ran, false);
  releaseA.resolve();
  await writerA;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ran, false, "all workspace writers must drain");
  releaseB.resolve();
  await writerB;
  await exclusive;
  assert.equal(ran, true);
});

test("UI mutation and archive paths contain the new fail-closed guards", async () => {
  const client = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(client, /waitForPageTransitionPropagation/);
  assert.match(client, /pageTransitionLock\.runWriterShared\(/);
  assert.match(client, /pageTransitionLock\.runWriterExclusive\(/);
  assert.match(client, /stopPageWriterSession\(\{ flush: true \}\)/);

  const titleBeforeInput = client.indexOf('elements.pageTitle.addEventListener("beforeinput"');
  const titleDirection = client.indexOf("const direction = getEditorHistoryInputDirection", titleBeforeInput);
  const titleFence = client.indexOf("if (!requireWritablePage({ announce: false }))", titleBeforeInput);
  assert.ok(titleBeforeInput >= 0 && titleFence > titleBeforeInput && titleFence < titleDirection);
  assert.match(client.slice(titleBeforeInput, client.indexOf('elements.pageTitle.addEventListener("blur"')), /durableDraft\?\.value[\s\S]*pageTitleLastDurableValue/);

  const changeHandler = client.indexOf('elements.blockList.addEventListener("change"');
  const changeEnd = client.indexOf("async function handleListBlockEnter", changeHandler);
  assert.match(client.slice(changeHandler, changeEnd), /restoreBlockRowFromDurableState\(row\)/);

  const tableReplace = client.indexOf("function replaceTableData");
  const tableEnd = client.indexOf("function handleTableAction", tableReplace);
  const tableSource = client.slice(tableReplace, tableEnd);
  assert.match(tableSource, /requireWritablePage\(\{ announce: false \}\)/);
  assert.match(tableSource, /if \(!scheduleBlockSave\(row\)\)[\s\S]*restoreBlockRowFromDurableState\(row\)/);

  const archive = client.indexOf("async function archivePageIdempotently");
  const archiveEnd = client.indexOf("for (const eventName", archive);
  const archiveSource = client.slice(archive, archiveEnd);
  assert.match(archiveSource, /mutationId: task\.mutationId/);
  assert.match(archiveSource, /if \(!isAmbiguousApiError\(error\) \|\| attempt >= 2\) throw error/);
  assert.match(archiveSource, /archivePageWithReconciliation/);
  assert.match(archiveSource, /lockPageWriteOutcomeFence\(pageId\)/);
  assert.match(archiveSource, /data\?\.page\?\.isArchived === true/);
});
