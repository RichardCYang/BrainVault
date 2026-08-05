function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function reproduceVulnerable() {
  const state = { selectedPageId: "page-a", entries: [] };
  const pageA = deferred();
  const pageB = deferred();

  const load = async (request) => {
    state.entries = await request.promise;
  };

  const oldLoad = load(pageA);
  state.selectedPageId = "page-b";
  const newLoad = load(pageB);

  pageB.resolve([{ userId: "user-b", username: "bob" }]);
  await newLoad;
  pageA.resolve([{ userId: "user-a", username: "alice" }]);
  await oldLoad;

  return {
    selectedPageId: state.selectedPageId,
    renderedUserId: state.entries[0]?.userId ?? null,
    stalePageAListRenderedForPageB: state.selectedPageId === "page-b" && state.entries[0]?.userId === "user-a",
    staleRemoveWouldTargetCurrentPage: `/api/pages/${state.selectedPageId}/shares/${state.entries[0]?.userId}`
      === "/api/pages/page-b/shares/user-a"
  };
}

async function reproduceFixed() {
  const state = { selectedPageId: "page-a", dialogOpen: true, entries: [] };
  let generation = 0;
  const pageA = deferred();
  const pageB = deferred();

  const isCurrent = (requestGeneration, pageId) => (
    requestGeneration === generation
      && state.dialogOpen
      && state.selectedPageId === pageId
  );
  const load = async (pageId, request, requestGeneration) => {
    const entries = await request.promise;
    if (isCurrent(requestGeneration, pageId)) state.entries = entries;
  };

  const pageAGeneration = ++generation;
  const oldLoad = load("page-a", pageA, pageAGeneration);
  state.dialogOpen = false;
  generation += 1;
  state.selectedPageId = "page-b";
  state.dialogOpen = true;
  const pageBGeneration = ++generation;
  const newLoad = load("page-b", pageB, pageBGeneration);

  pageB.resolve([{ userId: "user-b", username: "bob" }]);
  await newLoad;
  pageA.resolve([{ userId: "user-a", username: "alice" }]);
  await oldLoad;

  return {
    selectedPageId: state.selectedPageId,
    renderedUserId: state.entries[0]?.userId ?? null,
    latestPageListPreserved: state.selectedPageId === "page-b" && state.entries[0]?.userId === "user-b",
    staleRemoveTargetSuppressed: state.entries[0]?.userId !== "user-a"
  };
}

console.log(JSON.stringify({
  vulnerable: await reproduceVulnerable(),
  fixed: await reproduceFixed()
}, null, 2));
