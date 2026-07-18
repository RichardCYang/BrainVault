import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const injectedSyncFailure = vi.hoisted(() => ({ enabled: false, syncCalls: 0, failAt: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      if (!injectedSyncFailure.enabled) return handle;

      return {
        async sync() {
          injectedSyncFailure.syncCalls += 1;
          if (injectedSyncFailure.syncCalls === injectedSyncFailure.failAt) {
            const error = new Error("simulated directory sync failure") as NodeJS.ErrnoException;
            error.code = "EIO";
            throw error;
          }
          await handle.sync();
        },
        async close() {
          await handle.close();
        }
      };
    }
  };
});

const fs = await import("node:fs/promises");
const {
  attachmentTempDir,
  getAttachmentFilePath,
  moveAttachmentFile
} = await import("../src/lib/attachments.js");

describe("Attachment move durability", () => {
  it("preserves the final file when a directory sync fails after the temporary name is removed", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const ownerId = `usr_durable_${suffix}`;
    const blockId = `blk_durable_${suffix}`;
    const target = getAttachmentFilePath(ownerId, blockId);
    const temporaryPath = path.join(attachmentTempDir, `incoming-${suffix}`);
    const bytes = Buffer.from("only surviving attachment bytes");

    await fs.mkdir(path.dirname(temporaryPath), { recursive: true });
    await fs.writeFile(temporaryPath, bytes);
    injectedSyncFailure.syncCalls = 0;
    injectedSyncFailure.failAt = 3;
    injectedSyncFailure.enabled = true;

    try {
      await expect(moveAttachmentFile(temporaryPath, ownerId, blockId)).rejects.toMatchObject({ code: "EIO" });
      await expect(fs.readFile(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(target)).resolves.toEqual(bytes);
    } finally {
      injectedSyncFailure.enabled = false;
      await fs.rm(path.dirname(target), { recursive: true, force: true });
      await fs.rm(temporaryPath, { force: true });
    }
  });

  it("rolls back the final link when the temporary source still exists", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const ownerId = `usr_rollback_${suffix}`;
    const blockId = `blk_rollback_${suffix}`;
    const target = getAttachmentFilePath(ownerId, blockId);
    const temporaryPath = path.join(attachmentTempDir, `incoming-${suffix}`);
    const bytes = Buffer.from("recoverable temporary attachment bytes");

    await fs.mkdir(path.dirname(temporaryPath), { recursive: true });
    await fs.writeFile(temporaryPath, bytes);
    injectedSyncFailure.syncCalls = 0;
    injectedSyncFailure.failAt = 2;
    injectedSyncFailure.enabled = true;

    try {
      await expect(moveAttachmentFile(temporaryPath, ownerId, blockId)).rejects.toMatchObject({ code: "EIO" });
      await expect(fs.readFile(temporaryPath)).resolves.toEqual(bytes);
      await expect(fs.readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      injectedSyncFailure.enabled = false;
      await fs.rm(path.dirname(target), { recursive: true, force: true });
      await fs.rm(temporaryPath, { force: true });
    }
  });
});
