import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Writable } from "node:stream";
import { access, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { z } from "zod";
import { env } from "../config/env.js";
import { attachmentUploadRoot, getAttachmentFilePath } from "./attachments.js";
import { db, transaction, type DbClient } from "./db.js";
import { ApiError } from "./http.js";
import { createId } from "./id.js";
import { renderBlockHtml } from "./markdown.js";
import { copyZipEntryToFile, crc32, readZipDirectory, readZipEntryBuffer, updateCrc32, ZipWriter } from "./zip.js";
import type { BlockType, UserRow } from "../types/domain.js";

export const dataTransferTempDir = path.join(attachmentUploadRoot, ".data-transfer");
const manifestName = "brainvault-backup.json";
const backupFormat = "brainvault-backup";
const backupVersion = 1;
const maxManifestBytes = 128 * 1024 * 1024;
const idSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const timestampSchema = z.string().min(1).max(40);
const nullableString = (max: number) => z.string().max(max).nullable();

const pageSchema = z.object({
  id: idSchema,
  title: z.string().max(160),
  icon: nullableString(32),
  cover_url: nullableString(500),
  is_archived: z.union([z.literal(0), z.literal(1)]),
  is_collection: z.union([z.literal(0), z.literal(1)]),
  parent_page_id: idSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema
}).strict();

const blockTypes = [
  "MARKDOWN", "HEADING_1", "HEADING_2", "HEADING_3", "TODO", "QUOTE", "CALLOUT", "TABLE",
  "KANBAN", "DATABASE", "BOOKMARK", "AI_CHAT", "MATH", "CODE", "DIVIDER", "IMAGE", "ATTACHMENT"
] as const satisfies readonly BlockType[];

const blockSchema = z.object({
  id: idSchema,
  page_id: idSchema,
  parent_block_id: idSchema.nullable(),
  type: z.enum(blockTypes),
  markdown: z.string(),
  html_cache: z.string().nullable(),
  checked: z.union([z.literal(0), z.literal(1)]),
  sort_order: z.number().int(),
  metadata: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema
}).strict();

const tagSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(50),
  created_at: timestampSchema
}).strict();

const pageTagSchema = z.object({ page_id: idSchema, tag_id: idSchema }).strict();
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
    avatar_data: z.string().nullable(),
    preferred_language: nullableString(10),
    default_collection_icon: nullableString(32)
  }).strict(),
  data: z.object({
    pages: z.array(pageSchema).max(1_000_000),
    blocks: z.array(blockSchema).max(2_000_000),
    tags: z.array(tagSchema).max(1_000_000),
    pageTags: z.array(pageTagSchema).max(5_000_000)
  }).strict(),
  attachments: z.array(attachmentSchema).max(1_000_000)
}).strict();

export type BrainVaultBackup = z.infer<typeof manifestSchema>;
type BackupPage = BrainVaultBackup["data"]["pages"][number];
type BackupBlock = BrainVaultBackup["data"]["blocks"][number];
type BackupTag = BrainVaultBackup["data"]["tags"][number];

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

function invalidBackup(message: string, details?: unknown): never {
  throw new ApiError(400, "INVALID_DATA_BACKUP", message, details);
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
  assertUnique(pages.map((item) => item.id), "page ID");
  assertUnique(blocks.map((item) => item.id), "block ID");
  assertUnique(tags.map((item) => item.id), "tag ID");
  assertUnique(tags.map((item) => item.name.toLowerCase()), "tag name");
  assertUnique(manifest.attachments.map((item) => item.blockId), "attachment block ID");
  assertUnique(manifest.attachments.map((item) => item.path), "attachment path");

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
    if (block.metadata !== null) {
      try {
        JSON.parse(block.metadata);
      } catch {
        invalidBackup(`Block metadata is invalid JSON: ${block.id}`);
      }
    }
  }
  orderByParent(blocks, (item) => item.id, (item) => item.parent_block_id);

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
    if (!attachmentBlockIds.has(attachment.blockId)) invalidBackup(`Attachment block is missing: ${attachment.blockId}`);
    if (attachment.path !== `attachments/${attachment.blockId}`) invalidBackup(`Attachment path is invalid: ${attachment.path}`);
  }
}

