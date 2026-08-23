function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function runScenario(stage, fixed) {
  let navigationGeneration = 1;
  let selectedPageId = "page-a";
  let staleDeleteRequestSent = false;
  const initiatingNavigationGeneration = navigationGeneration;
  const snapshotWait = deferred();
  const transitionWait = deferred();
  const requestPreflightWait = deferred();

  const deletion = (async () => {
    await snapshotWait.promise;
    if (fixed && initiatingNavigationGeneration !== navigationGeneration) return;
    await transitionWait.promise;
    if (fixed && initiatingNavigationGeneration !== navigationGeneration) return;
    await requestPreflightWait.promise;
    if (fixed && initiatingNavigationGeneration !== navigationGeneration) return;
    staleDeleteRequestSent = true;
  })();

  if (stage !== "snapshot") snapshotWait.resolve();
  await Promise.resolve();
  if (stage === "request-preflight") transitionWait.resolve();
  if (stage === "transition") {
    navigationGeneration += 1;
    selectedPageId = "page-b";
    transitionWait.resolve();
    requestPreflightWait.resolve();
  } else if (stage === "snapshot") {
    navigationGeneration += 1;
    selectedPageId = "page-b";
    snapshotWait.resolve();
    transitionWait.resolve();
    requestPreflightWait.resolve();
  } else {
    await Promise.resolve();
    navigationGeneration += 1;
    selectedPageId = "page-b";
    requestPreflightWait.resolve();
  }
  await deletion;

  return {
    selectedPageId,
    staleDeleteRequestSent,
    newerNavigationPreserved: selectedPageId === "page-b"
  };
}

const stages = ["snapshot", "transition", "request-preflight"];
const vulnerable = {};
const fixed = {};
for (const stage of stages) {
  vulnerable[stage] = await runScenario(stage, false);
  fixed[stage] = await runScenario(stage, true);
}

console.log(JSON.stringify({ vulnerable, fixed }, null, 2));
