import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Writable } from "node:stream";
import { access, copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { z } from "zod";
import { env } from "../config/env.js";
import { attachmentUploadRoot, getAttachmentFilePath, withUserAttachmentLock } from "./attachments.js";
import {
  assertLosslessAttachmentMetadata,
  AttachmentMetadataIntegrityError
} from "./attachment-metadata-integrity.js";
import { disconnectPageCollaborators } from "./collaboration-server.js";
import { needsCollaborationMaterialization } from "./collaboration-protocol.js";
import { db, transaction, type DbClient } from "./db.js";
import { ApiError } from "./http.js";
import { iconValueSchema, normalizeIconValue } from "./icon-value.js";
import { createId } from "./id.js";
import {
  getBackupPageShareIdentityMode,
  isExactBackupPageShareIdentityMatch,
  isLegacyBackupPageShareCurrentMatch,
  isRestorablePageShareTarget
} from "./page-share-integrity.js";
import { renderBlockHtml } from "./markdown.js";
import { dataTransferResourceLimits, measureJsonUtf8BytesWithinLimit } from "./data-transfer-limits.js";
import { blockSortOrderLimits } from "./block-order-integrity.js";
import { maxAvatarBytes, normalizeAvatarDataUrl } from "./profile.js";
import {
  assertLosslessBackupBlockMetadata,
  BackupMetadataIntegrityError
} from "./structured-metadata-integrity.js";
import {
  calculateZipArchiveSize,
  copyZipEntryToFile,
  crc32,
  readZipDirectory,
  readZipEntryBuffer,
  updateCrc32,
  ZipWriter
} from "./zip.js";
import type { BlockType, UserRow } from "../types/domain.js";

export const dataTransferTempDir = path.join(attachmentUploadRoot, ".data-transfer");
const manifestName = "brainvault-backup.json";
const backupFormat = "brainvault-backup";
const backupVersion = 1;
const maxManifestBytes = env.DATA_TRANSFER_MAX_MANIFEST_SIZE_MB * 1024 * 1024;
const idSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const timestampSchema = z.string().min(1).max(40);
const nullableString = (max: number) => z.string().max(max).nullable();
const nullableHttpUrl = (max: number) =>
  z
    .string()
    .max(max)
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, "URL must use HTTP or HTTPS")
    .nullable();
const backupAvatarSchema = z
  .string()
  .max(Math.ceil((maxAvatarBytes * 4) / 3) + 128)
  .nullable()
  .refine((value) => {
    try {
      normalizeAvatarDataUrl(value);
      return true;
    } catch {
      return false;
    }
  }, "Backup avatar is invalid");
const restoreJournalPrefix = "restore-journal-";
export const dataRestoreGenerationMarkerName = ".brainvault-restore-generation.json";
const restoreGenerationMarkerSchema = z.object({
  version: z.literal(1),
  operationId: idSchema
}).strict();
const restoreJournalV1Schema = z.object({
  version: z.literal(1),
  userId: idSchema,
  operationId: idSchema,
  hadPreviousAttachments: z.boolean()
}).strict();
const restoreJournalV2Schema = z.object({
  version: z.literal(2),
  userId: idSchema,
  operationId: idSchema,
  hadPreviousAttachments: z.boolean()
}).strict();
const restoreJournalV3Schema = z.object({
  version: z.literal(3),
  userId: idSchema,
  operationId: idSchema,
  hadPreviousAttachments: z.boolean(),
  // Recovery must remain compatible with journals created before the current backup intake limits.
  restoredAttachmentIds: z.array(idSchema).max(1_000_000)
}).strict();
const restoreJournalSchema = z.discriminatedUnion("version", [
  restoreJournalV1Schema,
  restoreJournalV2Schema,
  restoreJournalV3Schema
]);
type RestoreJournal = z.infer<typeof restoreJournalSchema>;
type RestoreJournalV2 = z.infer<typeof restoreJournalV2Schema>;
type RestoreJournalV3 = z.infer<typeof restoreJournalV3Schema>;

const pageSchema = z.object({
  id: idSchema,
  title: z.string().max(160),
  icon: iconValueSchema.nullable(),
  cover_url: nullableHttpUrl(500),
  is_archived: z.union([z.literal(0), z.literal(1)]),
  is_collection: z.union([z.literal(0), z.literal(1)]),
  parent_page_id: idSchema.nullable(),
  edit_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  content_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema
}).strict();

const blockTypes = [
  "MARKDOWN", "HEADING_1", "HEADING_2", "HEADING_3", "TODO", "QUOTE", "CALLOUT", "TOGGLE", "TABLE",
  "KANBAN", "DATABASE", "TIMETABLE", "GANTT", "BOOKMARK", "AI_CHAT", "MATH", "CODE", "DIVIDER", "IMAGE", "VIDEO", "ATTACHMENT"
] as const satisfies readonly BlockType[];

const blockSchema = z.object({
  id: idSchema,
  page_id: idSchema,
  parent_block_id: idSchema.nullable(),
  type: z.enum(blockTypes),
  markdown: z.string().max(20_000),
  html_cache: z.string().nullable(),
  checked: z.union([z.literal(0), z.literal(1)]),
  sort_order: z.number().int()
    .min(blockSortOrderLimits.min)
    .max(blockSortOrderLimits.max),
  metadata: z.string().nullable(),
  edit_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema
}).strict();

const tagSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(50),
  created_at: timestampSchema
}).strict();

const pageTagSchema = z.object({ page_id: idSchema, tag_id: idSchema }).strict();
const pageShareSchema = z.object({
  page_id: idSchema,
  // Optional only for backups exported before collaborator account IDs were
  // bound to sharing grants. New exports always include this field.
  shared_user_id: idSchema.optional(),
  shared_username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9._-]+$/),
  permission: z.literal("EDIT"),
  created_at: timestampSchema
}).strict();
const attachmentSchema = z.object({
  blockId: idSchema,
  path: z.string().min(1).max(160),
  size: z.string().regex(/^\d+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  crc32: z.number().int().min(0).max(0xffffffff)
}).strict();

const manifestSchema = z.object({
  format: z.literal(backupFormat),
  version: z.literal(backupVersion),
  exportedAt: timestampSchema,
  source: z.object({ userId: idSchema, username: z.string().min(1).max(50) }).strict(),
  account: z.object({
    name: nullableString(80),
    avatar_data: backupAvatarSchema,
    preferred_language: nullableString(10),
    default_collection_icon: iconValueSchema.nullable()
  }).strict(),
  data: z.object({
    pages: z.array(pageSchema).max(dataTransferResourceLimits.maxPages),
    blocks: z.array(blockSchema).max(dataTransferResourceLimits.maxBlocks),
    tags: z.array(tagSchema).max(dataTransferResourceLimits.maxTags),
    pageTags: z.array(pageTagSchema).max(dataTransferResourceLimits.maxPageTags),
    // Optional only for backward compatibility with backups exported before
    // page sharing relationships became part of the complete workspace format.
    pageShares: z.array(pageShareSchema).max(dataTransferResourceLimits.maxPageShares).optional()
  }).strict(),
  attachments: z.array(attachmentSchema).max(dataTransferResourceLimits.maxAttachments)
}).strict();

export type BrainVaultBackup = z.infer<typeof manifestSchema>;
type BackupPage = BrainVaultBackup["data"]["pages"][number];
type BackupBlock = BrainVaultBackup["data"]["blocks"][number];
type BackupTag = BrainVaultBackup["data"]["tags"][number];
type BackupPageShare = z.infer<typeof pageShareSchema>;

type WorkspaceRestoreAccountRow = {
  name: string | null;
  avatar_data: string | null;
  preferred_language: string | null;
  default_collection_icon: string | null;
};

type WorkspaceRestorePageRow = {
  id: string;
  parent_page_id: string | null;
  edit_version: number;
  content_version: number;
};

type WorkspaceRestoreBlockRow = {
  id: string;
  page_id: string;
  parent_block_id: string | null;
  type: BlockType;
  edit_version: number;
};

type WorkspaceRestoreShareRow = {
  page_id: string;
  user_id: string;
  permission: "EDIT";
  shared_by: string;
  shared_at: string;
};

type RestoredPageShare = {
  pageId: string;
  userId: string;
  permission: "EDIT";
  createdAt: string;
};

type RestoreSharingPlan = {
  mode: "backup" | "legacy-preserved";
  shares: RestoredPageShare[];
};

type WorkspaceCollaborationStateRow = {
  page_id: string;
  latest_update_id: number | bigint | null;
  materialized_update_id: number | bigint | null;
  materialization_version: number | bigint | null;
};

type RawAccountRow = {
  id: string;
  username: string;
  name: string | null;
  avatar_data: string | null;
  preferred_language: string | null;
  default_collection_icon: string | null;
};

type FileInspection = { size: bigint; sha256: string; crc32: number };

export async function ensureDataTransferDirectories() {
  await mkdir(dataTransferTempDir, { recursive: true });
}

async function inspectFile(filePath: string): Promise<FileInspection> {
  const hash = createHash("sha256");
  let checksum = 0;
  let size = 0n;
  for await (const chunk of createReadStream(filePath)) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(data);
    checksum = updateCrc32(checksum, data);
    size += BigInt(data.length);
  }
  return { size, sha256: hash.digest("hex"), crc32: checksum };
}

