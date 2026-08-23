function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function reproduceVulnerable() {
  let navigationGeneration = 1;
  let selectedPageId = "page-a";
  let staleDeleteRequestSent = false;
  const persistenceWait = deferred();

  const deletion = (async () => {
    await persistenceWait.promise;
    // Vulnerable ordering: the delete inherits whatever navigation is current
    // after the asynchronous wait instead of the generation that initiated it.
    const initiatingNavigationGeneration = navigationGeneration;
    if (initiatingNavigationGeneration !== navigationGeneration) return;
    staleDeleteRequestSent = true;
  })();

  navigationGeneration += 1;
  selectedPageId = "page-b";
  persistenceWait.resolve();
  await deletion;

  return {
    selectedPageId,
    staleDeleteRequestSent,
    newerNavigationPreserved: selectedPageId === "page-b"
  };
}

async function reproduceFixed() {
  let navigationGeneration = 1;
  let selectedPageId = "page-a";
  let staleDeleteRequestSent = false;
  const persistenceWait = deferred();
  const initiatingNavigationGeneration = navigationGeneration;

  const deletion = (async () => {
    await persistenceWait.promise;
    if (initiatingNavigationGeneration !== navigationGeneration) return;
    staleDeleteRequestSent = true;
  })();

  navigationGeneration += 1;
  selectedPageId = "page-b";
  persistenceWait.resolve();
  await deletion;

  return {
    selectedPageId,
    staleDeleteRequestSent,
    newerNavigationPreserved: selectedPageId === "page-b"
  };
}

console.log(JSON.stringify({
  vulnerable: await reproduceVulnerable(),
  fixed: await reproduceFixed()
}, null, 2));
