export function createLatestWriteQueue(
  writer,
  { shouldRetry = () => true, canSupersede = () => false } = {}
) {
  let retryTask = null;
  let retryGeneration = null;
  let pendingTask = null;
  let pendingGeneration = null;
  let runningPromise = null;
  let runningGeneration = null;
  let discardGeneration = 0;
  let lastResult;

  async function drain(ownerPromise, ownerGeneration) {
    while (
      (retryTask !== null && retryGeneration === ownerGeneration)
      || (pendingTask !== null && pendingGeneration === ownerGeneration)
    ) {
      const isRetry = retryTask !== null && retryGeneration === ownerGeneration;
      const task = isRetry ? retryTask : pendingTask;
      const taskGeneration = isRetry ? retryGeneration : pendingGeneration;
      if (isRetry) {
        retryTask = null;
        retryGeneration = null;
      } else {
        pendingTask = null;
        pendingGeneration = null;
      }

      try {
        lastResult = await writer(task);
      } catch (error) {
        if (taskGeneration !== discardGeneration) throw error;

        // Only failures with an unknown commit outcome belong in the retry slot. Keeping a
        // definitive 4xx validation failure here would replay the same rejected payload forever
        // and prevent every newer edit from reaching the writer.
        if (shouldRetry(error, task)) {
          retryTask = task;
          retryGeneration = taskGeneration;
          throw error;
        }

        // A structured editor can enqueue a canonical payload while an older transient snapshot
        // is still in flight. When that older snapshot is definitively rejected, allow the newer
        // snapshot to replace it instead of surfacing a stale error and stopping the drain.
        if (
          pendingTask !== null
          && pendingGeneration === taskGeneration
          && canSupersede(error, task, pendingTask)
        ) continue;
        throw error;
      }
    }

    // Release successful-run ownership before this async function settles. A task enqueued
    // from another reaction to the writer's completion can then start a fresh drain instead
    // of inheriting a run that already decided the queue was empty.
    if (runningPromise === ownerPromise) {
      runningPromise = null;
      runningGeneration = null;
    }
    return lastResult;
  }

  function ensureRunning(targetGeneration = discardGeneration) {
    // A second discard may supersede a task while it is waiting for an older
    // generation's writer to settle. Do not let that obsolete waiter revive work.
    if (targetGeneration !== discardGeneration) return Promise.resolve(lastResult);

    if (runningPromise) {
      if (runningGeneration === targetGeneration) return runningPromise;

      // A discard deliberately keeps the old request on the wire as a settlement
      // barrier. New edits belong to the new generation and must wait for that
      // barrier, then start a fresh drain instead of inheriting the stale outcome.
      const staleRunningPromise = runningPromise;
      return staleRunningPromise.then(
        () => ensureRunning(targetGeneration),
        () => ensureRunning(targetGeneration)
      );
    }

    let resolveRun;
    let rejectRun;
    const ownerPromise = new Promise((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    runningPromise = ownerPromise;
    runningGeneration = targetGeneration;

    // drain() starts synchronously, so the first queued task is claimed immediately just as
    // before. The pre-installed owner promise closes the completion gap without delaying that
    // admission. On failure, retain ownership until the rejection is propagated so retry and
    // discard semantics remain unchanged.
    drain(ownerPromise, targetGeneration).then(
      (value) => resolveRun(value),
      (error) => {
        if (runningPromise === ownerPromise) {
          runningPromise = null;
          runningGeneration = null;
        }
        rejectRun(error);
      }
    );
    return ownerPromise;
  }

  return {
    enqueue(task) {
      // Only the latest not-yet-started task matters. A running or failed task is never interrupted.
      pendingTask = task;
      pendingGeneration = discardGeneration;
      return ensureRunning(discardGeneration);
    },
    async flush() {
      while (retryTask !== null || pendingTask !== null || runningPromise) {
        await ensureRunning(discardGeneration);
      }
      return lastResult;
    },
    discard() {
      discardGeneration += 1;
      retryTask = null;
      retryGeneration = null;
      pendingTask = null;
      pendingGeneration = null;
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