async function syncPath(value: string) {
  const handle = await open(value, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryIfPresent(value: string) {
  if (await pathExists(value)) await syncPath(value);
}

function parseCollaborationUpdateId(value: number | bigint | null | undefined) {
  const updateId = Number(value ?? 0);
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw new ApiError(
      500,
      "INVALID_COLLABORATION_STATE",
      "Collaboration update id exceeded the supported range"
    );
  }
  return updateId;
}

async function assertWorkspaceCollaborationMaterialized(client: DbClient, pageIds: string[], lock = false) {
  const lockClause = lock ? " FOR UPDATE" : "";
  const pending: Array<{
    pageId: string;
    latestUpdateId: number;
    materializedUpdateId: number;
    materializationVersion: number;
  }> = [];
  for (let index = 0; index < pageIds.length; index += 500) {
    const group = pageIds.slice(index, index + 500);
    if (!group.length) continue;
    const rows = await client.query<WorkspaceCollaborationStateRow>(
      `SELECT p.id AS page_id, MAX(y.id) AS latest_update_id,
         COALESCE(s.materialized_update_id, 0) AS materialized_update_id,
         COALESCE(s.materialization_version, 0) AS materialization_version
       FROM pages p
       LEFT JOIN page_yjs_updates y ON y.page_id = p.id
       LEFT JOIN page_collaboration_state s ON s.page_id = p.id
       WHERE p.id IN (${group.map(() => "?").join(",")})
       GROUP BY p.id, s.materialized_update_id, s.materialization_version
       ORDER BY p.id ASC${lockClause}`,
      group
    );
    for (const row of rows) {
      const latestUpdateId = parseCollaborationUpdateId(row.latest_update_id);
      const materializedUpdateId = parseCollaborationUpdateId(row.materialized_update_id);
      const materializationVersion = parseCollaborationUpdateId(row.materialization_version);
      if (needsCollaborationMaterialization({
        latestUpdateId,
        materializedUpdateId,
        materializationVersion
      })) {
        pending.push({
          pageId: row.page_id,
          latestUpdateId,
          materializedUpdateId,
          materializationVersion
        });
      }
    }
  }

  if (pending.length) {
    throw new ApiError(
      409,
      "COLLABORATION_CHANGES_PENDING",
      "Synchronize every collaborative page before exporting or replacing workspace data. No data was replaced.",
      {
        pendingPageCount: pending.length,
        pages: pending.slice(0, 100),
        truncated: pending.length > 100
      }
    );
  }
}

async function createWorkspaceRestoreSnapshot(userId: string, client: DbClient = db, lock = false) {
  const lockClause = lock ? " FOR UPDATE" : "";
  const account = await client.queryOne<WorkspaceRestoreAccountRow>(
    `SELECT name, avatar_data, preferred_language, default_collection_icon
     FROM users WHERE id = ?${lockClause}`,
    [userId]
  );
  if (!account) throw new ApiError(404, "NOT_FOUND", "User not found");

  const pages = await client.query<WorkspaceRestorePageRow>(
    `SELECT id, parent_page_id, edit_version, content_version
     FROM pages WHERE owner_id = ? ORDER BY id ASC${lockClause}`,
    [userId]
  );
  await assertWorkspaceCollaborationMaterialized(client, pages.map((page) => page.id), lock);
  const blocks = await client.query<WorkspaceRestoreBlockRow>(
    `SELECT b.id, b.page_id, b.parent_block_id, b.type, b.edit_version
     FROM blocks b INNER JOIN pages p ON p.id = b.page_id
     WHERE p.owner_id = ? ORDER BY b.id ASC${lockClause}`,
    [userId]
  );
  const shares = await client.query<WorkspaceRestoreShareRow>(
    `SELECT ps.page_id, ps.user_id, ps.permission, ps.shared_by,
            DATE_FORMAT(ps.created_at, '%Y-%m-%d %H:%i:%s.%f') AS shared_at
     FROM page_shares ps INNER JOIN pages p ON p.id = ps.page_id
     WHERE p.owner_id = ?
     ORDER BY ps.page_id ASC, ps.user_id ASC${lockClause}`,
    [userId]
  );

  const hash = createHash("sha256");
  hash.update(`account\0${JSON.stringify(account)}\n`);
  for (const page of pages) {
    hash.update(
      `page\0${page.id}\0${page.parent_page_id ?? ""}\0${Number(page.edit_version ?? 1)}\0${Number(page.content_version ?? 1)}\n`
    );
  }
  for (const block of blocks) {
    hash.update(
      `block\0${block.id}\0${block.page_id}\0${block.parent_block_id ?? ""}\0${block.type}\0${Number(block.edit_version ?? 1)}\n`
    );
  }
  for (const share of shares) {
    hash.update(
      `share\0${share.page_id}\0${share.user_id}\0${share.permission}\0${share.shared_by}\0${share.shared_at}\n`
    );
  }
  return {
    fingerprint: hash.digest("hex"),
    pageIds: pages.map((page) => page.id),
    shares
  };
}

function invalidBackup(message: string, details?: unknown): never {
  throw new ApiError(400, "INVALID_DATA_BACKUP", message, details);
}

function assertExportCount(label: string, count: number, maximum: number) {
  if (count <= maximum) return;
  throw new ApiError(
    413,
    "DATA_BACKUP_TOO_LARGE",
    `The workspace contains too many ${label} for one backup`,
    { count, maximum }
  );
}

function assertUnique(values: string[], label: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalidBackup(`The backup contains a duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function orderByParent<T>(items: T[], getId: (item: T) => string, getParent: (item: T) => string | null) {
  const itemById = new Map(items.map((item) => [getId(item), item]));
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const item of items) {
    const id = getId(item);
    const parentId = getParent(item);
    indegree.set(id, parentId ? 1 : 0);
    if (parentId) {
      const group = children.get(parentId) ?? [];
      group.push(id);
      children.set(parentId, group);
    }
  }

  const queue = items.filter((item) => (indegree.get(getId(item)) ?? 0) === 0).map(getId);
  const ordered: T[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    const item = itemById.get(id);
    if (!item) continue;
    ordered.push(item);
    for (const childId of children.get(id) ?? []) {
      const next = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, next);
      if (next === 0) queue.push(childId);
    }
  }
  if (ordered.length !== items.length) invalidBackup("The backup contains a parent cycle");
  return ordered;
}

function validateManifestRelations(manifest: BrainVaultBackup) {
  const { pages, blocks, tags, pageTags } = manifest.data;
  const pageShares = manifest.data.pageShares ?? [];
  assertUnique(pages.map((item) => item.id), "page ID");
  assertUnique(blocks.map((item) => item.id), "block ID");
  assertUnique(tags.map((item) => item.id), "tag ID");
  assertUnique(tags.map((item) => item.name.toLowerCase()), "tag name");
  assertUnique(manifest.attachments.map((item) => item.blockId), "attachment block ID");
  assertUnique(manifest.attachments.map((item) => item.path), "attachment path");
  assertUnique(
    pageShares.map((item) => `${item.page_id}\u0000${item.shared_username.toLowerCase()}`),
    "page share username"
  );
  assertUnique(
    pageShares
      .filter((item) => item.shared_user_id)
      .map((item) => `${item.page_id}\u0000${item.shared_user_id}`),
    "page share account ID"
  );
  if (getBackupPageShareIdentityMode(pageShares) === "mixed") {
    invalidBackup("The backup mixes ID-bound and legacy username-only sharing grants");
  }

  const pageById = new Map(pages.map((item) => [item.id, item]));
  const blockById = new Map(blocks.map((item) => [item.id, item]));
  const tagIds = new Set(tags.map((item) => item.id));
  for (const page of pages) {
    if (page.parent_page_id && !pageById.has(page.parent_page_id)) invalidBackup(`Page parent is missing: ${page.id}`);
    if (page.parent_page_id === page.id) invalidBackup(`Page cannot parent itself: ${page.id}`);
    if (page.is_collection && page.parent_page_id) invalidBackup(`Collection has an invalid parent: ${page.id}`);
  }
  orderByParent(pages, (item) => item.id, (item) => item.parent_page_id);

  for (const block of blocks) {
    if (!pageById.has(block.page_id)) invalidBackup(`Block page is missing: ${block.id}`);
    if (block.parent_block_id) {
      const parent = blockById.get(block.parent_block_id);
      if (!parent || parent.page_id !== block.page_id) invalidBackup(`Block parent is invalid: ${block.id}`);
    }
    if (block.parent_block_id === block.id) invalidBackup(`Block cannot parent itself: ${block.id}`);
    try {
      assertLosslessBackupBlockMetadata(block);
    } catch (error) {
      if (error instanceof BackupMetadataIntegrityError) {
        invalidBackup(`Block metadata cannot be restored without data loss: ${block.id}`, {
          path: error.path,
          reason: error.reason
        });
      }
      throw error;
    }
  }
  orderByParent(blocks, (item) => item.id, (item) => item.parent_block_id);

  for (const share of pageShares) {
    const page = pageById.get(share.page_id);
    if (!page) invalidBackup(`Shared page is missing: ${share.page_id}`);
    if (!isRestorablePageShareTarget(page)) {
      invalidBackup(`Shared page cannot be a collection: ${share.page_id}`);
    }
  }

  const pageTagKeys = new Set<string>();
  for (const relation of pageTags) {
    if (!pageById.has(relation.page_id) || !tagIds.has(relation.tag_id)) invalidBackup("The backup contains an invalid page-tag relation");
    const key = `${relation.page_id}\u0000${relation.tag_id}`;
    if (pageTagKeys.has(key)) invalidBackup("The backup contains a duplicate page-tag relation");
    pageTagKeys.add(key);
  }

  const attachmentBlockIds = new Set(blocks.filter((block) => block.type === "ATTACHMENT").map((block) => block.id));
  const describedAttachmentIds = new Set(manifest.attachments.map((item) => item.blockId));
  if (attachmentBlockIds.size !== describedAttachmentIds.size) invalidBackup("Attachment files do not match attachment blocks");
  for (const attachment of manifest.attachments) {
    const block = blockById.get(attachment.blockId);
    if (!block || block.type !== "ATTACHMENT") invalidBackup(`Attachment block is missing: ${attachment.blockId}`);
    if (attachment.path !== `attachments/${attachment.blockId}`) invalidBackup(`Attachment path is invalid: ${attachment.path}`);
    try {
      assertLosslessAttachmentMetadata(block.metadata, attachment.size);
    } catch (error) {
      if (error instanceof AttachmentMetadataIntegrityError) {
        invalidBackup(`Attachment metadata cannot be restored without data loss: ${attachment.blockId}`, {
          path: error.path,
          reason: error.reason
        });
      }
      throw error;
    }
  }
}

export async function prepareUserDataBackup(userId: string) {
  await ensureDataTransferDirectories();
  const maxTransferBytes = BigInt(env.DATA_TRANSFER_MAX_SIZE_MB) * 1024n * 1024n;
  const operationRoot = path.join(dataTransferTempDir, createId("export"));
  const stagedAttachmentDir = path.join(operationRoot, "attachments");
  await mkdir(stagedAttachmentDir, { recursive: true });

  try {
    const { snapshot, attachmentFiles } = await withUserAttachmentLock(userId, async (client) => {
      // Lock the complete page set before the first consistent read establishes the
      // REPEATABLE READ snapshot. Otherwise a concurrent commit can make this locking
      // read observe newer page versions while later non-locking reads still return
      // older blocks and tag relations from an earlier snapshot.
      const pages = await client.query<BackupPage>(
        `SELECT id, title, icon, cover_url, is_archived, is_collection, parent_page_id, edit_version, content_version,
           DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at,
           DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at
         FROM pages WHERE owner_id = ? ORDER BY created_at ASC, id ASC FOR UPDATE`,
        [userId]
      );

      const account = await client.queryOne<RawAccountRow>(
        `SELECT id, username, name, avatar_data, preferred_language, default_collection_icon
         FROM users WHERE id = ?`,
        [userId]
      );
      if (!account) throw new ApiError(404, "NOT_FOUND", "User not found");
      await assertWorkspaceCollaborationMaterialized(client, pages.map((page) => page.id), true);
      const blocks = await client.query<BackupBlock>(
        `SELECT b.id, b.page_id, b.parent_block_id, b.type, b.markdown, b.html_cache, b.checked, b.sort_order,
           CAST(b.metadata AS CHAR CHARACTER SET utf8mb4) AS metadata, b.edit_version,
           DATE_FORMAT(b.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at,
           DATE_FORMAT(b.updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at
         FROM blocks b INNER JOIN pages p ON p.id = b.page_id
         WHERE p.owner_id = ? ORDER BY b.created_at ASC, b.id ASC`,
        [userId]
      );
      const tags = await client.query<BackupTag>(
        `SELECT DISTINCT t.id, t.name, DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
         FROM tags t INNER JOIN page_tags pt ON pt.tag_id = t.id INNER JOIN pages p ON p.id = pt.page_id
         WHERE p.owner_id = ? ORDER BY t.name ASC`,
        [userId]
      );
      const pageTags = await client.query<{ page_id: string; tag_id: string }>(
        `SELECT pt.page_id, pt.tag_id FROM page_tags pt INNER JOIN pages p ON p.id = pt.page_id
         WHERE p.owner_id = ? ORDER BY pt.page_id ASC, pt.tag_id ASC`,
        [userId]
      );
      const pageShares = await client.query<BackupPageShare>(
        `SELECT ps.page_id, ps.user_id AS shared_user_id, u.username AS shared_username, ps.permission,
                DATE_FORMAT(ps.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
         FROM page_shares ps
         INNER JOIN pages p ON p.id = ps.page_id
         INNER JOIN users u ON u.id = ps.user_id
         WHERE p.owner_id = ?
         ORDER BY ps.page_id ASC, u.username ASC`,
        [userId]
      );
      const attachmentBlocks = blocks.filter((item) => item.type === "ATTACHMENT");
      assertExportCount("pages", pages.length, dataTransferResourceLimits.maxPages);
      assertExportCount("blocks", blocks.length, dataTransferResourceLimits.maxBlocks);
      assertExportCount("tags", tags.length, dataTransferResourceLimits.maxTags);
      assertExportCount("page-tag relations", pageTags.length, dataTransferResourceLimits.maxPageTags);
      assertExportCount("page sharing grants", pageShares.length, dataTransferResourceLimits.maxPageShares);
      assertExportCount("attachments", attachmentBlocks.length, dataTransferResourceLimits.maxAttachments);

      const snapshot = { account, pages, blocks, tags, pageTags, pageShares };
      const attachmentFiles = [] as Array<{ blockId: string; path: string; filePath: string; inspection: FileInspection }>;
      let stagedAttachmentBytes = 0n;
      for (const block of attachmentBlocks) {
        const sourcePath = getAttachmentFilePath(userId, block.id);
        const stagedPath = path.join(stagedAttachmentDir, block.id);
        try {
          const fileStat = await stat(sourcePath);
          if (!fileStat.isFile()) throw new Error("not a file");
          if (stagedAttachmentBytes + BigInt(fileStat.size) > maxTransferBytes) {
            throw new ApiError(413, "DATA_BACKUP_TOO_LARGE", "The backup exceeds the configured data-transfer limit");
          }
          await copyFile(sourcePath, stagedPath);
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(409, "BACKUP_ATTACHMENT_MISSING", `Attachment file is missing for block ${block.id}`);
        }
        const inspection = await inspectFile(stagedPath);
        stagedAttachmentBytes += inspection.size;
        if (stagedAttachmentBytes > maxTransferBytes) {
          throw new ApiError(413, "DATA_BACKUP_TOO_LARGE", "The backup exceeds the configured data-transfer limit");
        }
        try {
          assertLosslessAttachmentMetadata(block.metadata, inspection.size);
        } catch (error) {
          if (error instanceof AttachmentMetadataIntegrityError) {
            throw new ApiError(
              409,
              "BACKUP_ATTACHMENT_METADATA_INVALID",
              `Attachment metadata does not match the stored file for block ${block.id}`,
              { path: error.path, reason: error.reason }
            );
          }
          throw error;
        }
        attachmentFiles.push({
          blockId: block.id,
          path: `attachments/${block.id}`,
          filePath: stagedPath,
          inspection
        });
      }
      return { snapshot, attachmentFiles };
    });

    const manifest: BrainVaultBackup = {
      format: backupFormat,
      version: backupVersion,
      exportedAt: new Date().toISOString(),
      source: { userId: snapshot.account.id, username: snapshot.account.username },
      account: {
        name: snapshot.account.name,
        avatar_data: snapshot.account.avatar_data,
        preferred_language: snapshot.account.preferred_language,
        default_collection_icon: normalizeIconValue(snapshot.account.default_collection_icon)
      },
      data: {
        pages: snapshot.pages.map((page) => ({
          ...page,
          icon: normalizeIconValue(page.icon)
        })),
        blocks: snapshot.blocks,
        tags: snapshot.tags,
        pageTags: snapshot.pageTags,
        pageShares: snapshot.pageShares
      },
      attachments: attachmentFiles.map((item) => ({
        blockId: item.blockId,
        path: item.path,
        size: item.inspection.size.toString(),
        sha256: item.inspection.sha256,
        crc32: item.inspection.crc32
      }))
    };
    const measuredManifestBytes = measureJsonUtf8BytesWithinLimit(manifest, maxManifestBytes - 1);
    if (measuredManifestBytes === null) {
      throw new ApiError(
        413,
        "DATA_BACKUP_TOO_LARGE",
        "The backup manifest exceeds the supported import limit"
      );
    }
    const manifestBuffer = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    if (manifestBuffer.length > maxManifestBytes) {
      throw new ApiError(
        413,
        "DATA_BACKUP_TOO_LARGE",
        "The backup manifest exceeds the supported import limit"
      );
    }
    const totalUncompressedSize = attachmentFiles.reduce(
      (total, item) => total + item.inspection.size,
      BigInt(manifestBuffer.length)
    );
    if (totalUncompressedSize > maxTransferBytes) {
      throw new ApiError(413, "DATA_BACKUP_TOO_LARGE", "The backup exceeds the configured data-transfer limit");
    }
    const archiveSize = calculateZipArchiveSize([
      { name: manifestName, size: BigInt(manifestBuffer.length) },
      ...attachmentFiles.map((item) => ({ name: item.path, size: item.inspection.size }))
    ]);
    return { account: snapshot.account, manifest, manifestBuffer, attachmentFiles, archiveSize, operationRoot };
  } catch (error) {
    await rm(operationRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeUserDataBackup(
  plan: Awaited<ReturnType<typeof prepareUserDataBackup>>,
  output: Writable
) {
  const { account, manifest, manifestBuffer, attachmentFiles } = plan;
  try {
    const writer = new ZipWriter(output);
    await writer.add({
      name: manifestName,
      size: BigInt(manifestBuffer.length),
      crc32: crc32(manifestBuffer),
      source: { kind: "buffer", data: manifestBuffer }
    });
    for (const item of attachmentFiles) {
      await writer.add({
        name: item.path,
        size: item.inspection.size,
        crc32: item.inspection.crc32,
        sha256: item.inspection.sha256,
        source: { kind: "file", path: item.filePath }
      });
    }
    await writer.finalize();
    return {
      username: account.username,
      pages: manifest.data.pages.length,
      blocks: manifest.data.blocks.length,
      attachments: manifest.attachments.length
    };
  } finally {
    await rm(plan.operationRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function batch<T>(items: T[], size = 500) {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

async function assertNoForeignIdConflicts(userId: string, manifest: BrainVaultBackup) {
  for (const ids of batch(manifest.data.pages.map((item) => item.id))) {
    if (!ids.length) continue;
    const rows = await db.query<{ id: string; owner_id: string }>(
      `SELECT id, owner_id FROM pages WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids
    );
    const conflict = rows.find((row) => row.owner_id !== userId);
    if (conflict) throw new ApiError(409, "BACKUP_ID_CONFLICT", "The backup contains an identifier owned by another account");
  }
  for (const ids of batch(manifest.data.blocks.map((item) => item.id))) {
    if (!ids.length) continue;
    const rows = await db.query<{ id: string; owner_id: string }>(
      `SELECT b.id, p.owner_id FROM blocks b INNER JOIN pages p ON p.id = b.page_id
       WHERE b.id IN (${ids.map(() => "?").join(",")})`,
      ids
    );
    const conflict = rows.find((row) => row.owner_id !== userId);
    if (conflict) throw new ApiError(409, "BACKUP_ID_CONFLICT", "The backup contains an identifier owned by another account");
  }
}

async function getExistingTags(client: DbClient, tags: BackupTag[]) {
  const byId = new Map<string, BackupTag>();
  const byName = new Map<string, BackupTag>();
  for (const group of batch(tags)) {
    if (!group.length) continue;
    const clauses = [
      `id IN (${group.map(() => "?").join(",")})`,
      `name IN (${group.map(() => "?").join(",")})`
    ];
    const rows = await client.query<BackupTag>(
      `SELECT id, name, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at FROM tags WHERE ${clauses.join(" OR ")}`,
      [...group.map((item) => item.id), ...group.map((item) => item.name)]
    );
    for (const row of rows) {
      byId.set(row.id, row);
      byName.set(row.name.toLowerCase(), row);
    }
  }
  return { byId, byName };
}

const restoreVersionGap = 1_000_000;

async function prepareRestoreSharingPlan(
  client: DbClient,
  userId: string,
  manifest: BrainVaultBackup,
  currentShares: WorkspaceRestoreShareRow[]
): Promise<RestoreSharingPlan> {
  const pageById = new Map(manifest.data.pages.map((page) => [page.id, page]));
  const backupShares = manifest.data.pageShares;

  if (!backupShares) {
    // Legacy backup manifests did not contain page_shares. Preserve the current
    // grants for ordinary page IDs that survive the restore, including retained
    // grants on archived pages, instead of silently deleting them through the
    // pages -> page_shares ON DELETE CASCADE relationship.
    const shares = currentShares
      .filter((share) => {
        const page = pageById.get(share.page_id);
        return isRestorablePageShareTarget(page);
      })
      .map((share) => ({
        pageId: share.page_id,
        userId: share.user_id,
        permission: share.permission,
        createdAt: share.shared_at
      }));

    for (const group of batch([...new Set(shares.map((share) => share.userId))])) {
      if (!group.length) continue;
      const rows = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE id IN (${group.map(() => "?").join(",")}) FOR UPDATE`,
        group
      );
      const found = new Set(rows.map((row) => row.id));
      const missing = group.find((id) => !found.has(id));
      if (missing) invalidBackup(`A preserved shared account no longer exists: ${missing}`);
    }
    return { mode: "legacy-preserved", shares };
  }

  const identityMode = getBackupPageShareIdentityMode(backupShares);
  if (identityMode === "mixed") {
    invalidBackup("The backup mixes ID-bound and legacy username-only sharing grants");
  }

  if (identityMode === "legacy" && backupShares.length) {
    const currentUserIds = [...new Set(currentShares.map((share) => share.user_id))];
    const currentUsersById = new Map<string, { id: string; username: string }>();
    for (const group of batch(currentUserIds)) {
      if (!group.length) continue;
      const rows = await client.query<{ id: string; username: string }>(
        `SELECT id, username FROM users WHERE id IN (${group.map(() => "?").join(",")}) FOR UPDATE`,
        group
      );
      for (const row of rows) currentUsersById.set(row.id, row);
    }

    const currentGrantByPageAndUsername = new Map<string, {
      share: WorkspaceRestoreShareRow;
      user: { id: string; username: string };
    }>();
    for (const currentShare of currentShares) {
      const page = pageById.get(currentShare.page_id);
      if (!isRestorablePageShareTarget(page)) continue;
      const currentUser = currentUsersById.get(currentShare.user_id);
      if (!currentUser) {
        invalidBackup(`A current shared account no longer exists: ${currentShare.user_id}`);
      }
      currentGrantByPageAndUsername.set(
        `${currentShare.page_id}\u0000${currentUser.username.toLowerCase()}`,
        { share: currentShare, user: currentUser }
      );
    }

    const shares = backupShares.map((backupShare) => {
      const currentGrant = currentGrantByPageAndUsername.get(
        `${backupShare.page_id}\u0000${backupShare.shared_username.toLowerCase()}`
      );
      if (!currentGrant || !isLegacyBackupPageShareCurrentMatch(
        backupShare,
        currentGrant.share,
        currentGrant.user
      )) {
        invalidBackup(
          `Legacy sharing grant cannot be verified against a current exact account grant: ${backupShare.shared_username}`
        );
      }
      if (currentGrant.user.id === userId) {
        invalidBackup(`The page owner cannot be restored as its own collaborator: ${backupShare.shared_username}`);
      }
      return {
        pageId: backupShare.page_id,
        userId: currentGrant.user.id,
        permission: backupShare.permission,
        createdAt: currentGrant.share.shared_at
      };
    });

    return { mode: "legacy-preserved", shares };
  }

  const userIds = [...new Set(backupShares.map((share) => share.shared_user_id!))];
  const usersById = new Map<string, { id: string; username: string }>();
  for (const group of batch(userIds)) {
    if (!group.length) continue;
    const rows = await client.query<{ id: string; username: string }>(
      `SELECT id, username FROM users WHERE id IN (${group.map(() => "?").join(",")}) FOR UPDATE`,
      group
    );
    for (const row of rows) usersById.set(row.id, row);
  }

  const shares = backupShares.map((share) => {
    const sharedUser = usersById.get(share.shared_user_id!);
    if (!sharedUser || !isExactBackupPageShareIdentityMatch(share, sharedUser)) {
      invalidBackup(
        `Shared account identity does not match this server: ${share.shared_username}`
      );
    }
    if (sharedUser.id === userId) {
      invalidBackup(`The page owner cannot be restored as its own collaborator: ${share.shared_username}`);
    }
    return {
      pageId: share.page_id,
      userId: sharedUser.id,
      permission: share.permission,
      createdAt: share.created_at
    };
  });

  return { mode: "backup", shares };
}

function getManifestMaxEditVersion(manifest: BrainVaultBackup) {
  let maximum = 0;
  for (const page of manifest.data.pages) {
    maximum = Math.max(maximum, Number(page.edit_version ?? 1), Number(page.content_version ?? 1));
  }
  for (const block of manifest.data.blocks) maximum = Math.max(maximum, Number(block.edit_version ?? 1));
  return maximum;
}

async function createRestoreEditVersion(client: DbClient, userId: string, manifest: BrainVaultBackup) {
  const current = await client.queryOne<{ max_edit_version: number | null }>(
    `SELECT GREATEST(
       COALESCE((SELECT MAX(edit_version) FROM pages WHERE owner_id = ?), 0),
       COALESCE((SELECT MAX(content_version) FROM pages WHERE owner_id = ?), 0),
       COALESCE((
         SELECT MAX(b.edit_version)
         FROM blocks b INNER JOIN pages p ON p.id = b.page_id
         WHERE p.owner_id = ?
       ), 0)
     ) AS max_edit_version`,
    [userId, userId, userId]
  );
  const currentMaximum = Number(current?.max_edit_version ?? 0);
  const manifestMaximum = getManifestMaxEditVersion(manifest);
  const clockFloor = Date.now() * 1000;
  const restoreVersion = Math.max(
    clockFloor,
    currentMaximum + restoreVersionGap,
    manifestMaximum + restoreVersionGap
  );
  if (!Number.isSafeInteger(restoreVersion) || restoreVersion < 1) {
    throw new ApiError(
      500,
      "DATA_RESTORE_VERSION_EXHAUSTED",
      "The workspace edit version cannot be advanced safely"
    );
  }
  return restoreVersion;
}

async function importRows(
  client: DbClient,
  userId: string,
  manifest: BrainVaultBackup,
  restoreVersion: number,
  pageShares: RestoredPageShare[]
) {
  await client.execute("DELETE FROM pages WHERE owner_id = ?", [userId]);
  await client.execute(
    `UPDATE users SET name = ?, avatar_data = ?, preferred_language = ?, default_collection_icon = ? WHERE id = ?`,
    [
      manifest.account.name,
      normalizeAvatarDataUrl(manifest.account.avatar_data),
      manifest.account.preferred_language,
      normalizeIconValue(manifest.account.default_collection_icon),
      userId
    ]
  );

  const orderedPages = orderByParent(manifest.data.pages, (item) => item.id, (item) => item.parent_page_id);
  for (const page of orderedPages) {
    await client.execute(
      `INSERT INTO pages
       (id, title, icon, cover_url, is_archived, is_collection, owner_id, parent_page_id, edit_version, content_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        page.id, page.title, normalizeIconValue(page.icon), page.cover_url, page.is_archived, page.is_collection, userId,
        page.parent_page_id, restoreVersion, restoreVersion, page.created_at, page.updated_at
      ]
    );
  }

  const orderedBlocks = orderByParent(manifest.data.blocks, (item) => item.id, (item) => item.parent_block_id);
  for (const block of orderedBlocks) {
    await client.execute(
      `INSERT INTO blocks
       (id, page_id, parent_block_id, type, markdown, html_cache, checked, sort_order, metadata, edit_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        block.id, block.page_id, block.parent_block_id, block.type, block.markdown,
        renderBlockHtml(block.type, block.markdown, Boolean(block.checked), block.metadata),
        block.checked, block.sort_order, block.metadata, restoreVersion, block.created_at, block.updated_at
      ]
    );
  }

  const existingTags = await getExistingTags(client, manifest.data.tags);
  const tagIdMap = new Map<string, string>();
  for (const tag of manifest.data.tags) {
    const sameName = existingTags.byName.get(tag.name.toLowerCase());
    if (sameName) {
      tagIdMap.set(tag.id, sameName.id);
      continue;
    }

    let targetId = tag.id;
    if (existingTags.byId.has(targetId)) {
      do targetId = createId("tag"); while (existingTags.byId.has(targetId));
    }
    await client.execute("INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)", [targetId, tag.name, tag.created_at]);
    const inserted = { ...tag, id: targetId };
    existingTags.byId.set(targetId, inserted);
    existingTags.byName.set(tag.name.toLowerCase(), inserted);
    tagIdMap.set(tag.id, targetId);
  }

  for (const relation of manifest.data.pageTags) {
    const targetTagId = tagIdMap.get(relation.tag_id);
    if (!targetTagId) invalidBackup(`Tag mapping is missing: ${relation.tag_id}`);
    await client.execute("INSERT INTO page_tags (page_id, tag_id) VALUES (?, ?)", [relation.page_id, targetTagId]);
  }

  for (const share of pageShares) {
    await client.execute(
      `INSERT INTO page_shares (page_id, user_id, permission, shared_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [share.pageId, share.userId, share.permission, userId, share.createdAt]
    );
  }
}

function getRestorePaths(journal: RestoreJournal) {
  const safeUserId = journal.userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    journalPath: path.join(dataTransferTempDir, `${restoreJournalPrefix}${journal.operationId}.json`),
    operationRoot: path.join(dataTransferTempDir, journal.operationId),
    stagedAttachmentDir: path.join(dataTransferTempDir, journal.operationId, "attachments"),
    oldAttachmentDir: path.join(attachmentUploadRoot, `.restore-previous-${safeUserId}-${journal.operationId}`),
    targetAttachmentDir: path.join(attachmentUploadRoot, safeUserId)
  };
}

async function writeRestoreJournal(journal: RestoreJournal) {
  await ensureDataTransferDirectories();
  const { journalPath } = getRestorePaths(journal);
  const temporaryPath = `${journalPath}.tmp-${createId("journal")}`;
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, journalPath);
    await syncPath(dataTransferTempDir);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return journalPath;
}

async function pathExists(value: string) {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

type RestoreGenerationMarkerState =
  | { status: "missing" }
  | { status: "match" }
  | { status: "other"; operationId: string }
  | { status: "invalid" };

function restoreGenerationMarkerPath(directory: string) {
  return path.join(directory, dataRestoreGenerationMarkerName);
}

async function writeRestoreGenerationMarker(directory: string, operationId: string) {
  const markerPath = restoreGenerationMarkerPath(directory);
  const handle = await open(markerPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, operationId })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncPath(directory);
}

async function readRestoreGenerationMarker(
  directory: string,
  expectedOperationId: string
): Promise<RestoreGenerationMarkerState> {
  let raw: string;
  try {
    raw = await readFile(restoreGenerationMarkerPath(directory), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw error;
  }

  try {
    const marker = restoreGenerationMarkerSchema.parse(JSON.parse(raw));
    return marker.operationId === expectedOperationId
      ? { status: "match" }
      : { status: "other", operationId: marker.operationId };
  } catch {
    return { status: "invalid" };
  }
}

function describeRestoreGeneration(state: RestoreGenerationMarkerState) {
  if (state.status === "other") return `restore ${state.operationId}`;
  if (state.status === "invalid") return "an invalid restore marker";
  if (state.status === "missing") return "an unmarked attachment generation";
  return "the current restore generation";
}

async function listTrackedRestoreEntries(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === dataRestoreGenerationMarkerName) continue;
    if (!entry.isFile()) {
      throw new Error(
        `Restore recovery found an unsupported attachment entry: ${path.join(directory, entry.name)}`
      );
    }
  }
  return entries;
}

async function preserveAttachmentEntry(source: string, destination: string) {
  await mkdir(path.dirname(destination), { recursive: true });
  let linked = false;
  let sourceRemoved = false;
  try {
    // Claim the destination without replacing a pre-restore file. A hard link
    // also makes this merge restart-safe if recovery is interrupted midway.
    await link(source, destination);
    linked = true;
    await syncPath(destination);
    await syncPath(path.dirname(destination));
    await rm(source);
    sourceRemoved = true;
    await syncPath(path.dirname(source));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const [sourceStats, destinationStats] = await Promise.all([stat(source), stat(destination)]);
      if (sourceStats.dev === destinationStats.dev && sourceStats.ino === destinationStats.ino) {
        // A prior recovery attempt created the hard link and crashed before
        // removing the source name. Finish that interrupted move idempotently.
        await rm(source);
        await syncPath(path.dirname(source));
        return;
      }
      throw new Error(
        `Restore recovery found conflicting attachment files at ${source} and ${destination}; preserving both generations for manual recovery`
      );
    }
    // Once the source name is gone, destination is the only remaining link and
    // must never be removed even if a later directory fsync reports an error.
    if (linked && !sourceRemoved) {
      await rm(destination, { force: true }).catch(() => undefined);
      await syncPath(path.dirname(destination)).catch(() => undefined);
    }
    throw error;
  }
}

