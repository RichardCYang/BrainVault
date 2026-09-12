function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function run({ fixed }) {
  let navigationGeneration = 1;
  let listGeneration = 0;
  const state = { activeTag: "work", applied: null };
  const homeFetch = deferred();
  const staleDeleteFetch = deferred();

  const isCurrentNavigation = (generation) => generation === navigationGeneration;
  const loadPages = async (query, tag, { navigationGeneration: boundNavigation = null, fetch } = {}) => {
    if (boundNavigation !== null && !isCurrentNavigation(boundNavigation)) return false;
    const loadGeneration = ++listGeneration;
    const pages = await fetch.promise;
    if (
      loadGeneration !== listGeneration
      || (boundNavigation !== null && !isCurrentNavigation(boundNavigation))
    ) return false;
    state.activeTag = tag;
    state.applied = { query, tag, pages };
    return true;
  };

  const deleteNavigation = navigationGeneration;
  navigationGeneration += 1;
  const homeNavigation = navigationGeneration;

  const homeLoad = loadPages("", "", {
    navigationGeneration: homeNavigation,
    fetch: homeFetch
  });
  const staleDeleteLoad = loadPages("", state.activeTag, {
    ...(fixed ? { navigationGeneration: deleteNavigation } : {}),
    fetch: staleDeleteFetch
  });

  staleDeleteFetch.resolve(["stale-filtered-page"]);
  await staleDeleteLoad;
  homeFetch.resolve(["home-page"]);
  await homeLoad;
  return state.applied;
}

const vulnerable = await run({ fixed: false });
const fixed = await run({ fixed: true });
process.stdout.write(JSON.stringify({ vulnerable, fixed }, null, 2) + "\n");
