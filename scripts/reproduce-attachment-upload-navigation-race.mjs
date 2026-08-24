function deferred() {
  let resolve;
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function reproduce(stage, { fixed }) {
  let navigationGeneration = 1;
  let workspaceView = "page";
  let selectedPageId = "page-a";
  let staleAttachmentCreateRequestSent = false;

  const initiatingNavigation = navigationGeneration;
  const initiatingPageId = selectedPageId;
  const blockFlush = deferred();
  const requestPreflight = deferred();
  const reachedRequestPreflight = deferred();

  const isUploadIntentCurrent = () => (
    navigationGeneration === initiatingNavigation
    && workspaceView === "page"
    && selectedPageId === initiatingPageId
  );

  const upload = (async () => {
    // The real upload can wait here for a dirty source block to save/flush.
    await blockFlush.promise;

    // Fixed code checks again after that asynchronous wait.
    if (fixed && !isUploadIntentCurrent()) return;

    // api() has asynchronous request preparation before fetch. The real fix
    // passes the same guard through beforeFetch so this later window is fenced.
    reachedRequestPreflight.resolve();
    await requestPreflight.promise;
    if (fixed && !isUploadIntentCurrent()) return;

    staleAttachmentCreateRequestSent = !isUploadIntentCurrent();
  })();

  if (stage === "block-flush") {
    navigationGeneration += 1;
    selectedPageId = "page-b";
    blockFlush.resolve();
    requestPreflight.resolve();
  } else if (stage === "request-preflight") {
    blockFlush.resolve();
    await reachedRequestPreflight.promise;
    navigationGeneration += 1;
    selectedPageId = "page-b";
    requestPreflight.resolve();
  } else {
    throw new Error(`unknown stage: ${stage}`);
  }

  await upload;
  return {
    staleAttachmentCreateRequestSent,
    newerNavigationPreserved: selectedPageId === "page-b" && navigationGeneration === 2
  };
}

const stages = ["block-flush", "request-preflight"];
const result = { vulnerable: {}, fixed: {} };

for (const stage of stages) {
  result.vulnerable[stage] = await reproduce(stage, { fixed: false });
  result.fixed[stage] = await reproduce(stage, { fixed: true });
}

console.log(JSON.stringify(result, null, 2));