async function recoverLegacyRestoreAttachments(
  journal: RestoreJournal,
  paths: ReturnType<typeof getRestorePaths>,
  committed: boolean
) {
  if (committed) {
    if (!(await pathExists(paths.targetAttachmentDir)) && await pathExists(paths.stagedAttachmentDir)) {
      await mkdir(path.dirname(paths.targetAttachmentDir), { recursive: true });
      await rename(paths.stagedAttachmentDir, paths.targetAttachmentDir);
      await syncPath(path.dirname(paths.targetAttachmentDir));
      await syncDirectoryIfPresent(paths.operationRoot);
    }
    if (!(await pathExists(paths.targetAttachmentDir))) {
      throw new Error(`Committed restore ${journal.operationId} is missing its attachment directory`);
    }
    await rm(paths.oldAttachmentDir, { recursive: true, force: true });
    await syncPath(path.dirname(paths.oldAttachmentDir));
  } else if (journal.hadPreviousAttachments) {
    if (await pathExists(paths.oldAttachmentDir)) {
      await rm(paths.targetAttachmentDir, { recursive: true, force: true });
      await rename(paths.oldAttachmentDir, paths.targetAttachmentDir);
      await syncPath(path.dirname(paths.targetAttachmentDir));
    }
  } else if (!(await pathExists(paths.stagedAttachmentDir))) {
    // Version 1 journals predate attachment-generation markers. Keep their
    // original recovery behavior for backwards compatibility.
    await rm(paths.targetAttachmentDir, { recursive: true, force: true });
    await syncPath(path.dirname(paths.targetAttachmentDir));
  }
}

