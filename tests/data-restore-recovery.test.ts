import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  dataRestoreGenerationMarkerName,
  dataTransferTempDir,
  recoverDataRestoreJournal
} from "../src/lib/data-transfer.js";

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

async function writeVersionedFixture(options: {
  hadPreviousAttachments: boolean;
  targetMarker?: boolean;
  staged?: boolean;
}) {
  const value = paths();
  if (options.staged !== false) {
    await mkdir(value.stagedAttachmentDir, { recursive: true });
    await writeFile(path.join(value.stagedAttachmentDir, "staged"), "staged");
    await writeFile(
      path.join(value.stagedAttachmentDir, dataRestoreGenerationMarkerName),
      JSON.stringify({ version: 1, operationId })
    );
  }
  await mkdir(value.targetAttachmentDir, { recursive: true });
  await writeFile(path.join(value.targetAttachmentDir, "payload"), "new");
  if (options.targetMarker) {
    await writeFile(
      path.join(value.targetAttachmentDir, dataRestoreGenerationMarkerName),
      JSON.stringify({ version: 1, operationId })
    );
  }
  if (options.hadPreviousAttachments) {
    await mkdir(value.oldAttachmentDir, { recursive: true });
    await writeFile(path.join(value.oldAttachmentDir, "payload"), "old");
  }
  const journal = {
    version: 2 as const,
    userId,
    operationId,
    hadPreviousAttachments: options.hadPreviousAttachments
  };
  await mkdir(dataTransferTempDir, { recursive: true });
  await writeFile(value.journalPath, JSON.stringify(journal));
  return journal;
}

async function writeTrackedFixture(hadPreviousAttachments: boolean) {
  const value = paths();
  await mkdir(value.targetAttachmentDir, { recursive: true });
  await writeFile(path.join(value.targetAttachmentDir, "payload"), "restored");
  await writeFile(path.join(value.targetAttachmentDir, "later_attachment"), "later");
  await writeFile(
    path.join(value.targetAttachmentDir, dataRestoreGenerationMarkerName),
    JSON.stringify({ version: 1, operationId })
  );
  if (hadPreviousAttachments) {
    await mkdir(value.oldAttachmentDir, { recursive: true });
    await writeFile(path.join(value.oldAttachmentDir, "payload"), "old");
  }
  const journal = {
    version: 3 as const,
    userId,
    operationId,
    hadPreviousAttachments,
    restoredAttachmentIds: ["payload"]
  };
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

  it("removes only the matching promoted generation for a versioned failed restore", async () => {
    const journal = await writeVersionedFixture({
      hadPreviousAttachments: false,
      targetMarker: true,
      staged: false
    });

    await recoverDataRestoreJournal(journal);

    await expect(readFile(path.join(paths().targetAttachmentDir, "payload"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths().journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a later unmarked generation when versioned rollback cleanup is retried", async () => {
    const journal = await writeVersionedFixture({
      hadPreviousAttachments: false,
      targetMarker: false,
      staged: false
    });

    await recoverDataRestoreJournal(journal);

    await expect(readFile(path.join(paths().targetAttachmentDir, "payload"), "utf8")).resolves.toBe("new");
    await expect(readFile(paths().journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves both generations when a later directory makes automatic rollback unsafe", async () => {
    const journal = await writeVersionedFixture({
      hadPreviousAttachments: true,
      targetMarker: false,
      staged: false
    });

    await expect(recoverDataRestoreJournal(journal)).rejects.toThrow("preserving both attachment generations");

    await expect(readFile(path.join(paths().targetAttachmentDir, "payload"), "utf8")).resolves.toBe("new");
    await expect(readFile(path.join(paths().oldAttachmentDir, "payload"), "utf8")).resolves.toBe("old");
    await expect(readFile(paths().journalPath, "utf8")).resolves.toContain('"version":2');
  });

  it("preserves an attachment uploaded after a failed tracked restore before rollback recovery", async () => {
    const journal = await writeTrackedFixture(true);

    await recoverDataRestoreJournal(journal);

    await expect(readFile(path.join(paths().targetAttachmentDir, "payload"), "utf8")).resolves.toBe("old");
    await expect(readFile(path.join(paths().targetAttachmentDir, "later_attachment"), "utf8")).resolves.toBe("later");
    await expect(
      readFile(path.join(paths().targetAttachmentDir, dataRestoreGenerationMarkerName), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths().journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes an interrupted survivor merge without losing the linked attachment", async () => {
    const journal = await writeTrackedFixture(true);
    await link(
      path.join(paths().targetAttachmentDir, "later_attachment"),
      path.join(paths().oldAttachmentDir, "later_attachment")
    );

    await recoverDataRestoreJournal(journal);

    await expect(readFile(path.join(paths().targetAttachmentDir, "payload"), "utf8")).resolves.toBe("old");
    await expect(readFile(path.join(paths().targetAttachmentDir, "later_attachment"), "utf8")).resolves.toBe("later");
  });

  it("preserves both generations when survivor filenames contain different bytes", async () => {
    const journal = await writeTrackedFixture(true);
    await writeFile(path.join(paths().oldAttachmentDir, "later_attachment"), "conflicting-old-file");

    await expect(recoverDataRestoreJournal(journal)).rejects.toThrow("preserving both generations");

    await expect(readFile(path.join(paths().targetAttachmentDir, "later_attachment"), "utf8")).resolves.toBe("later");
    await expect(readFile(path.join(paths().oldAttachmentDir, "later_attachment"), "utf8")).resolves.toBe("conflicting-old-file");
    await expect(readFile(paths().journalPath, "utf8")).resolves.toContain('"version":3');
  });

  it("removes only restore-owned files when a later upload created the first attachment directory", async () => {
    const journal = await writeTrackedFixture(false);

    await recoverDataRestoreJournal(journal);

    await expect(readFile(path.join(paths().targetAttachmentDir, "payload"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(paths().targetAttachmentDir, "later_attachment"), "utf8")).resolves.toBe("later");
    await expect(
      readFile(path.join(paths().targetAttachmentDir, dataRestoreGenerationMarkerName), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths().journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans the versioned generation marker after a committed restore", async () => {
    const journal = await writeVersionedFixture({
      hadPreviousAttachments: true,
      targetMarker: true,
      staged: false
    });
    database.marker = operationId;

    await recoverDataRestoreJournal(journal);

    await expect(readFile(path.join(paths().targetAttachmentDir, "payload"), "utf8")).resolves.toBe("new");
    await expect(
      readFile(path.join(paths().targetAttachmentDir, dataRestoreGenerationMarkerName), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
