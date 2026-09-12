import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert.ok(start >= 0 && end > start, `missing source section: ${startNeedle}`);
  return source.slice(start, end);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function reproduce({ fixed }) {
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

  // A newer Home navigation begins first. Its requested filter is intentionally
  // different from the still-applied old collection/tag state.
  navigationGeneration += 1;
  const homeNavigation = navigationGeneration;
  const homeLoad = loadPages("", "", {
    navigationGeneration: homeNavigation,
    fetch: homeFetch
  });

  // The old delete response settles later and starts its post-delete refresh.
  // Without a navigation binding it becomes the newest list generation and can
  // supersede the Home request with the old tag snapshot.
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

test("reproduction: stale post-delete list refresh can supersede a newer navigation", async () => {
  assert.deepEqual(
    await reproduce({ fixed: false }),
    { query: "", tag: "work", pages: ["stale-filtered-page"] }
  );
  assert.deepEqual(
    await reproduce({ fixed: true }),
    { query: "", tag: "", pages: ["home-page"] }
  );
});

test("loadPages rejects an already-stale navigation before incrementing the list generation", () => {
  const source = section(app, "async function loadPages(", "function isCurrentWorkspaceNavigation");
  const staleGuard = source.indexOf("!isCurrentWorkspaceNavigation(navigationGeneration)");
  const increment = source.indexOf("++workspacePageListLoadGeneration");
  assert.ok(staleGuard >= 0 && increment > staleGuard, "stale navigation guard must run before list generation increment");
});

test("page deletion binds every list refresh to the initiating navigation generation", () => {
  const source = section(app, "async function deleteNavigationTarget()", "function renderCollectionView");
  const refreshes = [...source.matchAll(/await loadPages\([^;]+\);/g)].map((match) => match[0]);
  assert.equal(refreshes.length, 3, "delete flow should have three page-list refresh sites");
  for (const refresh of refreshes) {
    assert.match(refresh, /\{ navigationGeneration \}/);
  }
  assert.match(
    source,
    /PAGE_DELETE_SCOPE_CHANGED[\s\S]*?isCurrentWorkspaceNavigation\(navigationGeneration\)/
  );
});

test("archive reconciliation cannot apply a list snapshot after navigation supersedes it", () => {
  const source = section(
    app,
    'elements.archivePageButton.addEventListener("click"',
    'for (const eventName of ["focusin", "input", "keyup", "mouseup", "change"])'
  );
  assert.match(
    source,
    /await loadPages\(elements\.searchInput\.value\.trim\(\), state\.activeTag, \{ navigationGeneration \}\);/
  );
  assert.match(
    source,
    /!isCurrentAuthenticatedSessionScope\(authenticationScope\)[\s\S]*?!isCurrentWorkspaceNavigation\(navigationGeneration\)/
  );
});
