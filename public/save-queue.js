export function createLatestWriteQueue(writer) {
  let retryTask = null;
  let pendingTask = null;
  let runningPromise = null;
  let discardGeneration = 0;
  let lastResult;

  async function drain() {
    while (retryTask !== null || pendingTask !== null) {
      const isRetry = retryTask !== null;
      const task = isRetry ? retryTask : pendingTask;
      const taskGeneration = discardGeneration;
      if (isRetry) retryTask = null;
      else pendingTask = null;

      try {
        lastResult = await writer(task);
      } catch (error) {
        // A failed write must be retried before any newer coalesced edit. Otherwise an
        // ambiguous committed write can leave the newer edit stuck on a stale version.
        if (taskGeneration === discardGeneration) retryTask = task;
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
      // Only the latest not-yet-started task matters. A running or failed task is never interrupted.
      pendingTask = task;
      return ensureRunning();
    },
    async flush() {
      while (retryTask !== null || pendingTask !== null || runningPromise) {
        await ensureRunning();
      }
      return lastResult;
    },
    discard() {
      discardGeneration += 1;
      retryTask = null;
      pendingTask = null;
    },
    get busy() {
      return retryTask !== null || pendingTask !== null || Boolean(runningPromise);
    }
  };
}
