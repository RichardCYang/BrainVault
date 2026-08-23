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
  const transitionWait = deferred();
  const requestPreflightWait = deferred();

  const deletion = (async () => {
    await transitionWait.promise;
    if (
      fixed
      && (initiatingNavigationGeneration !== navigationGeneration || selectedPageId !== "page-a")
    ) return;
    await requestPreflightWait.promise;
    if (
      fixed
      && (initiatingNavigationGeneration !== navigationGeneration || selectedPageId !== "page-a")
    ) return;
    staleDeleteRequestSent = true;
  })();

  if (stage === "request-preflight") {
    transitionWait.resolve();
    await Promise.resolve();
  }

  navigationGeneration += 1;
  selectedPageId = "page-b";
  transitionWait.resolve();
  requestPreflightWait.resolve();
  await deletion;

  return {
    selectedPageId,
    staleDeleteRequestSent,
    newerNavigationPreserved: selectedPageId === "page-b"
  };
}

const stages = ["transition", "request-preflight"];
const vulnerable = {};
const fixed = {};
for (const stage of stages) {
  vulnerable[stage] = await runScenario(stage, false);
  fixed[stage] = await runScenario(stage, true);
}

console.log(JSON.stringify({ vulnerable, fixed }, null, 2));
