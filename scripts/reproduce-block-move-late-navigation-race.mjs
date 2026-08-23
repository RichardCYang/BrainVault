function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function runPreSubmitScenario(stage, fixed) {
  let navigationGeneration = 1;
  let selectedPageId = "page-a";
  let staleMoveRequestSent = false;
  const initiatingNavigationGeneration = navigationGeneration;
  const transitionWait = deferred();
  const requestPreflightWait = deferred();

  const move = (async () => {
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
    staleMoveRequestSent = true;
  })();

  if (stage === "request-preflight") {
    transitionWait.resolve();
    await Promise.resolve();
  }

  navigationGeneration += 1;
  selectedPageId = "page-b";
  transitionWait.resolve();
  requestPreflightWait.resolve();
  await move;

  return {
    selectedPageId,
    staleMoveRequestSent,
    newerNavigationPreserved: selectedPageId === "page-b"
  };
}

async function runPostSubmitCleanupScenario(fixed) {
  let selectedPageId = "page-a";
  const sourcePageId = "page-a";
  const targetPageId = "page-b";
  const movedBlockId = "block-1";
  const sourceDraftScope = sourcePageId;
  const drafts = new Map([
    [`${sourcePageId}:${movedBlockId}`, "source recovery copy"]
  ]);
  const responseWait = deferred();

  const move = (async () => {
    const data = await responseWait.promise;
    const cleanupPageId = fixed ? sourceDraftScope : selectedPageId;
    drafts.delete(`${cleanupPageId}:${data.movedBlockId}`);
  })();

  // The server has already committed the move. A navigation fetch sees the
  // moved block on the destination page, where the user makes a newer edit
  // before the original POST response reaches this tab.
  selectedPageId = targetPageId;
  drafts.set(`${targetPageId}:${movedBlockId}`, "newer destination edit");
  responseWait.resolve({ movedBlockId });
  await move;

  return {
    sourceDraftRemoved: !drafts.has(`${sourcePageId}:${movedBlockId}`),
    destinationDraftPreserved: drafts.get(`${targetPageId}:${movedBlockId}`) === "newer destination edit"
  };
}

const vulnerable = {};
const fixed = {};
for (const stage of ["transition", "request-preflight"]) {
  vulnerable[stage] = await runPreSubmitScenario(stage, false);
  fixed[stage] = await runPreSubmitScenario(stage, true);
}
vulnerable["post-submit-cleanup"] = await runPostSubmitCleanupScenario(false);
fixed["post-submit-cleanup"] = await runPostSubmitCleanupScenario(true);

console.log(JSON.stringify({ vulnerable, fixed }, null, 2));
