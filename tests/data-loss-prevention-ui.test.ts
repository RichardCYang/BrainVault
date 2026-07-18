import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const transfer = readFileSync(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const database = readFileSync(new URL("../src/lib/db.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const blockRoutes = readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8").replace(
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
    expect(client).toContain('async function downloadUserDataBackup() {\n  return withPageEditLock(async () => {');
    expect(client).toContain('async function restoreUserDataBackup(file) {\n  return withPageEditLock(async () => {');
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
    expect(client).toContain("row.dataset.draftSourceId = pageDraftSourceId");
    expect(client).toContain("expectedVersion: getPositiveVersion(row.dataset.draftExpectedVersion)");
    expect(client).toContain("if (!activatePersistedPageDraft(recovery)) setStatus(t(\"status.documentOpened\"));");
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
    expect(client).toContain('const data = await api(`/api/pages/${pageId}/blocks/reorder`');
    expect(client).toContain('applyPageContentVersion(pageId, data.pageContentVersion);');
    expect(client).toContain(`if (state.selectedPage?.id === pageId) {\n    for (const block of data.blocks ?? []) updateBlockInState(block);`);
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
