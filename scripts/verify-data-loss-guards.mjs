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

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

for (const [locale, catalog] of Object.entries(translationCatalogs)) {
  const message = catalog?.status?.destructiveLocalDraftsPending;
  assert(
    typeof message === "string" && message.includes("{count}"),
    `Missing destructiveLocalDraftsPending translation for ${locale}`
  );
}

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

console.log(
  "[verify-data-loss-guards] OK: destructive transition ordering, seven locale messages, and cross-tab storage enumeration."
);
