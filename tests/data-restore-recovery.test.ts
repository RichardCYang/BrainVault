import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  marker: null as string | null,
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn()
}));

vi.mock("../src/lib/db.js", () => ({
  db: {
    query: database.query,
    queryOne: database.queryOne,
    execute: database.execute
  },
  transaction: async (fn: (client: unknown) => unknown) =>
    fn({ query: database.query, queryOne: database.queryOne, execute: database.execute })
}));

import { attachmentUploadRoot } from "../src/lib/attachments.js";
import { dataTransferTempDir, recoverDataRestoreJournal } from "../src/lib/data-transfer.js";

const userId = "usr_restore_recovery_test";
let operationId = "";

function paths() {
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    journalPath: path.join(dataTransferTempDir, `restore-journal-${operationId}.json`),
    operationRoot: path.join(dataTransferTempDir, operationId),
    stagedAttachmentDir: path.join(dataTransferTempDir, operationId, "attachments"),
    oldAttachmentDir: path.join(attachmentUploadRoot, `.restore-previous-${safeUserId}-${operationId}`),
    targetAttachmentDir: path.join(attachmentUploadRoot, safeUserId)
  };
}

async function writeFixture(hadPreviousAttachments: boolean) {
  const value = paths();
  await mkdir(value.stagedAttachmentDir, { recursive: true });
  await writeFile(path.join(value.stagedAttachmentDir, "staged"), "staged");
  await mkdir(value.targetAttachmentDir, { recursive: true });
  await writeFile(path.join(value.targetAttachmentDir, "payload"), "new");
  if (hadPreviousAttachments) {
    await mkdir(value.oldAttachmentDir, { recursive: true });
    await writeFile(path.join(value.oldAttachmentDir, "payload"), "old");
  }
  const journal = { version: 1 as const, userId, operationId, hadPreviousAttachments };
  await mkdir(dataTransferTempDir, { recursive: true });
  await writeFile(value.journalPath, JSON.stringify(journal));
  return journal;
}

beforeEach(() => {
  operationId = `restore_recovery_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  database.marker = null;
  database.query.mockReset();
  database.queryOne.mockReset();
  database.execute.mockReset();
  database.query.mockResolvedValue([]);
  database.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM users WHERE id = ?")) return { id: userId };
    return database.marker ? { operation_id: database.marker } : undefined;
  });
  database.execute.mockResolvedValue({ affectedRows: 1 });
});

afterEach(async () => {
  const value = paths();
  await Promise.all([
    rm(value.journalPath, { force: true }),
    rm(value.operationRoot, { recursive: true, force: true }),
    rm(value.oldAttachmentDir, { recursive: true, force: true }),
    rm(value.targetAttachmentDir, { recursive: true, force: true })
  ]);
});

describe("Interrupted data restore recovery", () => {
  it("restores the previous attachment directory when the database transaction did not commit", async () => {
    const journal = await writeFixture(true);

    await recoverDataRestoreJournal(journal);

    await expect(readFile(path.join(paths().targetAttachmentDir, "payload"), "utf8")).resolves.toBe("old");
    await expect(readFile(paths().journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the new attachment directory after a committed database restore", async () => {
    const journal = await writeFixture(true);
    database.marker = operationId;

    await recoverDataRestoreJournal(journal);

    await expect(readFile(path.join(paths().targetAttachmentDir, "payload"), "utf8")).resolves.toBe("new");
    await expect(readFile(paths().oldAttachmentDir, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes promoted restore attachments when an empty prior workspace did not commit", async () => {
    const journal = await writeFixture(false);
    await rm(paths().stagedAttachmentDir, { recursive: true, force: true });

    await recoverDataRestoreJournal(journal);

    await expect(readFile(path.join(paths().targetAttachmentDir, "payload"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a later attachment generation when staged restore files were never promoted", async () => {
    const journal = await writeFixture(false);

    await recoverDataRestoreJournal(journal);

    await expect(readFile(path.join(paths().targetAttachmentDir, "payload"), "utf8")).resolves.toBe("new");
  });
});
