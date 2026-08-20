function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function runAfterFetchScenario({ fixed, fails }) {
  const state = {
    generation: 10,
    selectedPage: { id: "page-a", snapshot: "initial" },
    sessionStarts: 0,
    forcedHome: false
  };
  const destroy = deferred();
  const fetch = deferred();

  async function destroyPageCollaboration() {
    state.generation += 1;
    await destroy.promise;
  }

  const handler = async (callbackGeneration) => {
    const refreshGeneration = callbackGeneration + 1;
    await destroyPageCollaboration();
    if (fixed && (
      refreshGeneration !== state.generation
      || state.selectedPage?.id !== "page-a"
    )) return;

    try {
      const data = await fetch.promise;
      if (fixed && (
        refreshGeneration !== state.generation
        || state.selectedPage?.id !== "page-a"
      )) return;
      state.selectedPage = data.page;
      state.sessionStarts += 1;
    } catch {
      if (fixed && (
        refreshGeneration !== state.generation
        || state.selectedPage?.id !== "page-a"
      )) return;
      state.forcedHome = true;
    }
  };

  const pending = handler(10);
  destroy.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // The user navigates away and back to the same page while the access refresh
  // request is in flight. Page-id-only checks cannot distinguish this new intent.
  state.generation += 2;
  state.selectedPage = { id: "page-a", snapshot: "newer-navigation" };

  if (fails) {
    fetch.reject(new Error("stale refresh failed"));
  } else {
    fetch.resolve({ page: { id: "page-a", snapshot: "stale-access-refresh" } });
  }
  await pending;

  return {
    selectedSnapshot: state.selectedPage.snapshot,
    sessionStarts: state.sessionStarts,
    forcedHome: state.forcedHome
  };
}

async function runDuringTeardownScenario({ fixed }) {
  const state = {
    generation: 30,
    selectedPage: { id: "page-a", snapshot: "initial" },
    apiCalls: 0
  };
  const destroy = deferred();
  const fetch = deferred();

  async function destroyPageCollaboration() {
    state.generation += 1;
    await destroy.promise;
  }

  const handler = async (callbackGeneration) => {
    const refreshGeneration = callbackGeneration + 1;
    await destroyPageCollaboration();
    if (fixed && (
      refreshGeneration !== state.generation
      || state.selectedPage?.id !== "page-a"
    )) return;

    state.apiCalls += 1;
    const data = await fetch.promise;
    if (fixed && (
      refreshGeneration !== state.generation
      || state.selectedPage?.id !== "page-a"
    )) return;
    state.selectedPage = data.page;
  };

  const pending = handler(30);

  // Navigation can also happen while session.destroy() itself is awaiting.
  state.generation += 2;
  state.selectedPage = { id: "page-a", snapshot: "newer-navigation" };
  destroy.resolve();
  await Promise.resolve();
  await Promise.resolve();
  fetch.resolve({ page: { id: "page-a", snapshot: "stale-access-refresh" } });
  await pending;

  return {
    selectedSnapshot: state.selectedPage.snapshot,
    apiCalls: state.apiCalls
  };
}

const vulnerableSuccess = await runAfterFetchScenario({ fixed: false, fails: false });
const fixedSuccess = await runAfterFetchScenario({ fixed: true, fails: false });
const vulnerableFailure = await runAfterFetchScenario({ fixed: false, fails: true });
const fixedFailure = await runAfterFetchScenario({ fixed: true, fails: true });
const vulnerableDuringTeardown = await runDuringTeardownScenario({ fixed: false });
const fixedDuringTeardown = await runDuringTeardownScenario({ fixed: true });

console.log(JSON.stringify({
  vulnerable: {
    staleRefreshOverwroteNewerSnapshot:
      vulnerableSuccess.selectedSnapshot === "stale-access-refresh",
    staleSessionStarted: vulnerableSuccess.sessionStarts === 1,
    staleFailureForcedHome: vulnerableFailure.forcedHome,
    staleRequestSurvivedNewerNavigation: vulnerableDuringTeardown.apiCalls === 1
      && vulnerableDuringTeardown.selectedSnapshot === "stale-access-refresh"
  },
  fixed: {
    newerSnapshotPreserved: fixedSuccess.selectedSnapshot === "newer-navigation",
    staleSessionSuppressed: fixedSuccess.sessionStarts === 0,
    staleFailureSuppressed: fixedFailure.forcedHome === false,
    staleRequestSuppressedAfterTeardown:
      fixedDuringTeardown.apiCalls === 0
      && fixedDuringTeardown.selectedSnapshot === "newer-navigation"
  }
}, null, 2));
