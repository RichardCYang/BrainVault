function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function reproduceVulnerable() {
  let navigationGeneration = 1;
  const state = {
    selectedPageId: "page-a",
    workspaceView: "page",
    activeCollectionId: null
  };
  const deleteResponse = deferred();
  const selectedPageWasDeleted = true;

  const deletion = (async () => {
    await deleteResponse.promise;
    if (selectedPageWasDeleted) {
      state.selectedPageId = null;
    }
    navigationGeneration += 1;
    state.workspaceView = "collection";
    state.activeCollectionId = "default";
  })();

  navigationGeneration += 1;
  state.selectedPageId = "page-b";
  state.workspaceView = "page";
  deleteResponse.resolve();
  await deletion;

  return {
    selectedPageId: state.selectedPageId,
    workspaceView: state.workspaceView,
    newerNavigationLost: state.selectedPageId !== "page-b" || state.workspaceView !== "page"
  };
}

async function reproduceFixed() {
  let navigationGeneration = 1;
  const initiatingNavigationGeneration = navigationGeneration;
  const state = {
    selectedPageId: "page-a",
    workspaceView: "page",
    activeCollectionId: null
  };
  const deleteResponse = deferred();
  const selectedPageWasDeleted = true;

  const deletion = (async () => {
    await deleteResponse.promise;
    const shouldClearDeletedSelection =
      selectedPageWasDeleted
      && initiatingNavigationGeneration === navigationGeneration
      && state.selectedPageId === "page-a";

    if (shouldClearDeletedSelection) {
      state.selectedPageId = null;
    }

    if (
      initiatingNavigationGeneration === navigationGeneration
      && shouldClearDeletedSelection
    ) {
      state.workspaceView = "collection";
      state.activeCollectionId = "default";
    }
  })();

  navigationGeneration += 1;
  state.selectedPageId = "page-b";
  state.workspaceView = "page";
  deleteResponse.resolve();
  await deletion;

  return {
    selectedPageId: state.selectedPageId,
    workspaceView: state.workspaceView,
    newerNavigationPreserved: state.selectedPageId === "page-b" && state.workspaceView === "page"
  };
}

console.log(JSON.stringify({
  vulnerable: await reproduceVulnerable(),
  fixed: await reproduceFixed()
}, null, 2));
