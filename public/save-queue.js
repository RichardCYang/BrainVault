export function createLatestWriteQueue(writer) {
  if (typeof writer !== "function") throw new TypeError("writer must be a function");

  let pendingTask = null;
  let runningPromise = null;
  let lastResult;

  async function drain() {
    while (pendingTask !== null) {
      const task = pendingTask;
      pendingTask = null;
      try {
        lastResult = await writer(task);
      } catch (error) {
        // Preserve the failed task unless a newer task was queued while it was running.
        if (pendingTask === null) pendingTask = task;
        throw error;
      }
    }
    return lastResult;
  }

  function ensureRunning() {
    if (!runningPromise) {
      runningPromise = drain().finally(() => {
        runningPromise = null;
      });
    }
    return runningPromise;
  }

  return {
    enqueue(task) {
      // Only the latest not-yet-started task matters. A running task is never interrupted.
      pendingTask = task;
      return ensureRunning();
    },
    async flush() {
      while (pendingTask !== null || runningPromise) {
        await ensureRunning();
      }
      return lastResult;
    },
    discard() {
      pendingTask = null;
    },
    get busy() {
      return pendingTask !== null || Boolean(runningPromise);
    }
  };
}
