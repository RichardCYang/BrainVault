import { readFileSync } from "node:fs";
import { createCollaborationRecoveryStore } from "../public/collaboration-recovery-store.js";
import { createPageDraftStore } from "../public/draft-store.js";
import { translationCatalogs } from "../public/i18n.js";
import { createPageTransitionLock } from "../public/page-transition-lock.js";
import { inspectStorageKeys } from "../public/storage-snapshot.js";

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

class AlternatingDelimiterCollisionStorage {
  pass = -1;
  lengthReadInPass = 0;
  currentKeys = [];

  get length() {
    if (this.lengthReadInPass === 0) {
      this.pass += 1;
      this.currentKeys = this.pass % 2 === 0
        ? ["draft\u0000survivor"]
        : ["draft", "survivor"];
    }
    const length = this.currentKeys.length;
    this.lengthReadInPass = (this.lengthReadInPass + 1) % 3;
    return length;
  }

  key(index) {
    return this.currentKeys[index] ?? null;
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

const recoveredDraftActivation = section(
  client,
  "function activatePersistedPageDraft(recovery)",
  "async function createCollection()"
);
assert(
  recoveredDraftActivation.includes("pageTitleDraftSourceId = pageDraftSourceId;"),
  "Recovered titles are still edited through the origin tab's storage source"
);
assert(
  recoveredDraftActivation.includes("row.dataset.draftSourceId = pageDraftSourceId;"),
  "Recovered blocks are still edited through the origin tab's storage source"
);
assert(
  recoveredDraftActivation.includes("persistPageTitleDraft();")
    && recoveredDraftActivation.includes("persistBlockDraft(row);"),
  "Recovered title/block content is not cloned into the current tab before editing"
);
assert(
  recoveredDraftActivation.includes("sourceId: pageDraftSourceId,")
    && recoveredDraftActivation.includes("recoveredOrigin: { sourceId, mutationId: draft.mutationId }"),
  "Recovered block-order retries are not isolated from the origin tab"
);
assert(
  !recoveredDraftActivation.includes("recovery.title.conflict ? recovery.title.sourceId")
    && !recoveredDraftActivation.includes("recovered.conflict ? recovered.sourceId"),
  "Conflict recovery can still alias another tab's durable draft key"
);

const blockOrderAcknowledgement = section(
  client,
  "function acknowledgeBlockOrderDraft(task)",
  "async function submitBlockOrderTask"
);
assert(
  blockOrderAcknowledgement.includes("sourceId: task.recoveredOrigin.sourceId")
    && blockOrderAcknowledgement.includes("mutationId: task.recoveredOrigin.mutationId"),
  "Recovered block-order origin is not cleaned up with an exact mutation guard"
);

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
  assert(
    typeof catalog?.status?.exclusiveTransitionLockUnavailable === "string",
    `Missing exclusiveTransitionLockUnavailable translation for ${locale}`
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
assert(
  client.includes("const exclusiveTransitionId = workspaceTransitionId ?? pageId;")
    && client.includes("pageTransitionLock.runExclusive(exclusiveTransitionId"),
  "Page and workspace transitions do not share one owner-scoped browser lock"
);
assert(
  client.includes("status.exclusiveTransitionLockUnavailable"),
  "Unsupported browser locking does not surface a fail-closed explanation"
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

const recoveryIsolationStorage = new MemoryStorage();
const recoveryOriginStore = createPageDraftStore(recoveryIsolationStorage, { sourceId: "tab-origin" });
const recoveryCurrentStore = createPageDraftStore(recoveryIsolationStorage, { sourceId: "tab-current" });
recoveryOriginStore.saveTitle({
  userId: "user",
  pageId: "page",
  value: "origin title",
  expectedVersion: 1,
  revision: 1
});
recoveryOriginStore.saveBlock({
  userId: "user",
  pageId: "page",
  blockId: "block",
  payload: { type: "MARKDOWN", markdown: "origin block" },
  expectedVersion: 1,
  revision: 1
});
recoveryOriginStore.saveBlockOrder({
  userId: "user",
  pageId: "page",
  parentBlockId: null,
  orderedIds: ["block"],
  previousIds: ["block"],
  mutationId: "origin-order",
  items: [{ id: "block", sortOrder: 0, parentBlockId: null, expectedVersion: 1 }]
});
recoveryCurrentStore.saveTitle({
  userId: "user",
  pageId: "page",
  value: "edited in current tab",
  expectedVersion: 1,
  revision: 2
});
recoveryCurrentStore.saveBlock({
  userId: "user",
  pageId: "page",
  blockId: "block",
  payload: { type: "MARKDOWN", markdown: "edited in current tab" },
  expectedVersion: 1,
  revision: 2
});
recoveryCurrentStore.saveBlockOrder({
  userId: "user",
  pageId: "page",
  parentBlockId: null,
  orderedIds: ["block"],
  previousIds: ["block"],
  mutationId: "origin-order",
  items: [{ id: "block", sortOrder: 0, parentBlockId: null, expectedVersion: 1 }]
});
const untouchedOrigin = recoveryOriginStore.loadPage("user", "page", "tab-origin");
assert(untouchedOrigin?.title?.value === "origin title", "Current-tab title edits overwrite the recovery origin");
assert(
  untouchedOrigin?.blocks?.block?.payload?.markdown === "origin block",
  "Current-tab block edits overwrite the recovery origin"
);
assert(
  untouchedOrigin?.blockOrder?.mutationId === "origin-order",
  "Current-tab order retries overwrite the recovery origin"
);

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

let unsupportedLockActionExecuted = false;
const unsupportedLockResult = await createPageTransitionLock(
  new MemoryStorage(),
  { sourceId: "unsupported-browser" }
).runExclusive("__workspace__:user", async () => {
  unsupportedLockActionExecuted = true;
  return "unsafe";
});
assert(
  !unsupportedLockResult.acquired
    && unsupportedLockResult.reason === "lock-manager-unavailable"
    && !unsupportedLockActionExecuted,
  "A destructive transition still runs without an atomic browser lock manager"
);

const delimiterCollisionInspection = inspectStorageKeys(
  new AlternatingDelimiterCollisionStorage(),
  { maxPasses: 6, stablePasses: 3 }
);
assert(
  !delimiterCollisionInspection.reliable
    && delimiterCollisionInspection.keys.includes("draft\u0000survivor")
    && delimiterCollisionInspection.keys.includes("draft")
    && delimiterCollisionInspection.keys.includes("survivor"),
  "Delimiter-colliding storage key sets can still be mistaken for one stable snapshot"
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

const partialDraftStorage = new MemoryStorage();
const partialDraftKey = "brainvault.pageDraft.v2:user:page:tab-corrupt";
const partialDraftRaw = JSON.stringify({
  schemaVersion: 2,
  userId: "user",
  pageId: "page",
  sourceId: "tab-corrupt",
  updatedAt: 1,
  title: { value: "recoverable", expectedVersion: 1, revision: 1, updatedAt: 1 },
  blocks: { broken: { payload: "not-an-object", expectedVersion: 1, revision: 1, updatedAt: 1 } },
  blockOrder: null
});
partialDraftStorage.setItem(partialDraftKey, partialDraftRaw);
const partialDraftStore = createPageDraftStore(partialDraftStorage, { sourceId: "tab-corrupt" });
assert(
  partialDraftStore.inspectPageDrafts("user", "page").unreadableKeys.includes(partialDraftKey),
  "A partially malformed draft is still accepted after silently dropping one component"
);
assert(
  !partialDraftStore.saveTitle({
    userId: "user",
    pageId: "page",
    sourceId: "tab-corrupt",
    value: "replacement",
    expectedVersion: 1,
    revision: 2
  }) && partialDraftStorage.getItem(partialDraftKey) === partialDraftRaw,
  "A partially malformed draft can still be overwritten by the next title save"
);

const emptyDraftStorage = new MemoryStorage();
const emptyDraftKey = "brainvault.pageDraft.v2:user:page:tab-empty";
emptyDraftStorage.setItem(emptyDraftKey, "");
const emptyDraftStore = createPageDraftStore(emptyDraftStorage, { sourceId: "tab-empty" });
assert(
  emptyDraftStore.inspectPageDrafts("user", "page").unreadableKeys.includes(emptyDraftKey)
  && !emptyDraftStore.saveBlock({
    userId: "user",
    pageId: "page",
    sourceId: "tab-empty",
    blockId: "block",
    payload: { type: "MARKDOWN", markdown: "replacement" },
    expectedVersion: 1,
    revision: 1
  })
  && emptyDraftStorage.getItem(emptyDraftKey) === "",
  "An empty-string draft value is still treated as an absent, overwritable key"
);

const emptyRecoveryStorage = new MemoryStorage();
const emptyRecoveryKey = "brainvault.collaborationRecovery.v1:user:page:epoch:tab";
emptyRecoveryStorage.setItem(emptyRecoveryKey, "");
const emptyRecoveryStore = createCollaborationRecoveryStore(emptyRecoveryStorage);
assert(
  emptyRecoveryStore.inspectPageRecords("page").unreadableKeys.includes(emptyRecoveryKey)
  && emptyRecoveryStore.save("user", "page", "tab", "epoch", new Uint8Array([1])) === null
  && emptyRecoveryStorage.getItem(emptyRecoveryKey) === "",
  "An empty-string collaboration recovery can still be overwritten"
);

const emptyTransitionStorage = new MemoryStorage();
const emptyTransitionKey = "brainvault.pageTransition.v1:page";
emptyTransitionStorage.setItem(emptyTransitionKey, "");
const emptyTransitionLock = createPageTransitionLock(emptyTransitionStorage, { sourceId: "tab" });
assert(
  emptyTransitionLock.inspect("page").status === "invalid"
  && emptyTransitionLock.acquire("page", "delete") === null
  && emptyTransitionStorage.getItem(emptyTransitionKey) === "",
  "An empty-string transition lease is still treated as safely missing"
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
  "[verify-data-loss-guards] OK: destructive ordering, owner-scoped atomic browser exclusion, cross-tab recovery isolation, lossless malformed-record handling, seven locale messages, boundary-safe convergent storage snapshots, and fail-closed recovery inspection."
);
