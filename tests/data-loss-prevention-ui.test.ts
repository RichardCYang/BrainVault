import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const transfer = readFileSync(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const database = readFileSync(new URL("../src/lib/db.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const errorMiddleware = readFileSync(new URL("../src/middleware/error.ts", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n"
);
const blockRoutes = readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n"
);
const blockOrderMigration = readFileSync(
  new URL("../migrations/018_block_order_mutation_receipts.sql", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const mutationMigration = readFileSync(
  new URL("../migrations/019_mutation_request_hashes.sql", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const mutationIds = readFileSync(new URL("../public/mutation-id.js", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n"
);

describe("Data-loss prevention integration", () => {
  it("serializes autosaves, flushes navigation, and protects dirty unloads", () => {
    expect(client).toContain('import { createPageDraftStore } from "./draft-store.js"');
    expect(client).toContain("const pageDraftSourceId = createPageDraftSourceId()");
    expect(client).toContain("createPageDraftStore(window.localStorage, { sourceId: pageDraftSourceId })");
    expect(client).not.toContain("sessionStorage.setItem(pageDraftSourceSessionKey");
    expect(client).toContain('import { createLatestWriteQueue } from "./save-queue.js"');
    expect(client).toContain('import { createMutationId, submitWithFreshMutationIdOnReuse } from "./mutation-id.js"');
    expect(mutationIds).toContain('if (typeof cryptoApi?.getRandomValues === "function")');
    expect(mutationIds).toContain("fallbackSequence = (fallbackSequence + 1)");
    expect(mutationIds).toContain("export async function submitWithFreshMutationIdOnReuse");
    expect(mutationIds).toContain('if (error?.code !== "MUTATION_ID_REUSED") throw error;');
    expect(client).toContain(
      'import { rebaseCommittedBlockContent, rebaseCommittedPageTitle } from "./save-rebase.js"'
    );
    expect(client).toContain("await flushPendingPageEdits();");
    expect(client).toContain('window.addEventListener("beforeunload", handleBeforeUnload)');
    expect(client).toContain('document.addEventListener("visibilitychange"');
    expect(client).toContain('saveBlockRow(row, { quiet: true }).catch');
    expect(client).toContain('keepalive: task.keepalive === true');
    expect(client).toContain('expectedVersion: currentVersion, mutationId: task.mutationId');
    expect(client).toContain('mutationId: createMutationId()');
    expect(client).toContain('const blockSaveRows = new Map()');
    expect(client).toContain('const rowsToSave = new Map(blockSaveRows)');
    expect(client).toContain('syncVisibleBlocksToState();\n  renderSelectedPage();');
    expect(client).toContain('async function withPageEditLock(action, { flush = true } = {})');
    expect(client).toContain('if (flush) await flushPendingPageEdits({ allowLocked: true });');
    expect(client).toContain('const shouldFlush = !skipFlush || state.pageEditLockDepth === 0;');
    expect(client).toContain('if (normalizedMode === pageModes.READ) await flushPendingPageEdits({ allowLocked: true });');
    expect(client).toContain('async function openPage(pageId, { skipFlush = false } = {})');
    expect(client).toContain('return withPageEditLock(\n    async () => {');
    expect(client).toContain("async function downloadUserDataBackup()");
    expect(client).toContain('withWorkspacePersistenceTransition("data-export"');
    expect(client).toContain("async function restoreUserDataBackup(file)");
    expect(client).toContain('withWorkspacePersistenceTransition("data-restore"');
    expect(client).toContain('applyPageContentVersion(task.pageId, data.pageContentVersion)');
    expect(client).toContain('Math.max(Number(page.contentVersion ?? 1), version)');
    expect(client).toContain('const keepaliveSaveBudgetBytes = 60 * 1024;');
    expect(client).toContain('const pendingSavePayloadBytes = keepalive ? getPendingSavePayloadBytes');
    expect(client).toContain('const useKeepalive = keepalive && pendingSavePayloadBytes <= keepaliveSaveBudgetBytes;');
    expect(client).toContain('keepalive: useKeepalive');
    expect(client).toContain("function persistPageTitleDraft()");
    expect(client).toContain("function persistBlockDraft(row, payload = null)");
    expect(client).toContain("pageDraftStore.acknowledgeTitle");
    expect(client).toContain("pageDraftStore.acknowledgeBlock");
    expect(client).toContain("function applyPersistedPageDraft(page)");
    expect(client).toContain("pageDraftStore.loadPageDrafts(scope.userId, scope.pageId)");
    expect(client).toContain('if (!writable || pageTitleDraftConflict) return null;');
    expect(client).toContain('if (row.dataset.draftConflict === "true" && (!resolveConflict || !promoteBlockDraftConflict(row)))');
    expect(client).toContain("pageTitleDraftSourceId = pageDraftSourceId;");
    expect(client).toContain("pageTitleConflictOrigin = {");
    expect(client).toContain("row.dataset.draftSourceId = pageDraftSourceId;");
    expect(client).toContain('row.dataset.draftConflict = "true";');
    expect(client).toContain("resolved: !recovered.conflict");
    expect(client).toContain("persistBlockDraft(row);");
    expect(client).not.toContain("recovery.title.conflict ? recovery.title.sourceId : pageDraftSourceId");
    expect(client).not.toContain("recovered.conflict ? recovered.sourceId : pageDraftSourceId");
    expect(client).toContain('if (row.dataset.draftConflict === "true") {');
    expect(client).toContain("pageDraftStore.removeTitleIfUnchanged");
    expect(client).toContain("pageDraftStore.removeBlockIfUnchanged");
    expect(client).toContain("recoveredConflictOrigin: pageTitleConflictOrigin");
    expect(client).toContain("recoveredConflictOrigin: blockDraftConflictOrigins.get(blockId) ?? null");
    expect(client).toContain("expectedVersion: getPositiveVersion(row.dataset.draftExpectedVersion)");
    expect(client).toContain("} else if (!activatePersistedPageDraft(recovery)) {");
  });

  it("blocks collaboration transitions while another tab still owns durable recovery data", () => {
    expect(client).toContain('import { createPageTransitionLock } from "./page-transition-lock.js"');
    expect(client).toContain("function withPagePersistenceTransition(pageId, kind, action)");
    expect(client).toContain("const exclusiveTransitionId = workspaceTransitionId ?? pageId;");
    expect(client).toContain("pageTransitionLock.runExclusive(exclusiveTransitionIds");
    expect(client).toContain("status.exclusiveTransitionLockUnavailable");
    expect(client).toContain("lockManager: window.navigator.locks");
    expect(client).toContain("if (!pageTransitionLock.owns(currentLease))");
    expect(client).toContain("isPagePersistenceTransitionLocked()");
    expect(client).toContain('event.key?.startsWith(`${pageTransitionStoragePrefix}:`)');
    expect(client).toContain("flushPendingPageEdits({ allowLocked: true, collaborationCompact: false })");
    expect(client).toContain(
      'function assertNoPendingLocalPageDrafts(pageId, messageKey = "sharing.localDraftsPending")'
    );
    expect(client).toContain("pageDraftStore.inspectPageDrafts(state.user.id, pageId)");
    expect(client).toContain("function assertNoPendingLocalCollaborationRecovery(pageId)");
    expect(client).toContain("collaborationRecoveryStore.inspectPageRecords(pageId)");
    expect(client).toContain('isCollaborativePage(page) ? "collaboration-active-or-stale" : "collaboration-disabled"');
    expect(client).toContain('const epochGroupKey = documentEpoch === null ? "legacy:" : `epoch:${documentEpoch}`;');
    expect(client).toContain('const groupKey = `${record.pageId}\\u0000${epochGroupKey}`;');
    expect(client).toContain("documentEpoch: group.documentEpoch");
    const orphanedCollaborationStart = client.indexOf("function getOrphanedCollaborationRecoveryGroups()");
    const orphanedCollaborationEnd = client.indexOf(
      "async function decodeOrphanedCollaborationRecoveryGroups",
      orphanedCollaborationStart
    );
    expect(client.slice(orphanedCollaborationStart, orphanedCollaborationEnd)).not.toContain(
      "if (page && !isCollaborativePage(page)) return [];"
    );
    expect(client).toContain("function refreshCollaborativePageDraftRecovery()");
    expect(client).toContain("appendPageDraftRecoveryPanel(elements.blockList, getCollaborativePageDrafts(page.id), { collaborative: true })");
    expect(client).toContain("refreshCollaborativePageDraftRecovery();");

    const shareStart = client.indexOf('elements.sharePageForm.addEventListener("submit"');
    const shareEnd = client.indexOf('elements.sharePageList.addEventListener("click"', shareStart);
    const shareBody = client.slice(shareStart, shareEnd);
    expect(shareBody).toContain('withPagePersistenceTransition(pageId, "share-add"');
    expect(shareBody).toContain("await flushPendingPageEdits({ allowLocked: true });");
    expect(shareBody).toContain("assertNoPendingLocalPageDrafts(pageId);");
    expect(shareBody.indexOf("assertNoPendingLocalPageDrafts(pageId);")).toBeLessThan(
      shareBody.indexOf("const data = await api")
    );

    const removeStart = shareEnd;
    const removeEnd = client.indexOf('document.addEventListener("keydown"', removeStart);
    const removeBody = client.slice(removeStart, removeEnd);
    expect(removeBody).toContain('withPagePersistenceTransition(pageId, "share-remove"');
    expect(removeBody).toContain(
      "await flushPendingPageEdits({ allowLocked: true, collaborationCompact: false });"
    );
    expect(removeBody.match(/assertNoPendingLocalCollaborationRecovery\(pageId\);/g)).toHaveLength(2);
    expect(removeBody.indexOf("assertNoPendingLocalCollaborationRecovery(pageId);")).toBeLessThan(
      removeBody.indexOf("const data = await api")
    );
  });

  it("blocks destructive transitions while any tab holds unconfirmed direct or Yjs recovery", () => {
    expect(client).toContain('const workspaceTransitionPagePrefix = "__workspace__"');
    expect(client).toContain("function getPageWorkspaceTransitionId(page = state.selectedPage)");
    expect(client).toContain("function withWorkspacePersistenceTransition(kind, action)");
    expect(client).toContain("pageTransitionLock.inspectActive()");
    expect(client).toContain("function assertNoPendingLocalPageDraftsForPages(");
    expect(client).toContain("function assertNoPendingLocalBlockDrafts(pageId, blockIds, options = {})");
    expect(client).toContain("function assertNoPendingLocalCollaborationRecoveryForPages(pageIds)");
    expect(client).toContain("collaborationRecoveryStore.loadAccountRecords(state.user.id)");
    expect(client).toContain("decodeCollaborationRecoveryRecords(group.records)");
    expect(client).toContain('heading.textContent = t("status.orphanedCollaborationRecovery")');

    const exportStart = client.indexOf("async function downloadUserDataBackup()");
    const exportEnd = client.indexOf("function resetDataImportSelection", exportStart);
    const exportBody = client.slice(exportStart, exportEnd);
    expect(exportBody).toContain('withWorkspacePersistenceTransition("data-export"');
    expect(exportBody).toContain("assertNoPendingLocalPageDraftsForPages(ownedPageIds)");
    expect(exportBody).toContain("assertNoPendingLocalCollaborationRecoveryForPages(ownedPageIds)");
    expect(exportBody.indexOf("assertNoPendingLocalPageDraftsForPages(ownedPageIds)")).toBeLessThan(
      exportBody.indexOf('await fetch("/api/data/export"')
    );

    const deleteStart = client.indexOf("async function deleteNavigationTarget()");
    const deleteEnd = client.indexOf("function renderCollectionView", deleteStart);
    const deleteBody = client.slice(deleteStart, deleteEnd);
    expect(deleteBody).toContain('withWorkspacePersistenceTransition("page-delete"');
    expect(deleteBody).toContain(
      'assertNoPendingLocalPageDraftsForPages(serverPageIds, "status.destructiveLocalDraftsPending")'
    );
    expect(deleteBody).toContain("assertNoPendingLocalCollaborationRecoveryForPages(serverPageIds)");
    expect(deleteBody.indexOf("assertNoPendingLocalPageDraftsForPages(serverPageIds")).toBeLessThan(
      deleteBody.indexOf('await api(`/api/pages/${target.id}?permanent=true`')
    );
    expect(deleteBody.indexOf("assertNoPendingLocalCollaborationRecoveryForPages(serverPageIds)")).toBeLessThan(
      deleteBody.indexOf('await api(`/api/pages/${target.id}?permanent=true`')
    );

    const restoreStart = client.indexOf("async function restoreUserDataBackup(file)");
    const restoreEnd = client.indexOf("function getUserInitials", restoreStart);
    const restoreBody = client.slice(restoreStart, restoreEnd);
    expect(restoreBody).toContain('withWorkspacePersistenceTransition("data-restore"');
    expect(restoreBody).toContain("const ownedPageIds = await fetchOwnedWorkspacePageIds()");
    expect(restoreBody).toContain(
      'assertNoPendingLocalPageDraftsForPages(ownedPageIds, "status.destructiveLocalDraftsPending")'
    );
    expect(restoreBody).toContain("assertNoPendingLocalCollaborationRecoveryForPages(ownedPageIds)");
    expect(restoreBody.indexOf("assertNoPendingLocalPageDraftsForPages(ownedPageIds")).toBeLessThan(
      restoreBody.indexOf('await api("/api/data/import"')
    );
    expect(restoreBody.indexOf("assertNoPendingLocalCollaborationRecoveryForPages(ownedPageIds)")).toBeLessThan(
      restoreBody.indexOf('await api("/api/data/import"')
    );
    expect(client).toContain('fetchAllPageSummaries({ archived: true })');

    const createCollectionStart = client.indexOf("async function createCollection()");
    const createCollectionEnd = client.indexOf("async function createUntitledPage()", createCollectionStart);
    expect(client.slice(createCollectionStart, createCollectionEnd).match(/assertWorkspacePersistenceUnlocked\(\);/g)).toHaveLength(2);

    const createPageStart = createCollectionEnd;
    const createPageEnd = client.indexOf("async function loadMe()", createPageStart);
    expect(client.slice(createPageStart, createPageEnd).match(/assertWorkspacePersistenceUnlocked\(\);/g)).toHaveLength(2);

    const archiveStart = client.indexOf('elements.archivePageButton.addEventListener("click"');
    const archiveEnd = client.indexOf('for (const eventName of ["focusin"', archiveStart);
    const archiveBody = client.slice(archiveStart, archiveEnd);
    expect(archiveBody).toContain('withPagePersistenceTransition(pageId, "page-archive"');
    expect(archiveBody).toContain(
      'assertNoPendingLocalPageDrafts(pageId, "status.destructiveLocalDraftsPending")'
    );
    expect(archiveBody).toContain("assertNoPendingLocalCollaborationRecovery(pageId)");
    expect(archiveBody.indexOf("assertNoPendingLocalPageDrafts(pageId")).toBeLessThan(
      archiveBody.indexOf('await api(`/api/pages/${pageId}`')
    );
    expect(archiveBody.indexOf("assertNoPendingLocalCollaborationRecovery(pageId)")).toBeLessThan(
      archiveBody.indexOf('await api(`/api/pages/${pageId}`')
    );

    const blockDeleteStart = client.indexOf("async function deleteBlockWithVersionCheck");
    const blockDeleteEnd = client.indexOf("function updateBlockInState", blockDeleteStart);
    const blockDeleteBody = client.slice(blockDeleteStart, blockDeleteEnd);
    expect(blockDeleteBody).toContain('withPagePersistenceTransition(pageId, "block-delete"');
    expect(blockDeleteBody).toContain("assertNoPendingLocalBlockDrafts(");
    expect(blockDeleteBody.indexOf("assertNoPendingLocalBlockDrafts(")).toBeLessThan(
      blockDeleteBody.indexOf('await api(`/api/blocks/${blockId}`')
    );
  });

  it("keeps failed callout style edits durable instead of rolling them back", () => {
    const changeStart = client.indexOf("async function changeCalloutType");
    const changeEnd = client.indexOf("function closeBlockContextMenu", changeStart);
    const changeBody = client.slice(changeStart, changeEnd);

    expect(changeBody).toContain("if (!markBlockDirty(row)) return;");
    expect(changeBody).toContain("await saveBlockRow(row, { quiet: true });");
    expect(changeBody).not.toContain("block.metadata = previousMetadata");
    expect(changeBody).not.toContain("setRowCalloutType(row, previousType)");
    expect(changeBody).toContain("the durable draft and retry queue already contain it");
  });

  it("requires explicit resolution before recovered conflict drafts can overwrite or delete newer server data", () => {
    expect(client).toContain('function confirmRecoveredDraftOverwrite()');
    expect(client).toContain('window.confirm(t("confirm.overwriteRecoveredDraft"))');
    expect(client).toContain('const expectedVersion = pageTitleDraftConflict');
    expect(client).toContain('const expectedVersion = row.dataset.draftConflict === "true"');
    expect(client).toContain('function promotePageTitleDraftConflict()');
    expect(client).toContain('function promoteBlockDraftConflict(row)');
    expect(client).toContain('function hasUnresolvedDraftConflicts()');
    expect(client).toContain('[...blockDraftConflictOrigins.values()].some((origin) => origin.resolved !== true)');
    expect(client).toContain('Boolean(storedOrigin && storedOrigin.resolved !== true)');
    expect(client).toContain('if (!allowConflictPrompt || !promotePageTitleDraftConflict())');
    expect(client).toContain('if (!allowConflictPrompt || !promoteBlockDraftConflict(row))');
    expect(client).toContain('await saveBlockRow(row, { resolveConflict: true });');
    expect(client).toContain('if (row.dataset.draftConflict === "true") {\n    reportUnresolvedDraftConflict();');
    expect(client).toContain('state.selectedPage?.id && subtreeIds.has(state.selectedPage.id) && hasUnresolvedDraftConflicts()');
    expect(client).toContain('pageDraftStore.removeBlockIfUnchanged({');
    expect(client).toContain('function blockSnapshotHasUnresolvedDraftConflict(expectedVersions)');
    expect(client).toContain('if (blockDeletionHasUnresolvedDraftConflict(blockId))');

    const markDirtyStart = client.indexOf('function markBlockDirty(row');
    const markDirtyEnd = client.indexOf('function getBlockSaveQueue', markDirtyStart);
    const markDirtyBody = client.slice(markDirtyStart, markDirtyEnd);
    expect(markDirtyBody).not.toContain('delete row.dataset.draftConflict;');
    expect(markDirtyBody).not.toContain('getBlockById(row.dataset.blockId)?.version');

    const titleScheduleStart = client.indexOf('function schedulePageTitleSave');
    const titleScheduleEnd = client.indexOf('function normalizeRecoveredBlockPayload', titleScheduleStart);
    const titleScheduleBody = client.slice(titleScheduleStart, titleScheduleEnd);
    expect(titleScheduleBody).not.toContain('pageTitleDraftConflict = false;');
    expect(titleScheduleBody).not.toContain('pageTitleDraftExpectedVersion = getPositiveVersion(state.selectedPage?.version);');
  });

  it("clears stale editor state and retry queues at every authentication boundary", () => {
    expect(client).toContain("function resetAuthenticationSessionState({ render = true } = {})");
    expect(client).toContain("discardPendingPageEdits();");
    expect(client).toContain("state.pages = [];");
    expect(client).toContain("state.allPages = [];");
    expect(client).toContain("state.selectedPage = null;");
    expect(client).toContain("state.pageEditLockDepth = 0;");
    expect(client).toContain("resetAuthenticationSessionState({ render: false });\n  setToken(data.token);");
    expect(client.match(/if \(response\.status === 401[^}]*resetAuthenticationSessionState\(\);/g)).toHaveLength(3);

    const resetStart = client.indexOf("function resetAuthenticationSessionState");
    const resetEnd = client.indexOf("function setAccountMessage", resetStart);
    const resetBody = client.slice(resetStart, resetEnd);
    expect(resetBody).not.toContain("pageDraftStore.remove");
    expect(resetBody).not.toContain("pageDraftStore.clear");
  });

  it("loads every page summary instead of silently truncating at one hundred", () => {
    expect(client).toContain("async function fetchAllPageSummaries");
    expect(client).toContain('if (cursor) params.set("cursor", cursor);');
    expect(client).toContain("const seenPageIds = new Set();");
    expect(client).toContain("const seenCursors = new Set();");
    expect(client).toContain("} while (cursor);");
    expect(client).toContain("return sortByRecent(pages);");
    expect(client).not.toContain('const data = await api("/api/pages?limit=100")');
  });

  it("preserves durable drafts from every tab after a backup restore", () => {
    const restoreStart = client.indexOf("async function restoreUserDataBackup(file)");
    const restoreEnd = client.indexOf("function getUserInitials", restoreStart);
    const restoreBody = client.slice(restoreStart, restoreEnd);

    expect(restoreBody).toContain("Preserve durable drafts from every tab");
    expect(restoreBody).not.toContain("pageDraftStore.clearUser");
    expect(transfer).toContain("const restoreVersionGap = 1_000_000");
    expect(transfer).toContain("const clockFloor = Date.now() * 1000");
  });

  it("preserves earlier note text when a structured slash command is used on a later line", () => {
    expect(client).toContain(
      'const slashInsertAfterTypes = new Set(["TABLE", "DATABASE", "TIMETABLE", "GANTT", "KANBAN", "BOOKMARK", "DIVIDER"]);'
    );

    const slashStart = client.indexOf("async function applySlashCommand(row, type)");
    const slashEnd = client.indexOf("async function persistBlockOrder", slashStart);
    const slashBody = client.slice(slashStart, slashEnd);
    const preserveBranch = slashBody.indexOf("if (slashInsertAfterTypes.has(type) && markdown.trim())");
    const saveExisting = slashBody.indexOf('await saveBlockRow(row, { quiet: true });', preserveBranch);
    const insertSibling = slashBody.indexOf('await insertBlockRelative(row, "after", {', preserveBranch);

    expect(preserveBranch).toBeGreaterThanOrEqual(0);
    expect(slashBody).toContain("previousTextarea.value = markdown;");
    expect(saveExisting).toBeGreaterThan(preserveBranch);
    expect(insertSibling).toBeGreaterThan(saveExisting);
    expect(slashBody).toContain("metadata: createInitialBlockMetadata(type)");
    expect(client).toContain('{ parentBlockId = null, sortOrder, allowLocked = false, type = "MARKDOWN", markdown = "", metadata }');
  });

  it("preserves metadata-backed blocks when their type is changed or an attachment is inserted", () => {
    expect(client).toContain(
      'const structuredBlockTypes = new Set(["TABLE", "DATABASE", "TIMETABLE", "GANTT", "KANBAN", "BOOKMARK", "AI_CHAT"]);'
    );
    expect(client).toContain("function isStructuredBlockType(type)");
    expect(client).toContain('if (type === "TIMETABLE") return { timetable: createDefaultTimetableData() };');
    expect(client).toContain('if (type === "GANTT") return { gantt: createDefaultGanttData() };');
    expect(client).toContain('if (type === "AI_CHAT") return { aiChat: createDefaultAiChatData() };');

    const slashStart = client.indexOf("async function applySlashCommand(row, type)");
    const slashEnd = client.indexOf("async function persistBlockOrder", slashStart);
    const slashBody = client.slice(slashStart, slashEnd);
    const preserveStructured = slashBody.indexOf(
      "if (isStructuredBlockType(previousType) && previousType !== type)"
    );
    const saveStructured = slashBody.indexOf('await saveBlockRow(row, { quiet: true });', preserveStructured);
    const insertStructuredSibling = slashBody.indexOf('await insertBlockRelative(row, "after", {', preserveStructured);

    expect(preserveStructured).toBeGreaterThanOrEqual(0);
    expect(saveStructured).toBeGreaterThan(preserveStructured);
    expect(insertStructuredSibling).toBeGreaterThan(saveStructured);

    const uploadStart = client.indexOf("async function uploadAttachmentFromRow");
    const uploadEnd = client.indexOf("function requestAttachmentUpload", uploadStart);
    const uploadBody = client.slice(uploadStart, uploadEnd);
    expect(uploadBody).toContain("!isStructuredBlockType(sourceType)");
    expect(uploadBody).toContain('let sourceNeedsSave = row.classList.contains("is-dirty");');
    expect(uploadBody).toContain("if (!replaceCurrentBlock && sourceNeedsSave) await saveBlockRow(row, { quiet: true });");
    expect(uploadBody).toContain("await blockSaveQueues.get(blockId).flush();");
  });

  it("does not delete attachment source text changed while an upload is in flight", () => {
    expect(client).toContain('const pageId = state.selectedPage.id;');
    expect(client).toContain('const sourceEditRevision = Number.parseInt(row.dataset.editRevision ?? "0", 10) || 0;');
    expect(client).toContain('row.setAttribute("aria-busy", "true");');
    expect(client).toContain('syncBlockReadOnlyState(row, true);');
    expect(client).toContain('const shouldReplaceCurrentBlock = replaceCurrentBlock && currentEditRevision === sourceEditRevision;');
    expect(client).toContain('if (row.isConnected && row.dataset.deleting !== "true") syncBlockReadOnlyState(row);');
    expect(client).toContain('const data = await api(`/api/pages/${pageId}/attachments`');
    expect(client).toContain(`if (state.selectedPage?.id === pageId) {\n      state.pendingFocusBlockId = data.block.id;`);
  });

  it("keeps reorder responses scoped to the page that started the request", () => {
    expect(client).toContain('const data = await api(`/api/pages/${task.pageId}/blocks/reorder`');
    expect(client).toContain('applyPageContentVersion(task.pageId, data.pageContentVersion);');
    expect(client).toContain(`if (state.selectedPage?.id === task.pageId) {\n    for (const block of data.blocks ?? []) updateBlockInState(block);`);
  });

  it("preserves other-tab drafts during block and page deletion and surfaces orphaned pages", () => {
    expect(client).toContain("pageDraftStore.removeBlocks(");
    expect(client).toContain("pageDraftStore.removePages(state.user.id, serverPageIds, pageDraftSourceId)");
    expect(client).not.toContain("pageDraftStore.clearBlocks(");
    expect(client).not.toContain("pageDraftStore.clearPages(");
    expect(client).toContain(".loadUserDrafts(state.user.id)");
    expect(client).toContain('heading.textContent = t("status.orphanedLocalDrafts")');
    expect(client).toContain('window.addEventListener("storage", (event) => {');
    expect(client).toContain('if (state.workspaceView === "home") renderHome();');
  });

  it("locks the whole editor before destructive block deletion flushes and commits", () => {
    const emptyDeleteStart = client.indexOf("async function deleteEmptyBlock(row)");
    const emptyDeleteEnd = client.indexOf("function focusPendingBlock", emptyDeleteStart);
    const emptyDeleteBody = client.slice(emptyDeleteStart, emptyDeleteEnd);

    expect(emptyDeleteBody).toContain("return withPageEditLock(async () => {");
    expect(emptyDeleteBody).not.toContain("await flushPendingPageEdits();");
    expect(emptyDeleteBody).toContain(
      "await persistBlockOrder(parentBlockId, nextSiblingIds, {}, { allowLocked: true });"
    );
    expect(emptyDeleteBody).toContain(
      "const starter = await createEmptyBlock(state.selectedPage.id, { allowLocked: true });"
    );
    expect(emptyDeleteBody).toContain("await openPage(state.selectedPage.id, { skipFlush: true });");

    expect(client).toMatch(
      /if \(button\.dataset\.action === "delete-block"\) \{[\s\S]*?await withPageEditLock\(async \(\) => \{[\s\S]*?await deleteBlockWithVersionCheck\(blockId\);[\s\S]*?await openPage\(pageId, \{ skipFlush: true \}\);/
    );
    expect(client).toContain(
      "async function persistBlockOrder(parentBlockId, orderedIds, versionOverrides = {}, { allowLocked = false } = {})"
    );
    expect(client).toContain("async function createEmptyBlock(");
    expect(client).toContain(
      '{ parentBlockId = null, sortOrder, allowLocked = false, type = "MARKDOWN", markdown = "", metadata }'
    );
  });

  it("replays ambiguous block-order commits instead of rolling the UI back", () => {
    expect(client).toContain("let pendingBlockOrderTask = null;");
    expect(client).toContain("pageDraftStore.saveBlockOrder({");
    expect(client).toContain("pageDraftStore.acknowledgeBlockOrder({");
    expect(client).toContain("body: { mutationId: task.mutationId, items: task.items }");
    expect(client).toContain("if (!isAmbiguousApiError(error)) throw error;");
    expect(client).toContain("if (pendingBlockOrderTask) return true;");
    expect(client).toMatch(/state\.pageEditLockDepth > 0 \|\|\s+blockOrderSaving/);
    expect(client).toContain('window.addEventListener("online", () => {');

    const dragStart = client.indexOf("async function finishBlockDrag");
    const dragEnd = client.indexOf("function setRowType", dragStart);
    const dragBody = client.slice(dragStart, dragEnd);
    const definitiveBranch = dragBody.indexOf("if (isDefinitiveApiError(error))");
    const rollback = dragBody.indexOf(
      "reorderBlockSiblingsInState(drag.parentBlockId, previousIds)",
      definitiveBranch
    );

    expect(client).toContain('if (!succeeded) throw new Error(t("status.localDraftStorageFailed"));');
    expect(dragBody).toContain("persistBlockOrderDraft(task);");
    expect(dragBody.indexOf("persistBlockOrderDraft(task);")).toBeLessThan(
      dragBody.indexOf("await submitBlockOrderTaskWithReplay(task);")
    );
    expect(dragBody).toContain("pendingBlockOrderTask = task;");
    expect(dragBody).toContain("await submitBlockOrderTaskWithReplay(task);");
    expect(client).toContain("() => persistBlockOrderDraft(task)");
    expect(dragBody).toContain("acknowledgeBlockOrderDraft(task);");
    expect(definitiveBranch).toBeGreaterThanOrEqual(0);
    expect(rollback).toBeGreaterThan(definitiveBranch);
    expect(dragBody).toContain("blockOrderSaving = Boolean(pendingBlockOrderTask);");
  });

  it("recovers durable block-order retries without overwriting a newer server order", () => {
    expect(client).toContain("const orderCandidates = records");
    expect(client).toContain("Number(block.version ?? 1) === selected.draft.items[index].expectedVersion");
    expect(client).toContain("recovery.orderConflicts.push({ sourceId: selected.sourceId, draft: selected.draft });");
    expect(client).toContain("serverIds: siblingIds");
    expect(client).toContain("previousIds: draft.previousIds ?? recovery.blockOrder.serverIds");
    expect(client).toContain("recovered: true");
    expect(client).toContain("recoveredOrigin: { sourceId, mutationId: draft.mutationId }");
    expect(client).toContain("sourceId: task.recoveredOrigin.sourceId");
    expect(client).toContain("mutationId: task.recoveredOrigin.mutationId");
    expect(client).toContain("if (isDefinitiveApiError(error) && pendingBlockOrderTask === task)");
    expect(client).toContain("retryPendingBlockOrder().catch((error) => setStatus(error.message, true));");
  });

  it("stores block-order mutation receipts in the same transaction", () => {
    expect(blockOrderMigration).toContain("CREATE TABLE IF NOT EXISTS block_order_mutations");
    expect(blockOrderMigration).toContain("PRIMARY KEY (owner_id, mutation_id)");
    expect(blockOrderMigration).toContain("request_hash CHAR(64)");
    expect(mutationMigration).toContain("last_mutation_hash CHAR(64)");
    expect(mutationMigration).toContain("request_hash CHAR(64)");
    expect(blockRoutes).toContain("FROM block_order_mutations");
    expect(blockRoutes).toContain("FOR UPDATE");
    expect(blockRoutes).toContain("receipt.request_hash !== mutationHash");
    expect(blockRoutes).toContain("last_mutation_hash = ?");
    expect(blockRoutes).toContain(
      "INSERT INTO block_order_mutations (owner_id, mutation_id, page_id, request_hash)"
    );
    expect(errorMiddleware).toContain('code: "TRANSACTION_COMMIT_OUTCOME_UNKNOWN"');
    expect(errorMiddleware).toContain("res.status(503).json");
  });

  it("keeps newer drafts durable when an in-flight save outlives an editor rerender", () => {
    expect(client).toContain("function getLatestKnownVersion(...values)");
    expect(client).toContain("const currentRow = findRenderedBlockRow(blockId) ?? task.row;");
    expect(client).toContain("const latestStoredDraft = task.userId");
    expect(client).toContain("const hasNewerLocalContent =");
    expect(client).toContain("const committedBlock = rebaseCommittedBlockContent(data.block, latestLocalPayload);");
    expect(client).toContain("currentRow.dataset.draftExpectedVersion = String(data.block.version);");
    expect(client).toContain("function getBlockRenderDraft(pageId, blockId)");
    expect(client).toContain("syncVisibleBlocksToState({ dirtyOnly: true });");
    expect(client).toContain("elements.blockList.dataset.pageId = page.id;");
    expect(client).toContain("const draftPayload = normalizeRecoveredBlockPayload(renderedDraft?.payload, block);");
    expect(client).toContain("const renderedBlock = draftPayload ? { ...block, ...draftPayload, htmlCache: null } : block;");
    expect(client).toContain("row.dataset.editRevision = String(renderedDraft.revision);");
    expect(client).toContain("row.dataset.draftExpectedVersion = String(renderedDraft.expectedVersion);");
    expect(client).toContain('row.dataset.draftConflict = "true";');
    expect(client).toContain(
      "renderBlock(block, isCollaborativePage(page) ? null : getBlockRenderDraft(page.id, block.id))"
    );
    expect(client).toContain("const latestStoredTitle = task.userId");
    expect(client).toContain("const hasNewerLocalTitle =");
    expect(client).toContain("const committedPage = rebaseCommittedPageTitle(");

    const dragStart = client.indexOf("async function finishBlockDrag");
    const dragEnd = client.indexOf("function setRowType", dragStart);
    const dragBody = client.slice(dragStart, dragEnd);
    expect(dragBody).toContain("return withPageEditLock(async () => {");
    expect(dragBody).toContain("const task = createBlockOrderTask(drag.parentBlockId, orderedIds, {}, { previousIds });");
    expect(dragBody).toContain("persistBlockOrderDraft(task);");
    expect(dragBody).toContain("await submitBlockOrderTaskWithReplay(task);");

    const profilePatchStart = client.indexOf("function enqueueAccountProfilePatch");
    const profilePatchEnd = client.indexOf("const pageTitleSaveQueue", profilePatchStart);
    const profilePatchBody = client.slice(profilePatchStart, profilePatchEnd);
    expect(profilePatchBody.indexOf('await before()')).toBeLessThan(
      profilePatchBody.indexOf('api("/api/auth/profile"')
    );

    const languageStart = client.indexOf('elements.languageSelect.addEventListener("change"');
    const languageEnd = client.indexOf('window.addEventListener("brainvault:languagechange"', languageStart);
    const languageBody = client.slice(languageStart, languageEnd);
    expect(languageBody).toContain("enqueueAccountProfilePatch(");
    expect(languageBody).toContain("{ before: flushPendingPageEdits }");
  });

  it("prevents delayed bookmark lookups from overwriting newer structured-block edits", () => {
    const addStart = client.indexOf("async function addBookmarkToRow(row)");
    const addEnd = client.indexOf("async function handleBookmarkAction", addStart);
    const addBody = client.slice(addStart, addEnd);
    expect(addBody).toContain("const context = createBookmarkRequestContext(row);");
    expect(addBody.indexOf("resolveCurrentBookmarkRow(context)")).toBeGreaterThan(
      addBody.indexOf('await api("/api/bookmarks/preview"')
    );
    expect(addBody).toContain("const data = extractBookmarkData(currentRow);");

    const refreshStart = client.indexOf('if (action === "bookmark-refresh")');
    const refreshEnd = client.indexOf("function mountBlockEditor", refreshStart);
    const refreshBody = client.slice(refreshStart, refreshEnd);
    expect(refreshBody).toContain("const latestData = extractBookmarkData(currentRow);");
    expect(refreshBody).toContain("latestIndex < 0 || !jsonValuesMatch(latestData.items[latestIndex], current)");
    expect(refreshBody).toContain("replaceBookmarkEditor(currentRow, latestData);");
    expect(refreshBody).toContain("await saveBlockRow(currentRow, { quiet: true });");
  });

  it("preserves attachment files when a database commit response is ambiguous", () => {
    expect(database).toContain("export class TransactionCommitOutcomeUnknownError extends Error");
    expect(database).toContain("readonly commitOutcomeUnknown = true");
    expect(database).toContain("if (commitStarted) throw new TransactionCommitOutcomeUnknownError(error)");
    expect(blockRoutes).toContain('"commitOutcomeUnknown" in error && error.commitOutcomeUnknown === true');
    expect(blockRoutes).toContain('Attachment commit outcome is unknown; preserving the moved file');
  });

  it("keeps rollback attachments outside the disposable restore directory and journals crash recovery", () => {
    expect(transfer).toContain('`.restore-previous-${safeUserId}-${journal.operationId}`');
    expect(transfer).toContain('preservedAttachmentDir: movedOld ? oldAttachmentDir : null');
    expect(transfer).not.toContain('path.join(operationRoot, "previous-attachments")');
    expect(transfer).toContain('DATA_RESTORE_OUTCOME_UNKNOWN');
    expect(transfer).toContain('DATA_RESTORE_RECOVERY_FAILED');
    expect(transfer).toContain('DATA_RESTORE_CONFLICT');
    expect(transfer).toContain('createWorkspaceRestoreSnapshot');
    expect(transfer).toContain('const { snapshot, attachmentFiles } = await withUserAttachmentLock');
    expect(transfer).toContain("Record the live attachment generation only after the user row is locked");
    expect(transfer).toContain("if (!restoreJournal || !journalWritten) throw error");
    expect(transfer).toContain("else if (!(await pathExists(paths.stagedAttachmentDir)))");
    expect(transfer).toContain('restoreJournalPrefix');
    expect(transfer).toContain('data_restore_markers');
    expect(transfer).toContain('recoverInterruptedDataRestores');
    expect(transfer).toContain('await handle.sync()');
    expect(transfer).toContain('await syncPath(attachmentUploadRoot)');
    expect(transfer).toContain('await syncPath(dataTransferTempDir)');
    expect(transfer).toContain('if (manifestBuffer.length > maxManifestBytes)');
    expect(transfer).toContain('const totalUncompressedSize = attachmentFiles.reduce(');
    expect(transfer).toContain('const maxTransferBytes = BigInt(env.DATA_TRANSFER_MAX_SIZE_MB) * 1024n * 1024n');
  });
});
