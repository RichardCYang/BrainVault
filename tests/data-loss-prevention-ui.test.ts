import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const transfer = readFileSync(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("Data-loss prevention integration", () => {
  it("serializes autosaves, flushes navigation, and protects dirty unloads", () => {
    expect(client).toContain('import { createLatestWriteQueue } from "./save-queue.js"');
    expect(client).toContain("await flushPendingPageEdits();");
    expect(client).toContain('window.addEventListener("beforeunload", handleBeforeUnload)');
    expect(client).toContain('document.addEventListener("visibilitychange"');
    expect(client).toContain('saveBlockRow(row, { quiet: true }).catch');
    expect(client).toContain('keepalive: task.keepalive === true');
    expect(client).toContain('expectedVersion: currentVersion');
    expect(client).toContain('const blockSaveRows = new Map()');
    expect(client).toContain('const rowsToSave = new Map(blockSaveRows)');
    expect(client).toContain('syncVisibleBlocksToState();\n  renderSelectedPage();');
    expect(client).toContain('await flushPendingPageEdits();\n  const headers = new Headers();');
    expect(client).toContain('applyPageContentVersion(task.pageId, data.pageContentVersion)');
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
    expect(transfer).toContain('restoreJournalPrefix');
    expect(transfer).toContain('data_restore_markers');
    expect(transfer).toContain('recoverInterruptedDataRestores');
    expect(transfer).toContain('await handle.sync()');
    expect(transfer).toContain('await syncPath(attachmentUploadRoot)');
    expect(transfer).toContain('await syncPath(dataTransferTempDir)');
  });
});
