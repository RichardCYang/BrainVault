import { createHmac } from "node:crypto";
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

import { env } from "../src/config/env.js";
import { attachmentUploadRoot } from "../src/lib/attachments.js";
import { customIconUploadRoot } from "../src/lib/custom-icons.js";
import {
  dataRestoreGenerationMarkerName,
  dataTransferTempDir,
  recoverDataRestoreJournal
} from "../src/lib/data-transfer.js";

const userId = "usr_restore_recovery_test";
let operationId = "";

function signJournal(journal: Record<string, unknown> & { version: number }) {
  let integrityValue: unknown[];
  if (journal.version === 1 || journal.version === 2) {
    integrityValue = [journal.version, journal.userId, journal.operationId, journal.hadPreviousAttachments];
  } else if (journal.version === 3) {
    integrityValue = [
      journal.version,
      journal.userId,
      journal.operationId,
      journal.hadPreviousAttachments,
      journal.restoredAttachmentIds
    ];
  } else {
    integrityValue = [
      journal.version,
      journal.userId,
      journal.operationId,
      journal.hadPreviousAttachments,
      journal.hadPreviousCustomIcons,
      journal.restoredAttachmentIds,
      journal.restoredCustomIconFiles
    ];
  }
  const hmac = createHmac("sha256", env.MFA_ENCRYPTION_KEY)
    .update("brainvault:data-restore-journal:v1", "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(integrityValue), "utf8")
    .digest("hex");
  return {
    format: "brainvault-restore-journal" as const,
    integrityVersion: 1 as const,
    journal,
    hmac
  };
}

function paths() {
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    journalPath: path.join(dataTransferTempDir, `restore-journal-${operationId}.json`),
    operationRoot: path.join(dataTransferTempDir, operationId),
    stagedAttachmentDir: path.join(dataTransferTempDir, operationId, "attachments"),
    oldAttachmentDir: path.join(attachmentUploadRoot, `.restore-previous-${safeUserId}-${operationId}`),
    targetAttachmentDir: path.join(attachmentUploadRoot, safeUserId),
    stagedCustomIconDir: path.join(dataTransferTempDir, operationId, "custom-icons"),
    oldCustomIconDir: path.join(customIconUploadRoot, `.restore-previous-${safeUserId}-${operationId}`),
    targetCustomIconDir: path.join(customIconUploadRoot, safeUserId)
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
  const envelope = signJournal(journal);
  await writeFile(value.journalPath, JSON.stringify(envelope));
  return envelope;
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
  const envelope = signJournal(journal);
  await writeFile(value.journalPath, JSON.stringify(envelope));
  return envelope;
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
  const envelope = signJournal(journal);
  await writeFile(value.journalPath, JSON.stringify(envelope));
  return envelope;
}

async function writeTrackedAssetFixture(hadPrevious: boolean) {
  const value = paths();
  await mkdir(value.targetAttachmentDir, { recursive: true });
  await writeFile(path.join(value.targetAttachmentDir, "restored_attachment"), "restored-attachment");
  await writeFile(path.join(value.targetAttachmentDir, "later_attachment"), "later-attachment");
  await writeFile(
    path.join(value.targetAttachmentDir, dataRestoreGenerationMarkerName),
    JSON.stringify({ version: 1, operationId })
  );
  await mkdir(value.targetCustomIconDir, { recursive: true });
  await writeFile(path.join(value.targetCustomIconDir, "restored.png"), "restored-icon");
  await writeFile(path.join(value.targetCustomIconDir, "later.png"), "later-icon");
  await writeFile(
    path.join(value.targetCustomIconDir, dataRestoreGenerationMarkerName),
    JSON.stringify({ version: 1, operationId })
  );
  if (hadPrevious) {
    await mkdir(value.oldAttachmentDir, { recursive: true });
    await writeFile(path.join(value.oldAttachmentDir, "restored_attachment"), "old-attachment");
    await mkdir(value.oldCustomIconDir, { recursive: true });
    await writeFile(path.join(value.oldCustomIconDir, "restored.png"), "old-icon");
  }
  const journal = {
    version: 4 as const,
    userId,
    operationId,
    hadPreviousAttachments: hadPrevious,
    hadPreviousCustomIcons: hadPrevious,
    restoredAttachmentIds: ["restored_attachment"],
    restoredCustomIconFiles: ["restored.png"]
  };
  await mkdir(dataTransferTempDir, { recursive: true });
  const envelope = signJournal(journal);
  await writeFile(value.journalPath, JSON.stringify(envelope));
  return envelope;
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
    rm(value.targetAttachmentDir, { recursive: true, force: true }),
    rm(value.oldCustomIconDir, { recursive: true, force: true }),
    rm(value.targetCustomIconDir, { recursive: true, force: true })
  ]);
});

describe("Interrupted data restore recovery", () => {
  it("rejects a structurally valid but unauthenticated recovery journal", async () => {
    await expect(recoverDataRestoreJournal({
      version: 1,
      userId,
      operationId,
      hadPreviousAttachments: false
    })).rejects.toThrow();
  });

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

  it("rolls back attachments and uploaded custom icons together while preserving later writes", async () => {
    const journal = await writeTrackedAssetFixture(true);

    await recoverDataRestoreJournal(journal);

    await expect(readFile(path.join(paths().targetAttachmentDir, "restored_attachment"), "utf8")).resolves.toBe("old-attachment");
    await expect(readFile(path.join(paths().targetAttachmentDir, "later_attachment"), "utf8")).resolves.toBe("later-attachment");
    await expect(readFile(path.join(paths().targetCustomIconDir, "restored.png"), "utf8")).resolves.toBe("old-icon");
    await expect(readFile(path.join(paths().targetCustomIconDir, "later.png"), "utf8")).resolves.toBe("later-icon");
  });

  it("finalizes committed attachment and custom-icon generations together", async () => {
    const journal = await writeTrackedAssetFixture(true);
    database.marker = operationId;

    await recoverDataRestoreJournal(journal);

    await expect(readFile(path.join(paths().targetAttachmentDir, "restored_attachment"), "utf8")).resolves.toBe("restored-attachment");
    await expect(readFile(path.join(paths().targetCustomIconDir, "restored.png"), "utf8")).resolves.toBe("restored-icon");
    await expect(readFile(paths().oldAttachmentDir, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths().oldCustomIconDir, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(paths().targetAttachmentDir, dataRestoreGenerationMarkerName), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(paths().targetCustomIconDir, dataRestoreGenerationMarkerName), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
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