async function recoverVersionedRestoreAttachments(
  journal: RestoreJournalV2,
  paths: ReturnType<typeof getRestorePaths>,
  committed: boolean
) {
  let targetExists = await pathExists(paths.targetAttachmentDir);
  const stagedExists = await pathExists(paths.stagedAttachmentDir);

  if (committed) {
    if (!targetExists && stagedExists) {
      const stagedGeneration = await readRestoreGenerationMarker(paths.stagedAttachmentDir, journal.operationId);
      if (stagedGeneration.status !== "match") {
        throw new Error(
          `Committed restore ${journal.operationId} cannot promote ${describeRestoreGeneration(stagedGeneration)}`
        );
      }
      await mkdir(path.dirname(paths.targetAttachmentDir), { recursive: true });
      await rename(paths.stagedAttachmentDir, paths.targetAttachmentDir);
      await syncPath(path.dirname(paths.targetAttachmentDir));
      await syncDirectoryIfPresent(paths.operationRoot);
      targetExists = true;
    }
    if (!targetExists) {
      throw new Error(`Committed restore ${journal.operationId} is missing its attachment directory`);
    }
    const targetGeneration = await readRestoreGenerationMarker(paths.targetAttachmentDir, journal.operationId);
    if (targetGeneration.status !== "match") {
      throw new Error(
        `Committed restore ${journal.operationId} found ${describeRestoreGeneration(targetGeneration)}; preserving all attachment generations for manual recovery`
      );
    }
    await rm(paths.oldAttachmentDir, { recursive: true, force: true });
    await syncPath(path.dirname(paths.oldAttachmentDir));
    return;
  }

  if (journal.hadPreviousAttachments) {
    if (await pathExists(paths.oldAttachmentDir)) {
      if (targetExists) {
        const targetGeneration = await readRestoreGenerationMarker(paths.targetAttachmentDir, journal.operationId);
        if (targetGeneration.status !== "match") {
          throw new Error(
            `Restore ${journal.operationId} found ${describeRestoreGeneration(targetGeneration)} after a failed rollback; preserving both attachment generations for manual recovery`
          );
        }
        await rm(paths.targetAttachmentDir, { recursive: true, force: true });
      }
      await rename(paths.oldAttachmentDir, paths.targetAttachmentDir);
      await syncPath(path.dirname(paths.targetAttachmentDir));
      return;
    }

    if (!targetExists) {
      throw new Error(
        `Restore ${journal.operationId} is missing both the previous and current attachment directories`
      );
    }
    const targetGeneration = await readRestoreGenerationMarker(paths.targetAttachmentDir, journal.operationId);
    if (targetGeneration.status === "match") {
      throw new Error(
        `Restore ${journal.operationId} cannot roll back because its previous attachment directory is missing`
      );
    }
    // The previous directory has already been restored, or a later attachment
    // generation replaced it after an earlier recovery attempt. Never delete it.
    return;
  }

  if (!targetExists) return;
  const targetGeneration = await readRestoreGenerationMarker(paths.targetAttachmentDir, journal.operationId);
  if (targetGeneration.status === "match") {
    await rm(paths.targetAttachmentDir, { recursive: true, force: true });
    await syncPath(path.dirname(paths.targetAttachmentDir));
    return;
  }
  if (targetGeneration.status === "missing") {
    // This is a later attachment generation created after a partial recovery.
    // It is not owned by this restore and must be preserved.
    return;
  }
  throw new Error(
    `Restore ${journal.operationId} found ${describeRestoreGeneration(targetGeneration)}; preserving it for manual recovery`
  );
}

