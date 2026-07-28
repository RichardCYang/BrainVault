import { readFileSync } from "node:fs";
import { createCollaborationRecoveryStore } from "../public/collaboration-recovery-store.js";
import { createPageDraftStore } from "../public/draft-store.js";
import { translationCatalogs } from "../public/i18n.js";
import { createPageTransitionLock } from "../public/page-transition-lock.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert(startIndex >= 0, `Missing source marker: ${start}`);
  assert(endIndex > startIndex, `Missing source marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertBefore(source, guard, mutation, label) {
  const guardIndex = source.indexOf(guard);
  const mutationIndex = source.indexOf(mutation);
  assert(guardIndex >= 0, `${label}: missing guard ${guard}`);
  assert(mutationIndex >= 0, `${label}: missing mutation ${mutation}`);
  assert(guardIndex < mutationIndex, `${label}: guard must run before the mutation`);
}

class MemoryStorage {
  values = new Map();
  shiftOnNextKey = false;

  get length() {
    return this.values.size;
  }

  key(index) {
    const key = [...this.values.keys()][index] ?? null;
    if (this.shiftOnNextKey && index === 0 && key) {
      this.shiftOnNextKey = false;
      this.values.delete(key);
    }
    return key;
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

class RepeatedShiftingStorage extends MemoryStorage {
  shiftsRemaining = 0;

  key(index) {
    const keys = [...this.values.keys()];
    const key = keys[index] ?? null;
    if (this.shiftsRemaining > 0 && keys.length > 1 && index === keys.length - 2) {
      this.values.delete(keys[0]);
      this.shiftsRemaining -= 1;
    }
    return key;
  }
}

function oldThreePassForwardSnapshot(storage) {
  const keys = new Set();
  for (let pass = 0; pass < 3; pass += 1) {
    const length = storage.length;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

for (const [locale, catalog] of Object.entries(translationCatalogs)) {
  const message = catalog?.status?.destructiveLocalDraftsPending;
  assert(
    typeof message === "string" && message.includes("{count}"),
    `Missing destructiveLocalDraftsPending translation for ${locale}`
  );
  assert(
    typeof catalog?.status?.localRecoveryInspectionFailed === "string",
    `Missing localRecoveryInspectionFailed translation for ${locale}`
  );
}

assert(
  client.includes("assertBrowserRecoveryInspectionSafe(inspection)"),
  "Destructive guards do not fail closed when browser recovery inspection is uncertain"
);
assert(
  client.includes("const transitionInspection = pageTransitionLock.inspectActive()"),
  "Workspace transitions do not inspect every durable lease safely"
);

const permanentDelete = section(client, "async function deleteNavigationTarget()", "function renderCollectionView");
assertBefore(
  permanentDelete,
  "assertNoPendingLocalPageDraftsForPages(serverPageIds",
  "await api(`/api/pages/${target.id}?permanent=true`",
  "permanent page deletion"
);
assertBefore(
  permanentDelete,
  "assertNoPendingLocalCollaborationRecoveryForPages(serverPageIds)",
  "await api(`/api/pages/${target.id}?permanent=true`",
  "permanent page deletion Yjs recovery"
);

const restore = section(client, "async function restoreUserDataBackup(file)", "function getUserInitials");
assertBefore(
  restore,
  "assertNoPendingLocalPageDraftsForPages(ownedPageIds",
  'await api("/api/data/import"',
  "workspace restore"
);
assertBefore(
  restore,
  "assertNoPendingLocalCollaborationRecoveryForPages(ownedPageIds)",
  'await api("/api/data/import"',
  "workspace restore Yjs recovery"
);

const archive = section(
  client,
  'elements.archivePageButton.addEventListener("click"',
  'for (const eventName of ["focusin"'
);
assertBefore(
  archive,
  "assertNoPendingLocalPageDrafts(pageId",
  "await api(`/api/pages/${pageId}`",
  "page archive"
);
assertBefore(
  archive,
  "assertNoPendingLocalCollaborationRecovery(pageId)",
  "await api(`/api/pages/${pageId}`",
  "page archive Yjs recovery"
);

const blockDelete = section(client, "async function deleteBlockWithVersionCheck", "function updateBlockInState");
assert(blockDelete.includes('withPagePersistenceTransition(pageId, "block-delete"'), "Block deletion lacks a page transition");
assertBefore(
  blockDelete,
  "assertNoPendingLocalBlockDrafts(",
  "await api(`/api/blocks/${blockId}`",
  "direct block deletion"
);
assert(
  blockDelete.includes("{ excludeSourceId: pageDraftSourceId }"),
  "Block deletion must exclude only the deleting tab's own source"
);

const draftStorage = new MemoryStorage();
const draftBase = { userId: "user", pageId: "page", expectedVersion: 1, revision: 1 };
createPageDraftStore(draftStorage, { sourceId: "tab-a" }).saveBlock({
  ...draftBase,
  blockId: "block-a",
  payload: { type: "MARKDOWN", markdown: "acknowledged elsewhere" }
});
createPageDraftStore(draftStorage, { sourceId: "tab-b" }).saveBlock({
  ...draftBase,
  blockId: "block-b",
  payload: { type: "MARKDOWN", markdown: "must remain visible" }
});
draftStorage.shiftOnNextKey = true;
const drafts = createPageDraftStore(draftStorage, { sourceId: "reader" }).loadUserDrafts("user");
assert(drafts.length === 1 && drafts[0].sourceId === "tab-b", "A surviving direct draft was skipped after a key shift");

const recoveryStorage = new MemoryStorage();
const recoveryStore = createCollaborationRecoveryStore(recoveryStorage);
recoveryStore.save("user", "page", "tab-a", "epoch", new Uint8Array([1]));
recoveryStore.save("user", "page", "tab-b", "epoch", new Uint8Array([2]));
recoveryStorage.shiftOnNextKey = true;
const recovery = recoveryStore.loadPageRecords("page");
assert(
  recovery.length === 1 && recovery[0].sourceId === "tab-b",
  "A surviving collaboration recovery record was skipped after a key shift"
);

const transitionStorage = new MemoryStorage();
const firstLock = createPageTransitionLock(transitionStorage, { sourceId: "tab-a" });
const secondLock = createPageTransitionLock(transitionStorage, { sourceId: "tab-b" });
firstLock.acquire("page", "share-add");
secondLock.acquire("__workspace__:user", "data-restore");
transitionStorage.shiftOnNextKey = true;
const activeTransitions = firstLock.loadActive();
assert(
  activeTransitions.length === 1 && activeTransitions[0].pageId === "__workspace__:user",
  "A surviving transition lease was skipped after a key shift"
);

const repeatedShiftProbe = new RepeatedShiftingStorage();
for (const key of ["draft-a", "draft-b", "draft-c", "draft-survivor"]) {
  repeatedShiftProbe.setItem(key, key);
}
repeatedShiftProbe.shiftsRemaining = 3;
const oldSnapshot = oldThreePassForwardSnapshot(repeatedShiftProbe);
assert(
  !oldSnapshot.includes("draft-survivor") && repeatedShiftProbe.getItem("draft-survivor"),
  "The adversarial storage probe no longer reproduces the bounded forward-scan omission"
);

const repeatedDraftStorage = new RepeatedShiftingStorage();
for (const sourceId of ["tab-a", "tab-b", "tab-c", "tab-survivor"]) {
  createPageDraftStore(repeatedDraftStorage, { sourceId }).saveBlock({
    ...draftBase,
    blockId: sourceId,
    payload: { type: "MARKDOWN", markdown: sourceId }
  });
}
repeatedDraftStorage.shiftsRemaining = 3;
const draftInspection = createPageDraftStore(repeatedDraftStorage, { sourceId: "reader" })
  .inspectUserDrafts("user");
assert(
  draftInspection.reliable
  && draftInspection.records.length === 1
  && draftInspection.records[0].sourceId === "tab-survivor",
  "Repeated key shifts can still hide a surviving direct draft"
);

const repeatedRecoveryStorage = new RepeatedShiftingStorage();
const repeatedRecoveryStore = createCollaborationRecoveryStore(repeatedRecoveryStorage);
for (const sourceId of ["tab-a", "tab-b", "tab-c", "tab-survivor"]) {
  repeatedRecoveryStore.save("user", "page", sourceId, "epoch", new Uint8Array([sourceId.length]));
}
repeatedRecoveryStorage.shiftsRemaining = 3;
const recoveryInspection = repeatedRecoveryStore.inspectPageRecords("page");
assert(
  recoveryInspection.reliable
  && recoveryInspection.records.length === 1
  && recoveryInspection.records[0].sourceId === "tab-survivor",
  "Repeated key shifts can still hide a surviving collaboration recovery"
);

const repeatedTransitionStorage = new RepeatedShiftingStorage();
const repeatedLock = createPageTransitionLock(repeatedTransitionStorage, { sourceId: "tab" });
for (const pageId of ["page-a", "page-b", "page-c", "page-survivor"]) {
  repeatedLock.acquire(pageId, "delete");
}
repeatedTransitionStorage.shiftsRemaining = 3;
const transitionInspection = repeatedLock.inspectActive();
assert(
  transitionInspection.reliable
  && transitionInspection.records.length === 1
  && transitionInspection.records[0].pageId === "page-survivor",
  "Repeated key shifts can still hide a surviving transition lease"
);

const corruptDraftStorage = new MemoryStorage();
corruptDraftStorage.setItem("brainvault.pageDraft.v2:user:page:tab-corrupt", "{not-json");
assert(
  createPageDraftStore(corruptDraftStorage, { sourceId: "reader" })
    .inspectPageDrafts("user", "page").unreadableKeys.length === 1,
  "An undecodable target draft is still treated as safely absent"
);

const brokenStorage = {
  get length() { throw new Error("disabled"); },
  key() { throw new Error("disabled"); },
  getItem() { throw new Error("disabled"); },
  setItem() { throw new Error("disabled"); },
  removeItem() { throw new Error("disabled"); }
};
assert(
  !createPageDraftStore(brokenStorage, { sourceId: "reader" }).inspectUserDrafts("user").reliable,
  "Storage enumeration failure is still treated as a reliable empty draft set"
);
assert(
  !createCollaborationRecoveryStore(brokenStorage).inspectPageRecords("page").reliable,
  "Storage enumeration failure is still treated as a reliable empty collaboration recovery set"
);
assert(
  !createPageTransitionLock(brokenStorage, { sourceId: "reader" }).inspectActive().reliable,
  "Storage enumeration failure is still treated as a reliable empty transition set"
);

console.log(
  "[verify-data-loss-guards] OK: destructive ordering, seven locale messages, convergent storage snapshots, and fail-closed recovery inspection."
);
