import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPageTransitionLock } from "../public/page-transition-lock.js";

const appUrl = new URL("../public/app.js", import.meta.url);

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

  function stateFor(name) {
    let state = resources.get(name);
    if (!state) {
      state = { held: [], queue: [] };
      resources.set(name, state);
    }
    return state;
  }

  function process(name) {
    const state = stateFor(name);
    if (!state.queue.length) return;
    const first = state.queue[0];
    const hasExclusive = state.held.some((lock) => lock.mode === "exclusive");
    if (first.mode === "exclusive") {
      if (!state.held.length) grant(name, state, first);
      return;
    }
    if (hasExclusive) return;
    while (state.queue[0]?.mode === "shared") grant(name, state, state.queue[0]);
  }

  function grant(name, state, request) {
    state.queue.shift();
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
  }

  return {
    request(name, options = {}, callback) {
      const state = stateFor(name);
      const mode = options.mode ?? "exclusive";
      if (options.ifAvailable) {
        const unavailable = state.held.length > 0 || state.queue.length > 0;
        if (unavailable) return Promise.resolve(callback(null));
      }
      return new Promise((resolve, reject) => {
        state.queue.push({ mode, callback, resolve, reject });
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

test("delegated page delete binds the target owner's workspace barrier", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("async function deleteNavigationTarget()");
  const end = source.indexOf("\nfunction renderCollectionView", start);
  assert.ok(start >= 0 && end > start);
  const deletion = source.slice(start, end);

  const ownerIndex = deletion.indexOf(
    "const deletionOwnerId = getPageSummaryById(target.id)?.ownerId"
  );
  const firstAwait = deletion.indexOf("await ");
  const transitionIndex = deletion.indexOf(
    'withWorkspacePersistenceTransitionForOwner(deletionOwnerId, "page-delete"'
  );

  assert.ok(ownerIndex >= 0, "delete intent must capture the target page owner");
  assert.ok(ownerIndex < firstAwait, "owner scope must be bound before asynchronous waits");
  assert.match(deletion.slice(ownerIndex, firstAwait), /if \(!deletionOwnerId\)[\s\S]*throw new Error/);
  assert.ok(transitionIndex > ownerIndex, "delete must enter the target owner's workspace barrier");
  assert.doesNotMatch(deletion, /withWorkspacePersistenceTransition\("page-delete"/);
});

test("owner-scoped delete waits for a delegated page writer while actor-scoped delete does not", async () => {
  const storage = createMemoryStorage();
  const lockManager = createQueuedLockManager();
  const writer = createPageTransitionLock(storage, { sourceId: "writer-tab", lockManager });
  const destructive = createPageTransitionLock(storage, { sourceId: "delete-tab", lockManager });
  const writerReady = deferred();
  const releaseWriter = deferred();
  const ownerWorkspaceId = "__workspace__:owner-user";
  const actorWorkspaceId = "__workspace__:admin-user";

  const writerRun = writer.runWriterShared(["page-1", ownerWorkspaceId], async () => {
    writerReady.resolve();
    await releaseWriter.promise;
  });
  await writerReady.promise;

  let actorScopedRan = false;
  const actorScoped = destructive.runWriterExclusive(actorWorkspaceId, async () => {
    actorScopedRan = true;
  });
  await actorScoped;
  assert.equal(
    actorScopedRan,
    true,
    "the old actor-scoped barrier is independent of the owner-scoped page writer"
  );

  let ownerScopedRan = false;
  const ownerScoped = destructive.runWriterExclusive(ownerWorkspaceId, async () => {
    ownerScopedRan = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    ownerScopedRan,
    false,
    "the fixed owner-scoped barrier must wait for the page writer to drain"
  );

  releaseWriter.resolve();
  await writerRun;
  await ownerScoped;
  assert.equal(ownerScopedRan, true);
});