async function recoverTrackedRestoreAttachments(
  journal: RestoreJournalV3,
  paths: ReturnType<typeof getRestorePaths>,
  committed: boolean
) {
  let targetExists = await pathExists(paths.targetAttachmentDir);
  const stagedExists = await pathExists(paths.stagedAttachmentDir);

  if (committed) {
    if (!targetExists && stagedExists) {
      const stagedGeneration = await readRestoreGenerationMarker(paths.stagedAttachmentDir, journal.operationId);
      if (stagedGeneration.status !== "match") {
        throw new Error(
          `Committed restore ${journal.operationId} cannot promote ${describeRestoreGeneration(stagedGeneration)}`
        );
      }
      await mkdir(path.dirname(paths.targetAttachmentDir), { recursive: true });
      await rename(paths.stagedAttachmentDir, paths.targetAttachmentDir);
      await syncPath(path.dirname(paths.targetAttachmentDir));
      await syncDirectoryIfPresent(paths.operationRoot);
      targetExists = true;
    }
    if (!targetExists) {
      throw new Error(`Committed restore ${journal.operationId} is missing its attachment directory`);
    }
    const targetGeneration = await readRestoreGenerationMarker(paths.targetAttachmentDir, journal.operationId);
    if (targetGeneration.status !== "match") {
      throw new Error(
        `Committed restore ${journal.operationId} found ${describeRestoreGeneration(targetGeneration)}; preserving all attachment generations for manual recovery`
      );
    }
    await rm(paths.oldAttachmentDir, { recursive: true, force: true });
    await syncPath(path.dirname(paths.oldAttachmentDir));
    return;
  }

  const restoredAttachmentIds = new Set(journal.restoredAttachmentIds);

  if (journal.hadPreviousAttachments) {
    if (await pathExists(paths.oldAttachmentDir)) {
      if (targetExists) {
        const targetGeneration = await readRestoreGenerationMarker(paths.targetAttachmentDir, journal.operationId);
        if (targetGeneration.status !== "match") {
          throw new Error(
            `Restore ${journal.operationId} found ${describeRestoreGeneration(targetGeneration)} after a failed rollback; preserving both attachment generations for manual recovery`
          );
        }

        // A new upload can commit after the failed restore transaction releases
        // its row lock but before recovery reacquires it. Preserve every file not
        // owned by this restore before discarding the failed restore generation.
        const entries = await listTrackedRestoreEntries(paths.targetAttachmentDir);
        for (const entry of entries) {
          if (entry.name === dataRestoreGenerationMarkerName || restoredAttachmentIds.has(entry.name)) continue;
          await preserveAttachmentEntry(
            path.join(paths.targetAttachmentDir, entry.name),
            path.join(paths.oldAttachmentDir, entry.name)
          );
        }
        await rm(paths.targetAttachmentDir, { recursive: true, force: true });
      }
      await rename(paths.oldAttachmentDir, paths.targetAttachmentDir);
      await syncPath(path.dirname(paths.targetAttachmentDir));
      return;
    }

    if (!targetExists) {
      throw new Error(
        `Restore ${journal.operationId} is missing both the previous and current attachment directories`
      );
    }
    const targetGeneration = await readRestoreGenerationMarker(paths.targetAttachmentDir, journal.operationId);
    if (targetGeneration.status === "match") {
      throw new Error(
        `Restore ${journal.operationId} cannot roll back because its previous attachment directory is missing`
      );
    }
    return;
  }

  if (!targetExists) return;
  const targetGeneration = await readRestoreGenerationMarker(paths.targetAttachmentDir, journal.operationId);
  if (targetGeneration.status === "match") {
    const entries = await listTrackedRestoreEntries(paths.targetAttachmentDir);
    for (const entry of entries) {
      if (restoredAttachmentIds.has(entry.name)) {
        await rm(path.join(paths.targetAttachmentDir, entry.name), { force: true });
      }
    }
    // Remove the ownership marker last. If recovery crashes earlier, a retry can
    // still identify and finish cleaning this failed restore generation.
    await rm(restoreGenerationMarkerPath(paths.targetAttachmentDir), { force: true });
    await syncPath(paths.targetAttachmentDir);
    if ((await readdir(paths.targetAttachmentDir)).length === 0) {
      await rm(paths.targetAttachmentDir, { recursive: true, force: true });
      await syncPath(path.dirname(paths.targetAttachmentDir));
    }
    return;
  }
  if (targetGeneration.status === "missing") {
    return;
  }
  throw new Error(
    `Restore ${journal.operationId} found ${describeRestoreGeneration(targetGeneration)}; preserving it for manual recovery`
  );
}

