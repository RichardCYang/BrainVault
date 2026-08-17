export function createLatestWriteQueue(
  writer,
  { shouldRetry = () => true, canSupersede = () => false } = {}
) {
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
        if (taskGeneration !== discardGeneration) throw error;

        // Only failures with an unknown commit outcome belong in the retry slot. Keeping a
        // definitive 4xx validation failure here would replay the same rejected payload forever
        // and prevent every newer edit from reaching the writer.
        if (shouldRetry(error, task)) {
          retryTask = task;
          throw error;
        }

        // A structured editor can enqueue a canonical payload while an older transient snapshot
        // is still in flight. When that older snapshot is definitively rejected, allow the newer
        // snapshot to replace it instead of surfacing a stale error and stopping the drain.
        if (pendingTask !== null && canSupersede(error, task, pendingTask)) continue;
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
      // A destructive caller may intentionally drop queued edits while a write is already
      // on the wire. Expose a non-throwing settlement barrier so it can wait until that
      // request can no longer race the version snapshot used by the destructive mutation.
      const discardedRunningPromise = runningPromise;
      return discardedRunningPromise
        ? discardedRunningPromise.then(() => undefined, () => undefined)
        : Promise.resolve();
    },
    get busy() {
      return retryTask !== null || pendingTask !== null || Boolean(runningPromise);
    }
  };
}
