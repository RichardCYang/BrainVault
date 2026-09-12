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
  const state = { activeTag: "work", selectedPageId: "page-a", applied: null };
  const navigationFetch = deferred();
  const staleSaveFetch = deferred();

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

  const saveNavigation = navigationGeneration;

  // The explicit save is waiting for its edit-lock flush. Before that wait
  // settles, the user navigates away and starts the page-list request that
  // should own the visible workspace state.
  navigationGeneration += 1;
  state.selectedPageId = null;
  const newerNavigation = navigationGeneration;
  const navigationLoad = loadPages("", "", {
    navigationGeneration: newerNavigation,
    fetch: navigationFetch
  });

  // The old save continuation settles later. The vulnerable path enters
  // loadPages without a navigation binding, becoming the newest list
  // generation and causing the newer navigation's result to be discarded.
  const staleSaveMayContinue = !fixed || isCurrentNavigation(saveNavigation);
  const staleSaveLoad = staleSaveMayContinue
    ? loadPages("", state.activeTag, {
        ...(fixed ? { navigationGeneration: saveNavigation } : {}),
        fetch: staleSaveFetch
      })
    : Promise.resolve(false);

  staleSaveFetch.resolve(["stale-filtered-page"]);
  await staleSaveLoad;
  navigationFetch.resolve(["home-page"]);
  await navigationLoad;

  return state.applied;
}

test("reproduction: stale explicit-save refresh can supersede a newer navigation", async () => {
  assert.deepEqual(
    await reproduce({ fixed: false }),
    { query: "", tag: "work", pages: ["stale-filtered-page"] }
  );
  assert.deepEqual(
    await reproduce({ fixed: true }),
    { query: "", tag: "", pages: ["home-page"] }
  );
});

test("explicit save fences its post-flush list refresh to auth, page, and navigation", () => {
  const source = section(
    app,
    'elements.savePageButton.addEventListener("click"',
    "async function archivePageIdempotently"
  );

  assert.match(source, /const pageId = state\.selectedPage\.id;/);
  assert.match(source, /const authenticationScope = captureAuthenticatedSessionScope\(\);/);
  assert.match(source, /const navigationGeneration = workspaceNavigationGeneration;/);
  assert.match(
    source,
    /isCurrentAuthenticatedSessionScope\(authenticationScope\)[\s\S]*?isCurrentWorkspaceNavigation\(navigationGeneration\)[\s\S]*?state\.selectedPage\?\.id === pageId/
  );

  const editLockIndex = source.indexOf("await withPageEditLock(async () =>");
  const postFlushGuardIndex = source.indexOf("if (!isSaveIntentCurrent()) return;", editLockIndex);
  const listRefreshIndex = source.indexOf("const refreshed = await loadPages(", postFlushGuardIndex);
  assert.ok(editLockIndex >= 0 && postFlushGuardIndex > editLockIndex);
  assert.ok(listRefreshIndex > postFlushGuardIndex, "stale save must be rejected before entering loadPages");
  assert.match(
    source.slice(listRefreshIndex),
    /\{ navigationGeneration \}[\s\S]*?if \(!refreshed \|\| !isSaveIntentCurrent\(\)\) return;/
  );
});

test("explicit save does not publish stale success or error status after navigation", () => {
  const source = section(
    app,
    'elements.savePageButton.addEventListener("click"',
    "async function archivePageIdempotently"
  );
  assert.match(source, /if \(!refreshed \|\| !isSaveIntentCurrent\(\)\) return;[\s\S]*?setStatus\(t\("status\.pageSaved"\)\);/);
  assert.match(source, /catch \(error\) \{[\s\S]*?if \(isSaveIntentCurrent\(\)\) setStatus\(error\.message, true\);/);
});
