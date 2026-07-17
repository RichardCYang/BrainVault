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
  });

  it("keeps rollback attachments outside the disposable restore directory", () => {
    expect(transfer).toContain('`.restore-previous-${safeUserId}-${operationId}`');
    expect(transfer).toContain('preservedAttachmentDir: oldAttachmentDir');
    expect(transfer).not.toContain('path.join(operationRoot, "previous-attachments")');
    expect(transfer).toContain('DATA_RESTORE_ROLLBACK_FAILED');
  });
});
