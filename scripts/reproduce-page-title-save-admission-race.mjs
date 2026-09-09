import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function vulnerableTitleSave(context, durability) {
  const pageId = context.selectedPage.id;
  const title = context.pendingTitle;
  await durability.promise;
  context.requests.push({ pageId, title });
  return "sent";
}

async function fixedTitleSave(context, durability, { allowLocked = false } = {}) {
  const pageId = context.selectedPage.id;
  const navigationGeneration = context.navigationGeneration;
  const title = context.pendingTitle;
  await durability.promise;
  if (
    context.navigationGeneration !== navigationGeneration
    || context.selectedPage?.id !== pageId
    || (!allowLocked && context.pageEditLockDepth > 0)
  ) {
    return "fenced";
  }
  context.requests.push({ pageId, title });
  return "sent";
}

console.log("Scenario A: navigation changes while a direct title save is awaiting durable recovery storage.");
const oldNavigation = {
  selectedPage: { id: "page-a" },
  navigationGeneration: 10,
  pageEditLockDepth: 0,
  pendingTitle: "Old unsaved title",
  requests: []
};
const oldNavigationDurability = deferred();
const vulnerableNavigationSave = vulnerableTitleSave(oldNavigation, oldNavigationDurability);
oldNavigation.navigationGeneration += 1;
oldNavigation.selectedPage = { id: "page-b" };
oldNavigationDurability.resolve();
assert.equal(await vulnerableNavigationSave, "sent");
assert.deepEqual(oldNavigation.requests, [{ pageId: "page-a", title: "Old unsaved title" }]);
console.log("  vulnerable behavior reproduced: a stale PATCH for page-a is admitted after the user has left page-a.");

const fixedNavigation = {
  selectedPage: { id: "page-a" },
  navigationGeneration: 10,
  pageEditLockDepth: 0,
  pendingTitle: "Old unsaved title",
  requests: []
};
const fixedNavigationDurability = deferred();
const fencedNavigationSave = fixedTitleSave(fixedNavigation, fixedNavigationDurability);
fixedNavigation.navigationGeneration += 1;
fixedNavigation.selectedPage = { id: "page-b" };
fixedNavigationDurability.resolve();
assert.equal(await fencedNavigationSave, "fenced");
assert.deepEqual(fixedNavigation.requests, []);
console.log("  fixed behavior: navigation invalidates the pending title admission and the durable draft is retained.");

console.log("Scenario B: a destructive same-page transition starts before title queue admission.");
const oldDelete = {
  selectedPage: { id: "page-a" },
  navigationGeneration: 20,
  pageEditLockDepth: 0,
  pendingTitle: "Title racing deletion",
  requests: []
};
const oldDeleteDurability = deferred();
const vulnerableDeleteSave = vulnerableTitleSave(oldDelete, oldDeleteDurability);
oldDelete.pageEditLockDepth = 1;
oldDeleteDurability.resolve();
assert.equal(await vulnerableDeleteSave, "sent");
assert.equal(oldDelete.requests.length, 1);
console.log("  vulnerable behavior reproduced: the title write enters after the destructive lock has started.");

const fixedDelete = {
  selectedPage: { id: "page-a" },
  navigationGeneration: 20,
  pageEditLockDepth: 0,
  pendingTitle: "Title racing deletion",
  requests: []
};
const fixedDeleteDurability = deferred();
const fencedDeleteSave = fixedTitleSave(fixedDelete, fixedDeleteDurability);
fixedDelete.pageEditLockDepth = 1;
fixedDeleteDurability.resolve();
assert.equal(await fencedDeleteSave, "fenced");
assert.deepEqual(fixedDelete.requests, []);
console.log("  fixed behavior: an ordinary title write cannot enter after the destructive transition fence.");

console.log("Scenario C: a restore replaces page-a with the same stable id while the old title waits.");
const oldRestore = {
  selectedPage: { id: "page-a", version: 1 },
  navigationGeneration: 30,
  pageEditLockDepth: 0,
  pendingTitle: "Pre-restore title",
  requests: []
};
const oldRestoreDurability = deferred();
const vulnerableRestoreSave = vulnerableTitleSave(oldRestore, oldRestoreDurability);
oldRestore.navigationGeneration += 1;
oldRestore.selectedPage = { id: "page-a", version: 1, title: "Restored title" };
oldRestoreDurability.resolve();
assert.equal(await vulnerableRestoreSave, "sent");
assert.deepEqual(oldRestore.requests, [{ pageId: "page-a", title: "Pre-restore title" }]);
console.log("  vulnerable behavior reproduced: stable id/version reuse can make the old title target the restored page generation.");

const fixedRestore = {
  selectedPage: { id: "page-a", version: 1 },
  navigationGeneration: 30,
  pageEditLockDepth: 0,
  pendingTitle: "Pre-restore title",
  requests: []
};
const fixedRestoreDurability = deferred();
const fencedRestoreSave = fixedTitleSave(fixedRestore, fixedRestoreDurability);
fixedRestore.navigationGeneration += 1;
fixedRestore.selectedPage = { id: "page-a", version: 1, title: "Restored title" };
fixedRestoreDurability.resolve();
assert.equal(await fencedRestoreSave, "fenced");
assert.deepEqual(fixedRestore.requests, []);
console.log("  fixed behavior: the navigation generation fences stable-id replacement before any PATCH is admitted.");

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const saveStart = appSource.indexOf("async function savePageTitleNow(");
const saveEnd = appSource.indexOf("\nfunction schedulePageTitleSave", saveStart);
const saveSource = appSource.slice(saveStart, saveEnd);
assert.match(saveSource, /const navigationGeneration = workspaceNavigationGeneration;/);
assert.match(saveSource, /!isCurrentWorkspaceNavigation\(navigationGeneration\)/);
assert.match(saveSource, /state\.selectedPage\?\.id !== pageId/);
assert.match(saveSource, /\(!allowLocked && state\.pageEditLockDepth > 0\)/);
console.log("Verified public/app.js contains the title page/navigation/transition admission fence.");