export async function recoverDataRestoreJournal(journalInput: unknown) {
  return recoverRestoreJournal(restoreJournalSchema.parse(journalInput));
}

async function recoverRestoreJournal(journal: RestoreJournal) {
  const paths = getRestorePaths(journal);
  let committed = false;
  await withUserAttachmentLock(journal.userId, async (client) => {
    const marker = await client.queryOne<{ operation_id: string }>(
      "SELECT operation_id FROM data_restore_markers WHERE user_id = ? AND operation_id = ?",
      [journal.userId, journal.operationId]
    );
    committed = marker?.operation_id === journal.operationId;

    if (journal.version === 1) {
      await recoverLegacyRestoreAttachments(journal, paths, committed);
    } else if (journal.version === 2) {
      await recoverVersionedRestoreAttachments(journal, paths, committed);
    } else {
      await recoverTrackedRestoreAttachments(journal, paths, committed);
    }

    await rm(paths.operationRoot, { recursive: true, force: true });
    await rm(paths.journalPath, { force: true });
    await syncPath(dataTransferTempDir);

    if (committed && journal.version !== 1) {
      // The journal is durably gone before this best-effort marker cleanup. If
      // cleanup is interrupted, a harmless hidden marker may remain, but no
      // future recovery can mistake a later attachment generation for this one.
      try {
        await rm(restoreGenerationMarkerPath(paths.targetAttachmentDir), { force: true });
        await syncDirectoryIfPresent(paths.targetAttachmentDir);
      } catch (error) {
        console.error("Committed restore generation marker cleanup failed", {
          userId: journal.userId,
          operationId: journal.operationId,
          error
        });
      }
    }
  });
  try {
    await db.execute(
      "DELETE FROM data_restore_markers WHERE user_id = ? AND operation_id = ?",
      [journal.userId, journal.operationId]
    );
  } catch (error) {
    console.error("Committed data restore marker cleanup failed", {
      userId: journal.userId,
      operationId: journal.operationId,
      error
    });
  }
}

