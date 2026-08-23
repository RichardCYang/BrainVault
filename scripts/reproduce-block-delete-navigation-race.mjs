function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function reproduceVulnerable() {
  const state = {
    selectedPageId: "page-a",
    blocksByPage: new Map([
      ["page-a", ["block-a"]],
      ["page-b", []]
    ])
  };
  const deleteResponse = deferred();

  const deleteEmptyBlock = (async () => {
    await deleteResponse.promise;
    state.blocksByPage.set("page-a", []);
    const refreshPageId = state.selectedPageId;
    if ((state.blocksByPage.get(refreshPageId) ?? []).length === 0) {
      state.blocksByPage.get(refreshPageId).push("starter");
    }
  })();

  state.selectedPageId = "page-b";
  deleteResponse.resolve();
  await deleteEmptyBlock;

  return {
    selectedPageId: state.selectedPageId,
    pageBBlocks: state.blocksByPage.get("page-b"),
    wrongPageStarterCreated: state.blocksByPage.get("page-b").includes("starter")
  };
}

async function reproduceFixed() {
  let navigationGeneration = 1;
  const state = {
    selectedPageId: "page-a",
    blocksByPage: new Map([
      ["page-a", ["block-a"]],
      ["page-b", []]
    ])
  };
  const deleteResponse = deferred();
  const pageId = state.selectedPageId;
  const initiatingNavigationGeneration = navigationGeneration;

  const deleteEmptyBlock = (async () => {
    await deleteResponse.promise;
    state.blocksByPage.set(pageId, []);
    if (
      initiatingNavigationGeneration !== navigationGeneration
      || state.selectedPageId !== pageId
    ) return;
    if ((state.blocksByPage.get(pageId) ?? []).length === 0) {
      state.blocksByPage.get(pageId).push("starter");
    }
  })();

  navigationGeneration += 1;
  state.selectedPageId = "page-b";
  deleteResponse.resolve();
  await deleteEmptyBlock;

  return {
    selectedPageId: state.selectedPageId,
    pageBBlocks: state.blocksByPage.get("page-b"),
    newerNavigationPreserved: state.selectedPageId === "page-b",
    wrongPageStarterPrevented: !state.blocksByPage.get("page-b").includes("starter")
  };
}

console.log(JSON.stringify({
  vulnerable: await reproduceVulnerable(),
  fixed: await reproduceFixed()
}, null, 2));