export async function prepareUserDataBackup(userId: string) {
  await ensureDataTransferDirectories();
  const operationRoot = path.join(dataTransferTempDir, createId("export"));
  const stagedAttachmentDir = path.join(operationRoot, "attachments");
  await mkdir(stagedAttachmentDir, { recursive: true });

  try {
    const snapshot = await transaction(async (client) => {
      const account = await client.queryOne<RawAccountRow>(
        `SELECT id, username, name, avatar_data, preferred_language, default_collection_icon
         FROM users WHERE id = ?`,
        [userId]
      );
      if (!account) throw new ApiError(404, "NOT_FOUND", "User not found");

      const pages = await client.query<BackupPage>(
        `SELECT id, title, icon, cover_url, is_archived, is_collection, parent_page_id,
           DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at,
           DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at
         FROM pages WHERE owner_id = ? ORDER BY created_at ASC, id ASC`,
        [userId]
      );
      const blocks = await client.query<BackupBlock>(
        `SELECT b.id, b.page_id, b.parent_block_id, b.type, b.markdown, b.html_cache, b.checked, b.sort_order,
           CAST(b.metadata AS CHAR CHARACTER SET utf8mb4) AS metadata,
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
      return { account, pages, blocks, tags, pageTags };
    });

    const attachmentBlocks = snapshot.blocks.filter((block) => block.type === "ATTACHMENT");
    const attachmentFiles = [] as Array<{ blockId: string; path: string; filePath: string; inspection: FileInspection }>;
    for (const block of attachmentBlocks) {
      const sourcePath = getAttachmentFilePath(userId, block.id);
      const stagedPath = path.join(stagedAttachmentDir, block.id);
      try {
        const fileStat = await stat(sourcePath);
        if (!fileStat.isFile()) throw new Error("not a file");
        await copyFile(sourcePath, stagedPath);
      } catch {
        throw new ApiError(409, "BACKUP_ATTACHMENT_MISSING", `Attachment file is missing for block ${block.id}`);
      }
      attachmentFiles.push({
        blockId: block.id,
        path: `attachments/${block.id}`,
        filePath: stagedPath,
        inspection: await inspectFile(stagedPath)
      });
    }

    const manifest: BrainVaultBackup = {
      format: backupFormat,
      version: backupVersion,
      exportedAt: new Date().toISOString(),
      source: { userId: snapshot.account.id, username: snapshot.account.username },
      account: {
        name: snapshot.account.name,
        avatar_data: snapshot.account.avatar_data,
        preferred_language: snapshot.account.preferred_language,
        default_collection_icon: snapshot.account.default_collection_icon
      },
      data: {
        pages: snapshot.pages,
        blocks: snapshot.blocks,
        tags: snapshot.tags,
        pageTags: snapshot.pageTags
      },
      attachments: attachmentFiles.map((item) => ({
        blockId: item.blockId,
        path: item.path,
        size: item.inspection.size.toString(),
        sha256: item.inspection.sha256,
        crc32: item.inspection.crc32
      }))
    };
    return { account: snapshot.account, manifest, attachmentFiles, operationRoot };
  } catch (error) {
    await rm(operationRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeUserDataBackup(
  plan: Awaited<ReturnType<typeof prepareUserDataBackup>>,
  output: Writable
) {
  const { account, manifest, attachmentFiles } = plan;
  try {
    const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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
    if (conflict) throw new ApiError(409, "BACKUP_ID_CONFLICT", `Page ID belongs to another account: ${conflict.id}`);
  }
  for (const ids of batch(manifest.data.blocks.map((item) => item.id))) {
    if (!ids.length) continue;
    const rows = await db.query<{ id: string; owner_id: string }>(
      `SELECT b.id, p.owner_id FROM blocks b INNER JOIN pages p ON p.id = b.page_id
       WHERE b.id IN (${ids.map(() => "?").join(",")})`,
      ids
    );
    const conflict = rows.find((row) => row.owner_id !== userId);
    if (conflict) throw new ApiError(409, "BACKUP_ID_CONFLICT", `Block ID belongs to another account: ${conflict.id}`);
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

async function importRows(client: DbClient, userId: string, manifest: BrainVaultBackup) {
  await client.execute("DELETE FROM pages WHERE owner_id = ?", [userId]);
  await client.execute(
    `UPDATE users SET name = ?, avatar_data = ?, preferred_language = ?, default_collection_icon = ? WHERE id = ?`,
    [
      manifest.account.name,
      manifest.account.avatar_data,
      manifest.account.preferred_language,
      manifest.account.default_collection_icon,
      userId
    ]
  );

  const orderedPages = orderByParent(manifest.data.pages, (item) => item.id, (item) => item.parent_page_id);
  for (const page of orderedPages) {
    await client.execute(
      `INSERT INTO pages
       (id, title, icon, cover_url, is_archived, is_collection, owner_id, parent_page_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        page.id, page.title, page.icon, page.cover_url, page.is_archived, page.is_collection, userId,
        page.parent_page_id, page.created_at, page.updated_at
      ]
    );
  }

  const orderedBlocks = orderByParent(manifest.data.blocks, (item) => item.id, (item) => item.parent_block_id);
  for (const block of orderedBlocks) {
    await client.execute(
      `INSERT INTO blocks
       (id, page_id, parent_block_id, type, markdown, html_cache, checked, sort_order, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        block.id, block.page_id, block.parent_block_id, block.type, block.markdown,
        renderBlockHtml(block.type, block.markdown, Boolean(block.checked), block.metadata),
        block.checked, block.sort_order, block.metadata, block.created_at, block.updated_at
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
}

async function pathExists(value: string) {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

export async function importUserDataBackup(userId: string, zipPath: string) {
  let entries;
  try {
    entries = await readZipDirectory(zipPath);
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
  await ensureDataTransferDirectories();
  const operationRoot = path.join(dataTransferTempDir, createId("restore"));
  const stagedAttachmentDir = path.join(operationRoot, "attachments");
  const oldAttachmentDir = path.join(operationRoot, "previous-attachments");
  const targetAttachmentDir = path.join(attachmentUploadRoot, userId.replace(/[^a-zA-Z0-9_-]/g, "_"));
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
      } catch (error) {
        invalidBackup(error instanceof Error ? error.message : `Attachment is corrupt: ${attachment.blockId}`);
      }
      const inspection = await inspectFile(outputPath);
      if (inspection.sha256 !== attachment.sha256 || inspection.size.toString() !== attachment.size) {
        invalidBackup(`Attachment SHA-256 does not match: ${attachment.blockId}`);
      }
    }

    let movedOld = false;
    let installedNew = false;
    try {
      await transaction(async (client) => {
        await importRows(client, userId, manifest);
        await mkdir(path.dirname(targetAttachmentDir), { recursive: true });
        if (await pathExists(targetAttachmentDir)) {
          await rename(targetAttachmentDir, oldAttachmentDir);
          movedOld = true;
        }
        await rename(stagedAttachmentDir, targetAttachmentDir);
        installedNew = true;
      });
    } catch (error) {
      if (installedNew) await rm(targetAttachmentDir, { recursive: true, force: true }).catch(() => undefined);
      if (movedOld) await rename(oldAttachmentDir, targetAttachmentDir).catch(() => undefined);
      throw error;
    }

    await rm(oldAttachmentDir, { recursive: true, force: true });
    const user = await db.queryOne<UserRow>("SELECT * FROM users WHERE id = ?", [userId]);
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found after import");
    return {
      user,
      counts: {
        pages: manifest.data.pages.length,
        blocks: manifest.data.blocks.length,
        attachments: manifest.attachments.length,
        tags: manifest.data.tags.length
      }
    };
  } finally {
    await rm(operationRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
