function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function reproduceVulnerable() {
  const state = { selectedPageId: null };
  const pageA = deferred();
  const pageB = deferred();

  const open = async (request) => {
    const page = await request.promise;
    state.selectedPageId = page.id;
  };

  const firstClick = open(pageA);
  const secondClick = open(pageB);
  pageB.resolve({ id: "page-b" });
  await secondClick;
  pageA.resolve({ id: "page-a" });
  await firstClick;
  const slowerFirstClickOverwroteLatestIntent = state.selectedPageId === "page-a";

  const failingA = deferred();
  const succeedingB = deferred();
  const surfacedErrors = [];
  const staleFailure = open(failingA).catch((error) => surfacedErrors.push(error.message));
  const latestSuccess = open(succeedingB);
  succeedingB.resolve({ id: "page-b" });
  await latestSuccess;
  failingA.reject(new Error("page-a failed"));
  await staleFailure;

  return {
    selectedPageId: state.selectedPageId,
    slowerFirstClickOverwroteLatestIntent,
    staleFirstFailureSurfaced: surfacedErrors.includes("page-a failed")
  };
}

async function reproduceFixed() {
  const state = { selectedPageId: null };
  let generation = 0;
  const pageA = deferred();
  const pageB = deferred();

  const open = async (request) => {
    const requestGeneration = ++generation;
    let page;
    try {
      page = await request.promise;
    } catch (error) {
      if (requestGeneration !== generation) return { staleErrorSuppressed: true };
      throw error;
    }
    if (requestGeneration !== generation) return { staleResultSuppressed: true };
    state.selectedPageId = page.id;
    return { applied: true };
  };

  const firstClick = open(pageA);
  const secondClick = open(pageB);
  pageB.resolve({ id: "page-b" });
  await secondClick;
  pageA.resolve({ id: "page-a" });
  await firstClick;

  const failingA = deferred();
  const succeedingB = deferred();
  const staleFailure = open(failingA);
  const latestSuccess = open(succeedingB);
  succeedingB.resolve({ id: "page-b" });
  await latestSuccess;
  failingA.reject(new Error("page-a failed"));
  const staleFailureResult = await staleFailure;

  return {
    selectedPageId: state.selectedPageId,
    latestClickPreserved: state.selectedPageId === "page-b",
    staleFirstFailureSuppressed: staleFailureResult?.staleErrorSuppressed === true
  };
}

console.log(JSON.stringify({
  vulnerable: await reproduceVulnerable(),
  fixed: await reproduceFixed()
}, null, 2));
