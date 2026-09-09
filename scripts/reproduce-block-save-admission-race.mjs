import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function vulnerableDirectSave(context, durability) {
  const blockId = "old-block";
  await durability.promise;
  context.requests.push({
    blockId,
    pageId: context.selectedPage.id
  });
  return "sent";
}

async function fixedDirectSave(context, durability, { allowLocked = false } = {}) {
  const blockId = "old-block";
  const pageId = context.selectedPage?.id;
  const navigationGeneration = context.navigationGeneration;
  await durability.promise;
  if (
    context.navigationGeneration !== navigationGeneration
    || context.selectedPage?.id !== pageId
    || (!allowLocked && context.pageEditLockDepth > 0)
  ) {
    return "fenced";
  }
  context.requests.push({ blockId, pageId });
  return "sent";
}

console.log("Scenario A: navigation changes while a direct save is awaiting durable recovery storage.");
const oldNavigation = {
  selectedPage: { id: "page-a" },
  navigationGeneration: 10,
  pageEditLockDepth: 0,
  requests: []
};
const oldNavigationDurability = deferred();
const vulnerableNavigationSave = vulnerableDirectSave(oldNavigation, oldNavigationDurability);
oldNavigation.navigationGeneration += 1;
oldNavigation.pageEditLockDepth = 1;
oldNavigation.selectedPage = { id: "page-b" };
oldNavigationDurability.resolve();
assert.equal(await vulnerableNavigationSave, "sent");
assert.deepEqual(oldNavigation.requests, [{ blockId: "old-block", pageId: "page-b" }]);
console.log("  vulnerable behavior reproduced: old-block was admitted after navigation and mis-bound to page-b.");

const fixedNavigation = {
  selectedPage: { id: "page-a" },
  navigationGeneration: 10,
  pageEditLockDepth: 0,
  requests: []
};
const fixedNavigationDurability = deferred();
const fencedNavigationSave = fixedDirectSave(fixedNavigation, fixedNavigationDurability);
fixedNavigation.navigationGeneration += 1;
fixedNavigation.pageEditLockDepth = 1;
fixedNavigation.selectedPage = { id: "page-b" };
fixedNavigationDurability.resolve();
assert.equal(await fencedNavigationSave, "fenced");
assert.deepEqual(fixedNavigation.requests, []);
console.log("  fixed behavior: the stale save is fenced and the already-durable draft remains for recovery.");

console.log("Scenario B: a destructive transition lock starts on the same page before queue admission.");
const oldDelete = {
  selectedPage: { id: "page-a" },
  navigationGeneration: 20,
  pageEditLockDepth: 0,
  requests: []
};
const oldDeleteDurability = deferred();
const vulnerableDeleteSave = vulnerableDirectSave(oldDelete, oldDeleteDurability);
oldDelete.pageEditLockDepth = 1;
oldDeleteDurability.resolve();
assert.equal(await vulnerableDeleteSave, "sent");
assert.equal(oldDelete.requests.length, 1);
console.log("  vulnerable behavior reproduced: a server write was admitted after the destructive lock started.");

const fixedDelete = {
  selectedPage: { id: "page-a" },
  navigationGeneration: 20,
  pageEditLockDepth: 0,
  requests: []
};
const fixedDeleteDurability = deferred();
const fencedDeleteSave = fixedDirectSave(fixedDelete, fixedDeleteDurability);
fixedDelete.pageEditLockDepth = 1;
fixedDeleteDurability.resolve();
assert.equal(await fencedDeleteSave, "fenced");
assert.deepEqual(fixedDelete.requests, []);
console.log("  fixed behavior: an ordinary save cannot enter the queue after the transition lock starts.");

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const saveStart = appSource.indexOf("async function saveBlockRow(");
const saveEnd = appSource.indexOf("\nfunction scheduleBlockSave", saveStart);
const saveSource = appSource.slice(saveStart, saveEnd);
assert.match(saveSource, /const pageId = state\.selectedPage\?\.id;/);
assert.match(saveSource, /const navigationGeneration = workspaceNavigationGeneration;/);
assert.match(saveSource, /!isCurrentWorkspaceNavigation\(navigationGeneration\)/);
assert.match(saveSource, /state\.selectedPage\?\.id !== pageId/);
assert.match(saveSource, /\(!allowLocked && state\.pageEditLockDepth > 0\)/);
assert.match(saveSource, /\r?\n    pageId,\r?\n/);
console.log("Verified public/app.js contains the page/navigation/transition admission fence.");