export async function recoverInterruptedDataRestores() {
  await ensureDataTransferDirectories();
  const entries = await readdir(dataTransferTempDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(restoreJournalPrefix) || !entry.name.endsWith(".json")) continue;
    const journalPath = path.join(dataTransferTempDir, entry.name);
    try {
      const journal = restoreJournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")));
      if (getRestorePaths(journal).journalPath !== journalPath) {
        throw new Error("Restore journal filename does not match its operation ID");
      }
      await recoverRestoreJournal(journal);
      console.log(`Recovered interrupted data restore: ${journal.operationId}`);
    } catch (error) {
      console.error("Interrupted data restore requires manual recovery", { journalPath, error });
      throw error;
    }
  }
}

export async function importUserDataBackup(userId: string, zipPath: string) {
  let entries;
  try {
    entries = await readZipDirectory(zipPath, {
      maxCentralDirectoryBytes: dataTransferResourceLimits.maxCentralDirectoryBytes,
      maxEntries: dataTransferResourceLimits.maxZipEntries
    });
  } catch (error) {
    invalidBackup(error instanceof Error ? error.message : "The ZIP archive is invalid");
  }

  const entryByName = new Map<string, (typeof entries)[number]>();
  let totalSize = 0n;
  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith("/") || entry.name.includes("\\") || entry.name.split("/").includes("..")) {
      invalidBackup(`ZIP entry path is unsafe: ${entry.name}`);
    }
    if (entryByName.has(entry.name)) invalidBackup(`ZIP entry is duplicated: ${entry.name}`);
    entryByName.set(entry.name, entry);
    totalSize += entry.uncompressedSize;
  }
  const maxBytes = BigInt(env.DATA_TRANSFER_MAX_SIZE_MB) * 1024n * 1024n;
  if (totalSize > maxBytes) throw new ApiError(413, "DATA_BACKUP_TOO_LARGE", "The backup exceeds the configured data-transfer limit");

  const manifestEntry = entryByName.get(manifestName);
  if (!manifestEntry) invalidBackup(`${manifestName} is missing`);
  if (manifestEntry.uncompressedSize > BigInt(maxManifestBytes)) {
    throw new ApiError(413, "DATA_BACKUP_TOO_LARGE", "The backup manifest exceeds the configured manifest limit");
  }
  let manifest: BrainVaultBackup;
  try {
    const buffer = await readZipEntryBuffer(zipPath, manifestEntry, maxManifestBytes);
    manifest = manifestSchema.parse(JSON.parse(buffer.toString("utf8")));
  } catch (error) {
    invalidBackup("The backup manifest is invalid", error instanceof z.ZodError ? error.flatten() : undefined);
  }
  validateManifestRelations(manifest);

  const allowedEntries = new Set([manifestName, ...manifest.attachments.map((item) => item.path)]);
  for (const entry of entries) {
    if (!allowedEntries.has(entry.name)) invalidBackup(`Unexpected ZIP entry: ${entry.name}`);
  }
  if (entries.length !== allowedEntries.size) invalidBackup("The ZIP archive is missing one or more declared entries");

  await assertNoForeignIdConflicts(userId, manifest);
  const initialWorkspaceSnapshot = await transaction((client) =>
    createWorkspaceRestoreSnapshot(userId, client)
  );
  await ensureDataTransferDirectories();
  const operationId = createId("restore");
  const journalBase = {
    version: 3 as const,
    userId,
    operationId,
    restoredAttachmentIds: manifest.attachments.map((attachment) => attachment.blockId)
  };
  const derivedPaths = getRestorePaths({ ...journalBase, hadPreviousAttachments: false });
  const { operationRoot, stagedAttachmentDir, oldAttachmentDir, targetAttachmentDir, journalPath } = derivedPaths;
  let journalWritten = false;
  let restoreJournal: RestoreJournal | null = null;
  let restoreSharingPlan: RestoreSharingPlan = { mode: "backup", shares: [] };
  await mkdir(stagedAttachmentDir, { recursive: true });

  try {
    for (const attachment of manifest.attachments) {
      const entry = entryByName.get(attachment.path);
      if (!entry) invalidBackup(`Attachment entry is missing: ${attachment.path}`);
      if (entry.uncompressedSize.toString() !== attachment.size || entry.crc32 !== attachment.crc32) {
        invalidBackup(`Attachment size or CRC does not match: ${attachment.blockId}`);
      }
      const outputPath = path.join(stagedAttachmentDir, attachment.blockId);
      try {
        await copyZipEntryToFile(zipPath, entry, outputPath);
        await syncPath(outputPath);
      } catch (error) {
        invalidBackup(error instanceof Error ? error.message : `Attachment is corrupt: ${attachment.blockId}`);
      }
      const inspection = await inspectFile(outputPath);
      if (inspection.sha256 !== attachment.sha256 || inspection.size.toString() !== attachment.size) {
        invalidBackup(`Attachment SHA-256 does not match: ${attachment.blockId}`);
      }
    }
    await writeRestoreGenerationMarker(stagedAttachmentDir, operationId);
    await syncPath(operationRoot);

    let movedOld = false;
    try {
      await transaction(async (client) => {
        const lockedWorkspaceSnapshot = await createWorkspaceRestoreSnapshot(userId, client, true);
        if (lockedWorkspaceSnapshot.fingerprint !== initialWorkspaceSnapshot.fingerprint) {
          throw new ApiError(
            409,
            "DATA_RESTORE_CONFLICT",
            "The workspace changed while the backup was being prepared. No data was replaced."
          );
        }
        restoreSharingPlan = await prepareRestoreSharingPlan(
          client,
          userId,
          manifest,
          lockedWorkspaceSnapshot.shares
        );
        // Invalidate every live in-memory Yjs room while the owned page rows are
        // still locked. Otherwise an old owner session can append its pre-restore
        // document after commit and later materialize it over the restored backup.
        for (const pageId of lockedWorkspaceSnapshot.pageIds) {
          disconnectPageCollaborators(pageId, "Workspace data is being restored");
        }
        // Record the live attachment generation only after the user row is locked.
        // Otherwise an attachment created between the check and the lock could be
        // mistaken for failed-restore output and deleted during conflict recovery.
        restoreJournal = {
          ...journalBase,
          hadPreviousAttachments: await pathExists(targetAttachmentDir)
        };
        await writeRestoreJournal(restoreJournal);
        journalWritten = true;
        const restoreVersion = await createRestoreEditVersion(client, userId, manifest);
        await importRows(client, userId, manifest, restoreVersion, restoreSharingPlan.shares);
        await mkdir(path.dirname(targetAttachmentDir), { recursive: true });
        if (await pathExists(targetAttachmentDir)) {
          await rename(targetAttachmentDir, oldAttachmentDir);
          movedOld = true;
        }
        await rename(stagedAttachmentDir, targetAttachmentDir);
        await syncPath(attachmentUploadRoot);
        await syncPath(operationRoot);
        await client.execute(
          `INSERT INTO data_restore_markers (user_id, operation_id, committed_at)
           VALUES (?, ?, CURRENT_TIMESTAMP(3))`,
          [userId, operationId]
        );
      });
    } catch (error) {
      if (!restoreJournal || !journalWritten) throw error;
      let marker: { operation_id: string } | undefined;
      try {
        marker = await db.queryOne<{ operation_id: string }>(
          "SELECT operation_id FROM data_restore_markers WHERE user_id = ? AND operation_id = ?",
          [userId, operationId]
        );
      } catch (verificationError) {
        console.error("Data restore commit outcome is unknown; preserving both attachment generations", {
          userId,
          operationId,
          targetAttachmentDir,
          preservedAttachmentDir: movedOld ? oldAttachmentDir : null,
          journalPath,
          verificationError
        });
        throw new ApiError(
          500,
          "DATA_RESTORE_OUTCOME_UNKNOWN",
          "The restore outcome could not be verified. Attachment generations were preserved for startup recovery."
        );
      }

      const committed = marker?.operation_id === operationId;
      await recoverRestoreJournal(restoreJournal).catch((recoveryError) => {
        console.error("Attachment restore reconciliation requires manual recovery", {
          userId,
          operationId,
          committed,
          targetAttachmentDir,
          preservedAttachmentDir: movedOld ? oldAttachmentDir : null,
          journalPath,
          recoveryError
        });
        throw new ApiError(
          500,
          "DATA_RESTORE_RECOVERY_FAILED",
          "The restore outcome was identified, but attachment reconciliation requires manual recovery."
        );
      });
      journalWritten = false;
      if (!committed) throw error;
      console.warn("Data restore commit succeeded despite a transaction response error", {
        userId,
        operationId,
        error
      });
    }

    if (journalWritten && restoreJournal) {
      await recoverRestoreJournal(restoreJournal);
      journalWritten = false;
    }
    const user = await db.queryOne<UserRow>("SELECT * FROM users WHERE id = ?", [userId]);
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found after import");
    return {
      user,
      counts: {
        pages: manifest.data.pages.length,
        blocks: manifest.data.blocks.length,
        attachments: manifest.attachments.length,
        tags: manifest.data.tags.length,
        shares: restoreSharingPlan.shares.length
      },
      sharing: {
        mode: restoreSharingPlan.mode,
        count: restoreSharingPlan.shares.length
      }
    };
  } finally {
    if (!journalWritten) {
      await rm(operationRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
