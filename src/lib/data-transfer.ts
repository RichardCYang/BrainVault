import path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import type { Writable } from "node:stream";
import { access, copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  assertAttachmentStorageLimit,
  attachmentUploadRoot,
  getAttachmentFilePath,
  inspectStoredAttachmentContent,
  withUserAttachmentLock
} from "./attachments.js";
import {
  assertLosslessAttachmentMetadata,
  AttachmentMetadataIntegrityError
} from "./attachment-metadata-integrity.js";
import { disconnectPageCollaborators } from "./collaboration-server.js";
import { needsCollaborationMaterialization } from "./collaboration-protocol.js";
import {
  assertCustomIconStorageLimit,
  customIconPublicPrefix,
  customIconUploadRoot,
  detectCustomIconFileType,
  getCustomIconFilePath,
  isServerCustomIconPath
} from "./custom-icons.js";
import { db, transaction, type DbClient } from "./db.js";
import { ApiError } from "./http.js";
import { iconValueSchema, imageIconPrefix, maxCustomIconBytes, normalizeIconValue } from "./icon-value.js";
import {
  createCustomCoverDataUrl,
  inspectCustomCoverBytes,
  inspectCustomCoverDataUrl,
  isCustomPageCoverValue,
  maxCustomCoverImageBytes,
  pageCoverPositionSchema,
  pageCoverUrlSchema,
  storedCustomPageCoverSentinel
} from "./page-cover.js";
import { createId } from "./id.js";
import {
  getBackupPageShareIdentityMode,
  isExactBackupPageShareIdentityMatch,
  isLegacyBackupPageShareCurrentMatch,
  isRestorablePageShareTarget
} from "./page-share-integrity.js";
import { renderBlockHtml } from "./markdown.js";
import {
  parsePageVersionActorsJson,
  parsePageVersionChangesJson,
  parsePageVersionSummaryJson
} from "./page-version-history.js";
import { dataTransferResourceLimits, measureJsonUtf8BytesWithinLimit } from "./data-transfer-limits.js";
import { blockSortOrderLimits } from "./block-order-integrity.js";
import { maxAvatarBytes, normalizeAvatarDataUrl, supportedProfileLanguages } from "./profile.js";
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
const legacyBackupVersion = 1;
const pageCoverFileBackupVersion = 2;
const uploadedAssetBackupVersion = 3;
const backupVersion = 4;
const maxManifestBytes = env.DATA_TRANSFER_MAX_MANIFEST_SIZE_MB * 1024 * 1024;
const idSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const timestampSchema = z.string().min(1).max(40);
const profileThemeSchema = z.enum(["light", "dark"]);
const preferredLanguageSchema = z.enum(supportedProfileLanguages);
const nullableString = (max: number) => z.string().max(max).nullable();
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
const customIconFilenameSchema = z.string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]{1,96}\.(?:png|jpg|webp|ico)$/);
const restoreJournalV4Schema = z.object({
  version: z.literal(4),
  userId: idSchema,
  operationId: idSchema,
  hadPreviousAttachments: z.boolean(),
  hadPreviousCustomIcons: z.boolean(),
  // Recovery limits stay intentionally broad so a journal written by a future
  // intake configuration remains recoverable after an interrupted restore.
  restoredAttachmentIds: z.array(idSchema).max(1_000_000),
  restoredCustomIconFiles: z.array(customIconFilenameSchema).max(1_000_000)
}).strict();
const restoreJournalSchema = z.discriminatedUnion("version", [
  restoreJournalV1Schema,
  restoreJournalV2Schema,
  restoreJournalV3Schema,
  restoreJournalV4Schema
]);
const restoreJournalEnvelopeSchema = z.object({
  format: z.literal("brainvault-restore-journal"),
  integrityVersion: z.literal(1),
  journal: restoreJournalSchema,
  hmac: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
type RestoreJournal = z.infer<typeof restoreJournalSchema>;
type RestoreJournalV2 = z.infer<typeof restoreJournalV2Schema>;
type RestoreJournalV3 = z.infer<typeof restoreJournalV3Schema>;
type RestoreJournalV4 = z.infer<typeof restoreJournalV4Schema>;

const pageSchema = z.object({
  id: idSchema,
  title: z.string().max(160),
  icon: iconValueSchema.nullable(),
  cover_url: pageCoverUrlSchema.nullable(),
  cover_position_x: pageCoverPositionSchema.optional(),
  cover_position_y: pageCoverPositionSchema.optional(),
  is_archived: z.union([z.literal(0), z.literal(1)]),
  is_collection: z.union([z.literal(0), z.literal(1)]),
  parent_page_id: idSchema.nullable(),
  edit_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  content_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema
}).strict();

const blockTypes = [
  "MARKDOWN", "HEADING_1", "HEADING_2", "HEADING_3", "TODO", "UNORDERED_LIST", "ORDERED_LIST", "QUOTE", "CALLOUT", "TOGGLE", "ACCORDION", "TABLE",
  "KANBAN", "DATABASE", "TREEVIEW", "TIMETABLE", "GANTT", "BOOKMARK", "AI_CHAT", "MATH", "CODE", "DIVIDER", "IMAGE", "VIDEO", "ATTACHMENT"
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
const byteCountSchema = z.string().min(1).max(20).regex(/^\d+$/);
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
  size: byteCountSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  crc32: z.number().int().min(0).max(0xffffffff)
}).strict();
const retainedAttachmentSchema = z.object({
  fileName: idSchema,
  path: z.string().min(1).max(160),
  size: byteCountSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  crc32: z.number().int().min(0).max(0xffffffff)
}).strict();
const pageCoverMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
const pageCoverFileSchema = z.object({
  pageId: idSchema,
  path: z.string().min(1).max(160),
  mimeType: pageCoverMimeTypeSchema,
  size: byteCountSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  crc32: z.number().int().min(0).max(0xffffffff)
}).strict();
const customIconMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/vnd.microsoft.icon"
]);
const customIconLibraryMetadataSchema = z.object({
  id: idSchema,
  last_used_at: timestampSchema,
  created_at: timestampSchema
}).strict();
const customIconFileSchema = z.object({
  fileName: customIconFilenameSchema,
  path: z.string().min(1).max(180),
  mimeType: customIconMimeTypeSchema,
  size: byteCountSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  crc32: z.number().int().min(0).max(0xffffffff),
  library: customIconLibraryMetadataSchema.nullable()
}).strict();
const customIconLibraryRemovalSchema = z.object({
  value_hash: z.string().regex(/^[a-f0-9]{64}$/),
  removed_at: timestampSchema
}).strict();
function pageVersionJsonColumnSchema(label: string, validateValue: (value: string) => unknown) {
  return z.string().min(1).max(maxManifestBytes).superRefine((value, context) => {
    try {
      validateValue(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : `Backup ${label} is invalid`
      });
    }
  });
}
const pageVersionSchema = z.object({
  page_id: idSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  page_edit_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  page_content_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  actors: pageVersionJsonColumnSchema("page version actors", parsePageVersionActorsJson),
  source: z.string().min(1).max(32),
  change_count: z.number().int().min(0).max(0xffffffff),
  change_summary: pageVersionJsonColumnSchema("page version summary", parsePageVersionSummaryJson),
  changes: pageVersionJsonColumnSchema("page version changes", parsePageVersionChangesJson),
  created_at: timestampSchema
}).strict();

const navigationPageOrderSchema = z.object({
  page_id: idSchema,
  sort_order: z.number().int().min(0).max(dataTransferResourceLimits.maxPages - 1)
}).strict();

const manifestSchema = z.object({
  format: z.literal(backupFormat),
  version: z.union([
    z.literal(legacyBackupVersion),
    z.literal(pageCoverFileBackupVersion),
    z.literal(uploadedAssetBackupVersion),
    z.literal(backupVersion)
  ]),
  exportedAt: timestampSchema,
  source: z.object({ userId: idSchema, username: z.string().min(1).max(50) }).strict(),
  account: z.object({
    name: nullableString(80),
    avatar_data: backupAvatarSchema,
    preferred_language: preferredLanguageSchema.nullable(),
    default_collection_icon: iconValueSchema.nullable(),
    // Optional only for backups exported before account themes were added.
    theme: profileThemeSchema.optional()
  }).strict(),
  data: z.object({
    pages: z.array(pageSchema).max(dataTransferResourceLimits.maxPages),
    blocks: z.array(blockSchema).max(dataTransferResourceLimits.maxBlocks),
    tags: z.array(tagSchema).max(dataTransferResourceLimits.maxTags),
    pageTags: z.array(pageTagSchema).max(dataTransferResourceLimits.maxPageTags),
    // Optional only for backward compatibility with backups exported before
    // page sharing relationships became part of the complete workspace format.
    pageShares: z.array(pageShareSchema).max(dataTransferResourceLimits.maxPageShares).optional(),
    // Version 4 makes user-visible page history and owned-page navigation state
    // part of the complete workspace round trip. Older backups did not carry it.
    pageVersions: z.array(pageVersionSchema).max(dataTransferResourceLimits.maxPageVersions).optional(),
    navigationCollapsedPageIds: z.array(idSchema).max(dataTransferResourceLimits.maxPages).optional(),
    // Added compatibly to version 4: older v4 backups without this preference
    // remain importable, while new backups preserve explicit sidebar order.
    navigationPageOrder: z.array(navigationPageOrderSchema).max(dataTransferResourceLimits.maxPages).optional()
  }).strict(),
  attachments: z.array(attachmentSchema).max(dataTransferResourceLimits.maxAttachments),
  // Version 3 also preserves any account attachment file that is intentionally
  // left on disk without a current ATTACHMENT block (for example after an
  // ambiguous database commit outcome), so the per-account uploads directory is
  // byte-complete rather than silently dropping retained files.
  retainedAttachments: z.array(retainedAttachmentSchema).max(dataTransferResourceLimits.maxAttachments).optional(),
  // Version 2 moves custom cover bytes out of JSON so a handful of valid images
  // cannot exhaust the much smaller manifest limit. Version 1 remains importable.
  pageCovers: z.array(pageCoverFileSchema).max(dataTransferResourceLimits.maxPageCovers).optional(),
  // Version 3 makes every uploaded custom icon self-contained in the archive,
  // including files removed from the picker library but intentionally retained
  // on disk for immutable icon URLs and historical references.
  customIcons: z.array(customIconFileSchema).max(dataTransferResourceLimits.maxCustomIcons).optional(),
  customIconLibraryRemovals: z.array(customIconLibraryRemovalSchema)
    .max(dataTransferResourceLimits.maxCustomIconLibraryRemovals)
    .optional()
}).strict().superRefine((manifest, context) => {
  if (manifest.version !== legacyBackupVersion && !manifest.pageCovers) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pageCovers"],
      message: "Version 2 and newer backups must declare page cover files"
    });
  }
  if (manifest.version === legacyBackupVersion && manifest.pageCovers) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pageCovers"],
      message: "Version 1 backups cannot declare page cover files"
    });
  }
  if (manifest.version >= uploadedAssetBackupVersion && !manifest.retainedAttachments) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["retainedAttachments"],
      message: "Version 3 and newer backups must declare retained attachment files"
    });
  }
  if (manifest.version < uploadedAssetBackupVersion && manifest.retainedAttachments) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["retainedAttachments"],
      message: "Backups before version 3 cannot declare retained attachment files"
    });
  }
  if (manifest.version >= uploadedAssetBackupVersion && !manifest.customIcons) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["customIcons"],
      message: "Version 3 and newer backups must declare uploaded custom icon files"
    });
  }
  if (manifest.version >= uploadedAssetBackupVersion && !manifest.customIconLibraryRemovals) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["customIconLibraryRemovals"],
      message: "Version 3 and newer backups must declare custom icon library removal state"
    });
  }
  if (manifest.version < uploadedAssetBackupVersion && (manifest.customIcons || manifest.customIconLibraryRemovals)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["customIcons"],
      message: "Backups before version 3 cannot declare uploaded custom icon state"
    });
  }
  if (manifest.version === backupVersion && !manifest.data.pageVersions) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["data", "pageVersions"],
      message: "Version 4 backups must declare page version history"
    });
  }
  if (manifest.version === backupVersion && !manifest.data.navigationCollapsedPageIds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["data", "navigationCollapsedPageIds"],
      message: "Version 4 backups must declare owned-page navigation preferences"
    });
  }
  if (
    manifest.version < backupVersion
    && (manifest.data.pageVersions || manifest.data.navigationCollapsedPageIds || manifest.data.navigationPageOrder)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["data", "pageVersions"],
      message: "Backups before version 4 cannot declare page history or navigation state"
    });
  }
});

export type BrainVaultBackup = z.infer<typeof manifestSchema>;
type BackupPage = BrainVaultBackup["data"]["pages"][number];
type BackupBlock = BrainVaultBackup["data"]["blocks"][number];
type BackupTag = BrainVaultBackup["data"]["tags"][number];
type BackupPageShare = z.infer<typeof pageShareSchema>;
type BackupPageVersion = z.infer<typeof pageVersionSchema>;
type BackupPageCoverFile = z.infer<typeof pageCoverFileSchema>;
type BackupRetainedAttachmentFile = z.infer<typeof retainedAttachmentSchema>;
type BackupCustomIconFile = z.infer<typeof customIconFileSchema>;

type WorkspaceRestoreAccountRow = {
  name: string | null;
  avatar_data: string | null;
  preferred_language: string | null;
  default_collection_icon: string | null;
  theme: "light" | "dark";
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

type WorkspaceRestoreCustomIconRow = {
  id: string;
  file_path: string;
  last_used_at: string;
  created_at: string;
};

type WorkspaceRestoreCustomIconRemovalRow = {
  value_hash: string;
  removed_at: string;
};

type WorkspaceRestorePageVersionRow = {
  page_id: string;
  revision: number | bigint;
  page_edit_version: number | bigint;
  page_content_version: number | bigint;
  actors: string;
  source: string;
  change_count: number;
  change_summary: string;
  changes: string;
  created_at: string;
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

type CollaboratorNavigationCollapsedRow = {
  user_id: string;
  page_id: string;
  created_at: string;
};

type CollaboratorNavigationOrderRow = {
  user_id: string;
  page_id: string;
  sort_order: number;
  updated_at: string;
};

type RestoreCollaboratorNavigationPlan = {
  collapsed: CollaboratorNavigationCollapsedRow[];
  order: CollaboratorNavigationOrderRow[];
};

type RestorePageVersionResetMutationRow = {
  owner_id: string;
  mutation_id: string;
  page_id: string;
  request_hash: string;
  revision: number | null;
  deleted_count: number | null;
  created_at: string;
};

type RestoreBlockOrderMutationRow = {
  owner_id: string;
  mutation_id: string;
  page_id: string;
  request_hash: string | null;
  created_at: string;
};

type RestoreBlockCreateMutationRow = {
  actor_id: string;
  mutation_id: string;
  page_id: string;
  block_id: string;
  request_hash: string;
  created_at: string;
};

type RestoreMutationReceiptPlan = {
  pageVersionResets: RestorePageVersionResetMutationRow[];
  blockOrders: RestoreBlockOrderMutationRow[];
  blockCreates: RestoreBlockCreateMutationRow[];
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
  theme: "light" | "dark";
};

type RawCustomIconRow = {
  id: string;
  file_path: string;
  last_used_at: string;
  created_at: string;
};

type RawCustomIconLibraryRemovalRow = {
  value_hash: string;
  removed_at: string;
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

async function listWorkspaceRestoreAssetFiles(
  directory: string,
  label: string,
  isValidName: (name: string) => boolean
) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as Array<{ name: string; size: string }>;
    throw error;
  }

  const files: Array<{ name: string; size: string }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === dataRestoreGenerationMarkerName) continue;
    if (!entry.isFile() || !isValidName(entry.name)) {
      throw new ApiError(
        409,
        "DATA_RESTORE_ASSET_STORAGE_INVALID",
        `${label} storage contains an unsupported entry: ${entry.name}`
      );
    }
    const fileInfo = await stat(path.join(directory, entry.name));
    if (!fileInfo.isFile()) {
      throw new ApiError(
        409,
        "DATA_RESTORE_ASSET_STORAGE_INVALID",
        `${label} storage entry is not a regular file: ${entry.name}`
      );
    }
    files.push({ name: entry.name, size: String(fileInfo.size) });
  }
  return files;
}

async function createWorkspaceRestoreSnapshot(
  userId: string,
  client: DbClient = db,
  lock = false,
  includeCustomIconAssets = false
) {
  const lockClause = lock ? " FOR UPDATE" : "";
  const account = await client.queryOne<WorkspaceRestoreAccountRow>(
    `SELECT name, avatar_data, preferred_language, default_collection_icon, theme
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
  const pageVersions = await client.query<WorkspaceRestorePageVersionRow>(
    `SELECT pv.page_id, pv.revision, pv.page_edit_version, pv.page_content_version,
            CAST(pv.actors AS CHAR CHARACTER SET utf8mb4) AS actors,
            pv.source, pv.change_count,
            CAST(pv.change_summary AS CHAR CHARACTER SET utf8mb4) AS change_summary,
            CAST(pv.changes AS CHAR CHARACTER SET utf8mb4) AS changes,
            DATE_FORMAT(pv.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
     FROM page_versions pv INNER JOIN pages p ON p.id = pv.page_id
     WHERE p.owner_id = ?
     ORDER BY pv.page_id ASC, pv.revision ASC${lockClause}`,
    [userId]
  );
  const navigationCollapsedPageIds = (await client.query<{ page_id: string }>(
    `SELECT np.page_id
     FROM user_navigation_collapsed_pages np
     INNER JOIN pages p ON p.id = np.page_id
     WHERE np.user_id = ? AND p.owner_id = ?
     ORDER BY np.page_id ASC${lockClause}`,
    [userId, userId]
  )).map((row) => row.page_id);
  const navigationPageOrder = await client.query<{ page_id: string; sort_order: number }>(
    `SELECT no.page_id, no.sort_order
     FROM user_navigation_page_order no
     INNER JOIN pages p ON p.id = no.page_id
     WHERE no.user_id = ? AND p.owner_id = ?
     ORDER BY no.sort_order ASC, no.page_id ASC${lockClause}`,
    [userId, userId]
  );
  const customIcons = await client.query<WorkspaceRestoreCustomIconRow>(
    `SELECT id, file_path,
            DATE_FORMAT(last_used_at, '%Y-%m-%d %H:%i:%s.%f') AS last_used_at,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
     FROM custom_icons
     WHERE user_id = ?
     ORDER BY id ASC${lockClause}`,
    [userId]
  );
  const customIconRemovals = await client.query<WorkspaceRestoreCustomIconRemovalRow>(
    `SELECT value_hash,
            DATE_FORMAT(removed_at, '%Y-%m-%d %H:%i:%s.%f') AS removed_at
     FROM custom_icon_library_removals
     WHERE user_id = ?
     ORDER BY value_hash ASC${lockClause}`,
    [userId]
  );
  const attachmentAssetFiles = await listWorkspaceRestoreAssetFiles(
    path.join(attachmentUploadRoot, userId),
    "Attachment",
    (name) => idSchema.safeParse(name).success
  );
  const customIconAssetFiles = includeCustomIconAssets
    ? await listWorkspaceRestoreAssetFiles(
      path.join(customIconUploadRoot, userId),
      "Custom icon",
      (name) => customIconFilenameSchema.safeParse(name).success
    )
    : [];

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
  for (const version of pageVersions) {
    hash.update(
      `page-version\0${version.page_id}\0${String(version.revision)}\0${String(version.page_edit_version)}\0${String(version.page_content_version)}\0${version.actors}\0${version.source}\0${version.change_count}\0${version.change_summary}\0${version.changes}\0${version.created_at}\n`
    );
  }
  for (const pageId of navigationCollapsedPageIds) {
    hash.update(`navigation-collapsed\0${pageId}\n`);
  }
  for (const item of navigationPageOrder) {
    hash.update(`navigation-order\0${item.page_id}\0${Number(item.sort_order)}\n`);
  }
  for (const icon of customIcons) {
    hash.update(
      `custom-icon\0${icon.id}\0${icon.file_path}\0${icon.last_used_at}\0${icon.created_at}\n`
    );
  }
  for (const removal of customIconRemovals) {
    hash.update(`custom-icon-removal\0${removal.value_hash}\0${removal.removed_at}\n`);
  }
  for (const file of attachmentAssetFiles) {
    hash.update(`attachment-file\0${file.name}\0${file.size}\n`);
  }
  for (const file of customIconAssetFiles) {
    hash.update(`custom-icon-file\0${file.name}\0${file.size}\n`);
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
    const comparisonKey = value.toLowerCase();
    if (seen.has(comparisonKey)) invalidBackup(`The backup contains a duplicate ${label}: ${value}`);
    seen.add(comparisonKey);
  }
}

function customIconPublicPath(userId: string, fileName: string) {
  return `${customIconPublicPrefix}${userId}/${fileName}`;
}

function customIconValue(userId: string, fileName: string) {
  return `${imageIconPrefix}${customIconPublicPath(userId, fileName)}`;
}

function customIconValueHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function localCustomIconPublicPath(value: string | null) {
  if (!value?.startsWith(imageIconPrefix)) return null;
  const publicPath = value.slice(imageIconPrefix.length).trim();
  return isServerCustomIconPath(publicPath) ? publicPath : null;
}

function rebindCustomIconValue(value: string | null, sourceUserId: string, targetUserId: string) {
  const normalized = normalizeIconValue(value);
  const publicPath = localCustomIconPublicPath(normalized);
  if (!publicPath) return normalized;
  const sourcePrefix = `${customIconPublicPrefix}${sourceUserId}/`;
  if (!publicPath.startsWith(sourcePrefix)) {
    invalidBackup(`Uploaded custom icon belongs to another account: ${publicPath}`);
  }
  const fileName = publicPath.slice(sourcePrefix.length);
  return `${imageIconPrefix}${customIconPublicPath(targetUserId, fileName)}`;
}

function rebindPageVersionChangesJson(value: string, sourceUserId: string, targetUserId: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalidBackup("Page version history contains invalid JSON");
  }
  if (!Array.isArray(parsed)) invalidBackup("Page version history changes must be an array");

  const rebindHistoryIcon = (candidate: unknown) => {
    if (candidate !== null && typeof candidate !== "string") {
      invalidBackup("Page version history contains an invalid icon value");
    }
    return rebindCustomIconValue(candidate as string | null, sourceUserId, targetUserId);
  };

  for (const change of parsed) {
    if (!change || typeof change !== "object" || Array.isArray(change)) continue;
    const record = change as Record<string, unknown>;
    if (record.kind === "history-started" || record.kind === "page-created") {
      const page = record.page;
      if (page && typeof page === "object" && !Array.isArray(page) && "icon" in page) {
        const pageRecord = page as Record<string, unknown>;
        pageRecord.icon = rebindHistoryIcon(pageRecord.icon);
      }
      continue;
    }
    if (record.kind !== "page-updated" || !Array.isArray(record.fields)) continue;
    for (const field of record.fields) {
      if (!field || typeof field !== "object" || Array.isArray(field)) continue;
      const fieldRecord = field as Record<string, unknown>;
      if (fieldRecord.field !== "icon") continue;
      if ("before" in fieldRecord) fieldRecord.before = rebindHistoryIcon(fieldRecord.before);
      if ("after" in fieldRecord) fieldRecord.after = rebindHistoryIcon(fieldRecord.after);
    }
  }

  return JSON.stringify(parsed);
}

function rebindPageVersionActorsJson(value: string, sourceUserId: string, targetUserId: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalidBackup("Page version history contains invalid actor JSON");
  }
  if (!Array.isArray(parsed)) invalidBackup("Page version history actors must be an array");
  for (const actor of parsed) {
    if (!actor || typeof actor !== "object" || Array.isArray(actor)) continue;
    const record = actor as Record<string, unknown>;
    if (record.id === sourceUserId) record.id = targetUserId;
  }
  return JSON.stringify(parsed);
}

function expectedCustomIconExtension(mimeType: BackupCustomIconFile["mimeType"]) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "ico";
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
  const pageVersions = manifest.data.pageVersions ?? [];
  const navigationCollapsedPageIds = manifest.data.navigationCollapsedPageIds ?? [];
  const navigationPageOrder = manifest.data.navigationPageOrder ?? [];
  const retainedAttachments = manifest.retainedAttachments ?? [];
  const pageCovers = manifest.pageCovers ?? [];
  const customIcons = manifest.customIcons ?? [];
  const customIconLibraryRemovals = manifest.customIconLibraryRemovals ?? [];
  assertUnique(pages.map((item) => item.id), "page ID");
  assertUnique(blocks.map((item) => item.id), "block ID");
  assertUnique(tags.map((item) => item.id), "tag ID");
  assertUnique(tags.map((item) => item.name.toLowerCase()), "tag name");
  assertUnique(manifest.attachments.map((item) => item.blockId), "attachment block ID");
  assertUnique(manifest.attachments.map((item) => item.path), "attachment path");
  assertUnique(retainedAttachments.map((item) => item.fileName), "retained attachment filename");
  assertUnique(retainedAttachments.map((item) => item.path), "retained attachment path");
  assertUnique(
    [...manifest.attachments.map((item) => item.path), ...retainedAttachments.map((item) => item.path)],
    "uploaded attachment path"
  );
  assertUnique(pageCovers.map((item) => item.pageId), "page cover page ID");
  assertUnique(pageCovers.map((item) => item.path), "page cover path");
  assertUnique(customIcons.map((item) => item.fileName), "custom icon filename");
  assertUnique(customIcons.map((item) => item.path), "custom icon path");
  assertUnique(customIconLibraryRemovals.map((item) => item.value_hash), "custom icon removal key");
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
  assertUnique(
    pageVersions.map((item) => `${item.page_id}\u0000${item.revision}`),
    "page version revision"
  );
  assertUnique(navigationCollapsedPageIds, "collapsed navigation page ID");
  assertUnique(navigationPageOrder.map((item) => item.page_id), "ordered navigation page ID");
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

  for (const version of pageVersions) {
    const page = pageById.get(version.page_id);
    if (!page) invalidBackup(`Page version page is missing: ${version.page_id}`);
    if (version.page_edit_version > Number(page.edit_version ?? 1)) {
      invalidBackup(`Page version edit version exceeds the current page version: ${version.page_id}`);
    }
    if (version.page_content_version > Number(page.content_version ?? 1)) {
      invalidBackup(`Page version content version exceeds the current page version: ${version.page_id}`);
    }
  }
  for (const pageId of navigationCollapsedPageIds) {
    if (!pageById.has(pageId)) invalidBackup(`Collapsed navigation page is missing: ${pageId}`);
  }
  for (const item of navigationPageOrder) {
    if (!pageById.has(item.page_id)) invalidBackup(`Ordered navigation page is missing: ${item.page_id}`);
  }

  const pageCoverByPageId = new Map(pageCovers.map((item) => [item.pageId, item]));
  for (const pageCover of pageCovers) {
    const page = pageById.get(pageCover.pageId);
    if (!page) invalidBackup(`Page cover page is missing: ${pageCover.pageId}`);
    if (pageCover.path !== `page-covers/${pageCover.pageId}`) {
      invalidBackup(`Page cover path is invalid: ${pageCover.path}`);
    }
    if (page.cover_url !== null) {
      invalidBackup(`Page cover is declared both inline and as a ZIP entry: ${pageCover.pageId}`);
    }
  }
  if (manifest.version !== legacyBackupVersion) {
    for (const page of pages) {
      if (isCustomPageCoverValue(page.cover_url)) {
        invalidBackup(`Version 2 and newer page cover must be stored as a ZIP entry: ${page.id}`);
      }
    }
  } else if (pageCoverByPageId.size) {
    invalidBackup("Version 1 backups cannot contain page cover entries");
  }

  if (manifest.version >= uploadedAssetBackupVersion) {
    const declaredCustomIconPaths = new Set<string>();
    for (const icon of customIcons) {
      if (icon.path !== `custom-icons/${icon.fileName}`) {
        invalidBackup(`Custom icon path is invalid: ${icon.path}`);
      }
      const extension = icon.fileName.slice(icon.fileName.lastIndexOf(".") + 1);
      if (extension !== expectedCustomIconExtension(icon.mimeType)) {
        invalidBackup(`Custom icon extension does not match its media type: ${icon.fileName}`);
      }
      if (icon.library) {
        const expectedId = icon.fileName.slice(0, icon.fileName.lastIndexOf("."));
        if (icon.library.id !== expectedId) {
          invalidBackup(`Custom icon library ID does not match its filename: ${icon.fileName}`);
        }
      }
      declaredCustomIconPaths.add(customIconPublicPath(manifest.source.userId, icon.fileName));
    }

    for (const [label, value] of [
      ["default collection", manifest.account.default_collection_icon] as const,
      ...pages.map((page) => [`page ${page.id}`, page.icon] as const)
    ]) {
      const publicPath = localCustomIconPublicPath(value);
      if (!publicPath) continue;
      if (!publicPath.startsWith(`${customIconPublicPrefix}${manifest.source.userId}/`)) {
        invalidBackup(`The ${label} custom icon belongs to another account: ${publicPath}`);
      }
      if (!declaredCustomIconPaths.has(publicPath)) {
        invalidBackup(`The ${label} custom icon file is missing from the backup: ${publicPath}`);
      }
    }
  }

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
  if (manifest.attachments.length + retainedAttachments.length > dataTransferResourceLimits.maxAttachments) {
    invalidBackup("The backup contains too many uploaded attachment files");
  }
  if (manifest.version < uploadedAssetBackupVersion && retainedAttachments.length) {
    invalidBackup("Backups before version 3 cannot contain retained attachment files");
  }
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
  for (const retained of retainedAttachments) {
    if (retained.path !== `attachments/${retained.fileName}`) {
      invalidBackup(`Retained attachment path is invalid: ${retained.path}`);
    }
    if (describedAttachmentIds.has(retained.fileName)) {
      invalidBackup(`Retained attachment duplicates an active attachment: ${retained.fileName}`);
    }
  }
}

export async function prepareUserDataBackup(userId: string) {
  await ensureDataTransferDirectories();
  const maxTransferBytes = BigInt(env.DATA_TRANSFER_MAX_SIZE_MB) * 1024n * 1024n;
  const operationRoot = path.join(dataTransferTempDir, createId("export"));
  const stagedAttachmentDir = path.join(operationRoot, "attachments");
  const stagedPageCoverDir = path.join(operationRoot, "page-covers");
  const stagedCustomIconDir = path.join(operationRoot, "custom-icons");
  await Promise.all([
    mkdir(stagedAttachmentDir, { recursive: true }),
    mkdir(stagedPageCoverDir, { recursive: true }),
    mkdir(stagedCustomIconDir, { recursive: true })
  ]);

  try {
    const { snapshot, attachmentFiles, retainedAttachmentFiles, pageCoverFiles, customIconFiles } = await withUserAttachmentLock(userId, async (client) => {
      // Lock the complete page set before the first consistent read establishes the
      // REPEATABLE READ snapshot. Otherwise a concurrent commit can make this locking
      // read observe newer page versions while later non-locking reads still return
      // older blocks and tag relations from an earlier snapshot.
      const pages = await client.query<BackupPage>(
        `SELECT id, title, icon,
           CASE WHEN cover_url LIKE 'data:image/%;base64,%' THEN ? ELSE cover_url END AS cover_url,
           cover_position_x, cover_position_y, is_archived, is_collection, parent_page_id, edit_version, content_version,
           DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at,
           DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at
         FROM pages WHERE owner_id = ? ORDER BY created_at ASC, id ASC FOR UPDATE`,
        [storedCustomPageCoverSentinel, userId]
      );

      const account = await client.queryOne<RawAccountRow>(
        `SELECT id, username, name, avatar_data, preferred_language, default_collection_icon, theme
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
      const pageVersions = await client.query<BackupPageVersion>(
        `SELECT pv.page_id, pv.revision, pv.page_edit_version, pv.page_content_version,
                CAST(pv.actors AS CHAR CHARACTER SET utf8mb4) AS actors, pv.source, pv.change_count,
                CAST(pv.change_summary AS CHAR CHARACTER SET utf8mb4) AS change_summary,
                CAST(pv.changes AS CHAR CHARACTER SET utf8mb4) AS changes,
                DATE_FORMAT(pv.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
         FROM page_versions pv INNER JOIN pages p ON p.id = pv.page_id
         WHERE p.owner_id = ?
         ORDER BY pv.page_id ASC, pv.revision ASC`,
        [userId]
      );
      const navigationCollapsedPageIds = (await client.query<{ page_id: string }>(
        `SELECT np.page_id
         FROM user_navigation_collapsed_pages np
         INNER JOIN pages p ON p.id = np.page_id
         WHERE np.user_id = ? AND p.owner_id = ?
         ORDER BY np.page_id ASC`,
        [userId, userId]
      )).map((row) => row.page_id);
      const navigationPageOrder = await client.query<{ page_id: string; sort_order: number }>(
        `SELECT no.page_id, no.sort_order
         FROM user_navigation_page_order no
         INNER JOIN pages p ON p.id = no.page_id
         WHERE no.user_id = ? AND p.owner_id = ?
         ORDER BY no.sort_order ASC, no.page_id ASC`,
        [userId, userId]
      );
      const customIconRows = await client.query<RawCustomIconRow>(
        `SELECT id, file_path,
                DATE_FORMAT(last_used_at, '%Y-%m-%d %H:%i:%s.%f') AS last_used_at,
                DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
         FROM custom_icons
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        [userId]
      );
      const customIconLibraryRemovals = await client.query<RawCustomIconLibraryRemovalRow>(
        `SELECT value_hash,
                DATE_FORMAT(removed_at, '%Y-%m-%d %H:%i:%s.%f') AS removed_at
         FROM custom_icon_library_removals
         WHERE user_id = ?
         ORDER BY removed_at ASC, value_hash ASC`,
        [userId]
      );
      const attachmentBlocks = blocks.filter((item) => item.type === "ATTACHMENT");
      assertExportCount("pages", pages.length, dataTransferResourceLimits.maxPages);
      assertExportCount("blocks", blocks.length, dataTransferResourceLimits.maxBlocks);
      assertExportCount("tags", tags.length, dataTransferResourceLimits.maxTags);
      assertExportCount("page-tag relations", pageTags.length, dataTransferResourceLimits.maxPageTags);
      assertExportCount("page sharing grants", pageShares.length, dataTransferResourceLimits.maxPageShares);
      assertExportCount("page version history entries", pageVersions.length, dataTransferResourceLimits.maxPageVersions);
      assertExportCount("collapsed navigation pages", navigationCollapsedPageIds.length, dataTransferResourceLimits.maxPages);
      assertExportCount("ordered navigation pages", navigationPageOrder.length, dataTransferResourceLimits.maxPages);
      assertExportCount("attachments", attachmentBlocks.length, dataTransferResourceLimits.maxAttachments);
      assertExportCount(
        "custom icon library removal records",
        customIconLibraryRemovals.length,
        dataTransferResourceLimits.maxCustomIconLibraryRemovals
      );

      const pageCoverFiles = [] as Array<{
        pageId: string;
        path: string;
        mimeType: BackupPageCoverFile["mimeType"];
        filePath: string;
        inspection: FileInspection;
      }>;
      let stagedFileBytes = 0n;
      for (const page of pages) {
        if (page.cover_url !== storedCustomPageCoverSentinel) continue;
        const raw = await client.queryOne<{ cover_url: string | null }>(
          "SELECT cover_url FROM pages WHERE id = ? AND owner_id = ?",
          [page.id, userId]
        );
        if (!raw?.cover_url) {
          throw new ApiError(409, "BACKUP_COVER_MISSING", `Custom cover is missing for page ${page.id}`);
        }
        let inspectedCover: ReturnType<typeof inspectCustomCoverDataUrl>;
        try {
          inspectedCover = inspectCustomCoverDataUrl(raw.cover_url);
        } catch (error) {
          throw new ApiError(409, "BACKUP_COVER_INVALID", `Custom cover is invalid for page ${page.id}`, {
            reason: error instanceof Error ? error.message : "invalid cover"
          });
        }
        const stagedPath = path.join(stagedPageCoverDir, page.id);
        const nextStagedBytes = stagedFileBytes + BigInt(inspectedCover.bytes.length);
        if (nextStagedBytes > maxTransferBytes) {
          throw new ApiError(413, "DATA_BACKUP_TOO_LARGE", "The backup exceeds the configured data-transfer limit");
        }
        await writeFile(stagedPath, inspectedCover.bytes, { flag: "wx", mode: 0o600 });
        const inspection = await inspectFile(stagedPath);
        stagedFileBytes = nextStagedBytes;
        page.cover_url = null;
        pageCoverFiles.push({
          pageId: page.id,
          path: `page-covers/${page.id}`,
          mimeType: inspectedCover.mimeType as BackupPageCoverFile["mimeType"],
          filePath: stagedPath,
          inspection
        });
      }

      const attachmentFiles = [] as Array<{ blockId: string; path: string; filePath: string; inspection: FileInspection }>;
      for (const block of attachmentBlocks) {
        const sourcePath = getAttachmentFilePath(userId, block.id);
        const stagedPath = path.join(stagedAttachmentDir, block.id);
        try {
          const fileStat = await lstat(sourcePath);
          if (!fileStat.isFile()) throw new Error("not a file");
          if (stagedFileBytes + BigInt(fileStat.size) > maxTransferBytes) {
            throw new ApiError(413, "DATA_BACKUP_TOO_LARGE", "The backup exceeds the configured data-transfer limit");
          }
          await copyFile(sourcePath, stagedPath);
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(409, "BACKUP_ATTACHMENT_MISSING", `Attachment file is missing for block ${block.id}`);
        }
        const inspection = await inspectFile(stagedPath);
        stagedFileBytes += inspection.size;
        if (stagedFileBytes > maxTransferBytes) {
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

      const activeAttachmentNames = new Set(attachmentFiles.map((item) => item.blockId));
      const attachmentOwnerDir = path.join(attachmentUploadRoot, userId);
      let attachmentEntries: Dirent[];
      try {
        attachmentEntries = await readdir(attachmentOwnerDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") attachmentEntries = [];
        else throw error;
      }
      attachmentEntries = attachmentEntries.filter((entry) => entry.name !== dataRestoreGenerationMarkerName);
      assertExportCount(
        "uploaded attachment files",
        attachmentEntries.length,
        dataTransferResourceLimits.maxAttachments
      );

      const retainedAttachmentFiles = [] as Array<{
        fileName: string;
        path: string;
        filePath: string;
        inspection: FileInspection;
      }>;
      for (const entry of attachmentEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !idSchema.safeParse(entry.name).success) {
          throw new ApiError(
            409,
            "BACKUP_ATTACHMENT_STORAGE_INVALID",
            `Attachment storage contains an unsupported entry: ${entry.name}`
          );
        }
        if (activeAttachmentNames.has(entry.name)) continue;

        const sourcePath = getAttachmentFilePath(userId, entry.name);
        const stagedPath = path.join(stagedAttachmentDir, entry.name);
        const fileStat = await lstat(sourcePath);
        if (!fileStat.isFile()) {
          throw new ApiError(409, "BACKUP_ATTACHMENT_STORAGE_INVALID", `Retained attachment is not a file: ${entry.name}`);
        }
        if (stagedFileBytes + BigInt(fileStat.size) > maxTransferBytes) {
          throw new ApiError(413, "DATA_BACKUP_TOO_LARGE", "The backup exceeds the configured data-transfer limit");
        }
        await copyFile(sourcePath, stagedPath);
        const inspection = await inspectFile(stagedPath);
        stagedFileBytes += inspection.size;
        if (stagedFileBytes > maxTransferBytes) {
          throw new ApiError(413, "DATA_BACKUP_TOO_LARGE", "The backup exceeds the configured data-transfer limit");
        }
        retainedAttachmentFiles.push({
          fileName: entry.name,
          path: `attachments/${entry.name}`,
          filePath: stagedPath,
          inspection
        });
      }

      const customIconRowsByFileName = new Map<string, RawCustomIconRow>();
      const expectedOwnerPrefix = `${customIconPublicPrefix}${userId}/`;
      for (const row of customIconRows) {
        if (!isServerCustomIconPath(row.file_path) || !row.file_path.startsWith(expectedOwnerPrefix)) {
          throw new ApiError(
            409,
            "BACKUP_CUSTOM_ICON_PATH_INVALID",
            `Custom icon library path is invalid for icon ${row.id}`
          );
        }
        const fileName = row.file_path.slice(expectedOwnerPrefix.length);
        if (!customIconFilenameSchema.safeParse(fileName).success) {
          throw new ApiError(409, "BACKUP_CUSTOM_ICON_PATH_INVALID", `Custom icon filename is invalid: ${fileName}`);
        }
        if (row.id !== fileName.slice(0, fileName.lastIndexOf("."))) {
          throw new ApiError(409, "BACKUP_CUSTOM_ICON_PATH_INVALID", `Custom icon ID does not match its filename: ${row.id}`);
        }
        if (customIconRowsByFileName.has(fileName)) {
          throw new ApiError(409, "BACKUP_CUSTOM_ICON_DUPLICATE", `Custom icon library path is duplicated: ${fileName}`);
        }
        customIconRowsByFileName.set(fileName, row);
      }

      const customIconOwnerDir = path.join(customIconUploadRoot, userId);
      let customIconEntries: Dirent[];
      try {
        customIconEntries = await readdir(customIconOwnerDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") customIconEntries = [];
        else throw error;
      }
      customIconEntries = customIconEntries.filter((entry) => entry.name !== dataRestoreGenerationMarkerName);
      assertExportCount("uploaded custom icons", customIconEntries.length, dataTransferResourceLimits.maxCustomIcons);

      const customIconFiles = [] as Array<{
        fileName: string;
        path: string;
        mimeType: BackupCustomIconFile["mimeType"];
        library: BackupCustomIconFile["library"];
        filePath: string;
        inspection: FileInspection;
      }>;
      const stagedCustomIconNames = new Set<string>();
      for (const entry of customIconEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !customIconFilenameSchema.safeParse(entry.name).success) {
          throw new ApiError(
            409,
            "BACKUP_CUSTOM_ICON_STORAGE_INVALID",
            `Custom icon storage contains an unsupported entry: ${entry.name}`
          );
        }
        const sourcePath = getCustomIconFilePath(customIconPublicPath(userId, entry.name));
        if (!sourcePath) {
          throw new ApiError(409, "BACKUP_CUSTOM_ICON_PATH_INVALID", `Custom icon path is invalid: ${entry.name}`);
        }
        const stagedPath = path.join(stagedCustomIconDir, entry.name);
        const fileStat = await lstat(sourcePath);
        if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maxCustomIconBytes) {
          throw new ApiError(409, "BACKUP_CUSTOM_ICON_INVALID", `Custom icon file is invalid: ${entry.name}`);
        }
        if (stagedFileBytes + BigInt(fileStat.size) > maxTransferBytes) {
          throw new ApiError(413, "DATA_BACKUP_TOO_LARGE", "The backup exceeds the configured data-transfer limit");
        }
        await copyFile(sourcePath, stagedPath);
        const bytes = await readFile(stagedPath);
        const fileType = detectCustomIconFileType(bytes);
        if (!fileType || fileType.extension !== entry.name.slice(entry.name.lastIndexOf(".") + 1)) {
          throw new ApiError(409, "BACKUP_CUSTOM_ICON_INVALID", `Custom icon file is invalid: ${entry.name}`);
        }
        const inspection = await inspectFile(stagedPath);
        stagedFileBytes += inspection.size;
        const row = customIconRowsByFileName.get(entry.name) ?? null;
        customIconFiles.push({
          fileName: entry.name,
          path: `custom-icons/${entry.name}`,
          mimeType: fileType.mimeType,
          library: row ? {
            id: row.id,
            last_used_at: row.last_used_at,
            created_at: row.created_at
          } : null,
          filePath: stagedPath,
          inspection
        });
        stagedCustomIconNames.add(entry.name);
      }
      for (const fileName of customIconRowsByFileName.keys()) {
        if (!stagedCustomIconNames.has(fileName)) {
          throw new ApiError(409, "BACKUP_CUSTOM_ICON_MISSING", `Custom icon file is missing: ${fileName}`);
        }
      }

      const snapshot = {
        account, pages, blocks, tags, pageTags, pageShares, pageVersions, navigationCollapsedPageIds, navigationPageOrder,
        customIconLibraryRemovals
      };
      return { snapshot, attachmentFiles, retainedAttachmentFiles, pageCoverFiles, customIconFiles };
    });

    const manifest: BrainVaultBackup = {
      format: backupFormat,
      version: backupVersion,
      exportedAt: new Date().toISOString(),
      source: { userId: snapshot.account.id, username: snapshot.account.username },
      account: {
        name: snapshot.account.name,
        avatar_data: snapshot.account.avatar_data,
        preferred_language: preferredLanguageSchema.nullable().parse(snapshot.account.preferred_language),
        default_collection_icon: normalizeIconValue(snapshot.account.default_collection_icon),
        theme: snapshot.account.theme
      },
      data: {
        pages: snapshot.pages.map((page) => ({
          ...page,
          icon: normalizeIconValue(page.icon)
        })),
        blocks: snapshot.blocks,
        tags: snapshot.tags,
        pageTags: snapshot.pageTags,
        pageShares: snapshot.pageShares,
        pageVersions: snapshot.pageVersions,
        navigationCollapsedPageIds: snapshot.navigationCollapsedPageIds,
        navigationPageOrder: snapshot.navigationPageOrder.map((item) => ({
          page_id: item.page_id,
          sort_order: Number(item.sort_order)
        }))
      },
      attachments: attachmentFiles.map((item) => ({
        blockId: item.blockId,
        path: item.path,
        size: item.inspection.size.toString(),
        sha256: item.inspection.sha256,
        crc32: item.inspection.crc32
      })),
      retainedAttachments: retainedAttachmentFiles.map((item) => ({
        fileName: item.fileName,
        path: item.path,
        size: item.inspection.size.toString(),
        sha256: item.inspection.sha256,
        crc32: item.inspection.crc32
      })),
      pageCovers: pageCoverFiles.map((item) => ({
        pageId: item.pageId,
        path: item.path,
        mimeType: item.mimeType,
        size: item.inspection.size.toString(),
        sha256: item.inspection.sha256,
        crc32: item.inspection.crc32
      })),
      customIcons: customIconFiles.map((item) => ({
        fileName: item.fileName,
        path: item.path,
        mimeType: item.mimeType,
        size: item.inspection.size.toString(),
        sha256: item.inspection.sha256,
        crc32: item.inspection.crc32,
        library: item.library
      })),
      customIconLibraryRemovals: snapshot.customIconLibraryRemovals
    };
    validateManifestRelations(manifest);
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
    const totalUncompressedSize = [...attachmentFiles, ...retainedAttachmentFiles, ...pageCoverFiles, ...customIconFiles].reduce(
      (total, item) => total + item.inspection.size,
      BigInt(manifestBuffer.length)
    );
    if (totalUncompressedSize > maxTransferBytes) {
      throw new ApiError(413, "DATA_BACKUP_TOO_LARGE", "The backup exceeds the configured data-transfer limit");
    }
    const archiveSize = calculateZipArchiveSize([
      { name: manifestName, size: BigInt(manifestBuffer.length) },
      ...attachmentFiles.map((item) => ({ name: item.path, size: item.inspection.size })),
      ...retainedAttachmentFiles.map((item) => ({ name: item.path, size: item.inspection.size })),
      ...pageCoverFiles.map((item) => ({ name: item.path, size: item.inspection.size })),
      ...customIconFiles.map((item) => ({ name: item.path, size: item.inspection.size }))
    ]);
    return {
      account: snapshot.account,
      manifest,
      manifestBuffer,
      attachmentFiles,
      retainedAttachmentFiles,
      pageCoverFiles,
      customIconFiles,
      archiveSize,
      operationRoot
    };
  } catch (error) {
    await rm(operationRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeUserDataBackup(
  plan: Awaited<ReturnType<typeof prepareUserDataBackup>>,
  output: Writable
) {
  const { account, manifest, manifestBuffer, attachmentFiles, retainedAttachmentFiles, pageCoverFiles, customIconFiles } = plan;
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
    for (const item of retainedAttachmentFiles) {
      await writer.add({
        name: item.path,
        size: item.inspection.size,
        crc32: item.inspection.crc32,
        sha256: item.inspection.sha256,
        source: { kind: "file", path: item.filePath }
      });
    }
    for (const item of pageCoverFiles) {
      await writer.add({
        name: item.path,
        size: item.inspection.size,
        crc32: item.inspection.crc32,
        sha256: item.inspection.sha256,
        source: { kind: "file", path: item.filePath }
      });
    }
    for (const item of customIconFiles) {
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
      attachments: manifest.attachments.length,
      retainedAttachments: manifest.retainedAttachments?.length ?? 0,
      pageCovers: manifest.pageCovers?.length ?? 0,
      customIcons: manifest.customIcons?.length ?? 0,
      pageVersions: manifest.data.pageVersions?.length ?? 0,
      navigationCollapsedPages: manifest.data.navigationCollapsedPageIds?.length ?? 0,
      navigationOrderedPages: manifest.data.navigationPageOrder?.length ?? 0
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
  if (manifest.version >= uploadedAssetBackupVersion) {
    const libraryIds = (manifest.customIcons ?? []).flatMap((item) => item.library ? [item.library.id] : []);
    for (const ids of batch(libraryIds)) {
      if (!ids.length) continue;
      const rows = await db.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM custom_icons WHERE id IN (${ids.map(() => "?").join(",")})`,
        ids
      );
      const conflict = rows.find((row) => row.user_id !== userId);
      if (conflict) {
        throw new ApiError(409, "BACKUP_ID_CONFLICT", "The backup contains a custom icon identifier owned by another account");
      }
    }
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

function collaboratorNavigationKey(userId: string, pageId: string) {
  return `${userId}\u0000${pageId}`;
}

async function prepareRestoreCollaboratorNavigationPlan(
  client: DbClient,
  userId: string,
  pageShares: RestoredPageShare[]
): Promise<RestoreCollaboratorNavigationPlan> {
  const restoredShareKeys = new Set(
    pageShares.map((share) => collaboratorNavigationKey(share.userId, share.pageId))
  );
  const restoredCollaboratorIds = [...new Set(pageShares.map((share) => share.userId))];
  if (!restoredShareKeys.size) return { collapsed: [], order: [] };

  // Deleting the owner's pages cascades navigation rows for every account, not
  // just the owner. Preserve preferences for every collaborator whose grant will
  // exist after restore, including dormant preferences left from an older grant
  // that the backup is restoring. prepareRestoreSharingPlan has already locked
  // each final collaborator user row, matching the navigation mutation lock
  // order, so their preference writes cannot cross this snapshot.
  const collapsed: CollaboratorNavigationCollapsedRow[] = [];
  const order: CollaboratorNavigationOrderRow[] = [];
  for (const group of batch(restoredCollaboratorIds)) {
    if (!group.length) continue;
    const placeholders = group.map(() => "?").join(",");
    collapsed.push(...await client.query<CollaboratorNavigationCollapsedRow>(
      `SELECT np.user_id, np.page_id,
              DATE_FORMAT(np.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
       FROM user_navigation_collapsed_pages np
       INNER JOIN pages p ON p.id = np.page_id
       WHERE p.owner_id = ? AND np.user_id IN (${placeholders})
       ORDER BY np.user_id ASC, np.page_id ASC
       FOR UPDATE`,
      [userId, ...group]
    ));
    order.push(...await client.query<CollaboratorNavigationOrderRow>(
      `SELECT no.user_id, no.page_id, no.sort_order,
              DATE_FORMAT(no.updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at
       FROM user_navigation_page_order no
       INNER JOIN pages p ON p.id = no.page_id
       WHERE p.owner_id = ? AND no.user_id IN (${placeholders})
       ORDER BY no.user_id ASC, no.sort_order ASC, no.page_id ASC
       FOR UPDATE`,
      [userId, ...group]
    ));
  }

  return {
    collapsed: collapsed.filter((row) => restoredShareKeys.has(collaboratorNavigationKey(row.user_id, row.page_id))),
    order: order.filter((row) => restoredShareKeys.has(collaboratorNavigationKey(row.user_id, row.page_id)))
  };
}

async function prepareRestoreMutationReceiptPlan(
  client: DbClient,
  userId: string,
  manifest: BrainVaultBackup
): Promise<RestoreMutationReceiptPlan> {
  const restoredPageIds = new Set(manifest.data.pages.map((page) => page.id));
  const pageVersionResets = await client.query<RestorePageVersionResetMutationRow>(
    `SELECT m.owner_id, m.mutation_id, m.page_id, m.request_hash, m.revision, m.deleted_count,
            DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
     FROM page_version_reset_mutations m
     INNER JOIN pages p ON p.id = m.page_id
     WHERE p.owner_id = ?
     ORDER BY m.owner_id ASC, m.mutation_id ASC
     FOR UPDATE`,
    [userId]
  );
  const blockOrders = await client.query<RestoreBlockOrderMutationRow>(
    `SELECT m.owner_id, m.mutation_id, m.page_id, m.request_hash,
            DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
     FROM block_order_mutations m
     INNER JOIN pages p ON p.id = m.page_id
     WHERE p.owner_id = ?
     ORDER BY m.owner_id ASC, m.mutation_id ASC
     FOR UPDATE`,
    [userId]
  );
  const blockCreates = await client.query<RestoreBlockCreateMutationRow>(
    `SELECT m.actor_id, m.mutation_id, m.page_id, m.block_id, m.request_hash,
            DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
     FROM block_create_mutations m
     INNER JOIN pages p ON p.id = m.page_id
     WHERE p.owner_id = ?
     ORDER BY m.actor_id ASC, m.mutation_id ASC
     FOR UPDATE`,
    [userId]
  );
  // Receipts are runtime tombstones, not portable backup payload. Keep only
  // no-side-effect replay receipts whose page identity survives this restore so
  // delayed reset/create retries cannot cross the restore generation. A block
  // delete receipt is intentionally NOT preserved: replaying its attachment_ids
  // would run filesystem cleanup again and could delete an attachment resurrected
  // by the backup. Stale deletes remain fenced by the restore-only block
  // edit_version bump before any delete executes.
  return {
    pageVersionResets: pageVersionResets.filter((row) => restoredPageIds.has(row.page_id)),
    blockOrders: blockOrders.filter((row) => restoredPageIds.has(row.page_id)),
    blockCreates: blockCreates.filter((row) => restoredPageIds.has(row.page_id))
  };
}

function getManifestMaxEditVersion(manifest: BrainVaultBackup) {
  let maximum = 0;
  for (const page of manifest.data.pages) {
    maximum = Math.max(maximum, Number(page.edit_version ?? 1), Number(page.content_version ?? 1));
  }
  for (const block of manifest.data.blocks) maximum = Math.max(maximum, Number(block.edit_version ?? 1));
  for (const version of manifest.data.pageVersions ?? []) {
    maximum = Math.max(maximum, version.page_edit_version, version.page_content_version);
  }
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
  pageShares: RestoredPageShare[],
  collaboratorNavigation: RestoreCollaboratorNavigationPlan,
  mutationReceipts: RestoreMutationReceiptPlan,
  stagedPageCoverDir: string
) {
  const restoreIconValue = (value: string | null) => manifest.version >= uploadedAssetBackupVersion
    ? rebindCustomIconValue(value, manifest.source.userId, userId)
    : normalizeIconValue(value);
  await client.execute("DELETE FROM pages WHERE owner_id = ?", [userId]);
  await client.execute(
    `UPDATE users
     SET name = ?, avatar_data = ?, preferred_language = ?, default_collection_icon = ?, theme = COALESCE(?, theme)
     WHERE id = ?`,
    [
      manifest.account.name,
      normalizeAvatarDataUrl(manifest.account.avatar_data),
      manifest.account.preferred_language,
      restoreIconValue(manifest.account.default_collection_icon),
      manifest.account.theme ?? null,
      userId
    ]
  );

  const pageCoverByPageId = new Map((manifest.pageCovers ?? []).map((item) => [item.pageId, item]));
  const orderedPages = orderByParent(manifest.data.pages, (item) => item.id, (item) => item.parent_page_id);
  for (const page of orderedPages) {
    const pageCover = pageCoverByPageId.get(page.id);
    const coverUrl = pageCover
      ? createCustomCoverDataUrl(
        pageCover.mimeType,
        await readFile(path.join(stagedPageCoverDir, page.id))
      )
      : page.cover_url;
    await client.execute(
      `INSERT INTO pages
       (id, title, icon, cover_url, cover_position_x, cover_position_y, is_archived, is_collection, owner_id, parent_page_id, edit_version, content_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        page.id, page.title, restoreIconValue(page.icon), coverUrl,
        page.cover_position_x ?? 50, page.cover_position_y ?? 50,
        page.is_archived, page.is_collection, userId,
        page.parent_page_id, restoreVersion, restoreVersion, page.created_at, page.updated_at
      ]
    );
  }

  // Page replacement cascades page-tied mutation receipts. Recreate only the
  // no-side-effect replay receipts selected above before commit so old reset,
  // reorder, and create retries cannot cross the restore boundary as new work.
  // Block-delete receipts stay absent so their old attachment cleanup scope can
  // never be replayed against the newly restored filesystem generation.
  for (const row of mutationReceipts.pageVersionResets) {
    await client.execute(
      `INSERT INTO page_version_reset_mutations
         (owner_id, mutation_id, page_id, request_hash, revision, deleted_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.owner_id, row.mutation_id, row.page_id, row.request_hash, row.revision, row.deleted_count, row.created_at]
    );
  }
  for (const row of mutationReceipts.blockOrders) {
    await client.execute(
      `INSERT INTO block_order_mutations
         (owner_id, mutation_id, page_id, request_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [row.owner_id, row.mutation_id, row.page_id, row.request_hash, row.created_at]
    );
  }
  for (const row of mutationReceipts.blockCreates) {
    await client.execute(
      `INSERT INTO block_create_mutations
         (actor_id, mutation_id, page_id, block_id, request_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.actor_id, row.mutation_id, row.page_id, row.block_id, row.request_hash, row.created_at]
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

  // The page delete above also cascades navigation preferences owned by other
  // accounts. Reinsert the preferences captured for collaborators whose EDIT
  // grant survived the restore; the owner's own preferences are restored from
  // the backup manifest below and intentionally follow backup state instead.
  for (const row of collaboratorNavigation.collapsed) {
    await client.execute(
      `INSERT INTO user_navigation_collapsed_pages (user_id, page_id, created_at) VALUES (?, ?, ?)`,
      [row.user_id, row.page_id, row.created_at]
    );
  }
  for (const row of collaboratorNavigation.order) {
    await client.execute(
      `INSERT INTO user_navigation_page_order (user_id, page_id, sort_order, updated_at) VALUES (?, ?, ?, ?)`,
      [row.user_id, row.page_id, Number(row.sort_order), row.updated_at]
    );
  }

  if (manifest.version === backupVersion) {
    for (const version of manifest.data.pageVersions ?? []) {
      await client.execute(
        `INSERT INTO page_versions
         (page_id, revision, page_edit_version, page_content_version, actors, source, change_count, change_summary, changes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          version.page_id,
          version.revision,
          version.page_edit_version,
          version.page_content_version,
          JSON.stringify(parsePageVersionActorsJson(
            rebindPageVersionActorsJson(version.actors, manifest.source.userId, userId)
          )),
          version.source,
          version.change_count,
          JSON.stringify(parsePageVersionSummaryJson(version.change_summary)),
          JSON.stringify(parsePageVersionChangesJson(
            rebindPageVersionChangesJson(version.changes, manifest.source.userId, userId)
          )),
          version.created_at
        ]
      );
    }
    for (const pageId of manifest.data.navigationCollapsedPageIds ?? []) {
      await client.execute(
        `INSERT INTO user_navigation_collapsed_pages (user_id, page_id) VALUES (?, ?)`,
        [userId, pageId]
      );
    }
    for (const item of manifest.data.navigationPageOrder ?? []) {
      await client.execute(
        `INSERT INTO user_navigation_page_order (user_id, page_id, sort_order) VALUES (?, ?, ?)`,
        [userId, item.page_id, item.sort_order]
      );
    }
  }

  if (manifest.version >= uploadedAssetBackupVersion) {
    await client.execute("DELETE FROM custom_icons WHERE user_id = ?", [userId]);
    await client.execute("DELETE FROM custom_icon_library_removals WHERE user_id = ?", [userId]);

    for (const icon of manifest.customIcons ?? []) {
      if (!icon.library) continue;
      await client.execute(
        `INSERT INTO custom_icons (id, user_id, file_path, last_used_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          icon.library.id,
          userId,
          customIconPublicPath(userId, icon.fileName),
          icon.library.last_used_at,
          icon.library.created_at
        ]
      );
    }

    const localRemovalHashMap = new Map(
      (manifest.customIcons ?? []).map((icon) => [
        customIconValueHash(customIconValue(manifest.source.userId, icon.fileName)),
        customIconValueHash(customIconValue(userId, icon.fileName))
      ])
    );
    for (const removal of manifest.customIconLibraryRemovals ?? []) {
      await client.execute(
        `INSERT INTO custom_icon_library_removals (user_id, value_hash, removed_at)
         VALUES (?, ?, ?)`,
        [userId, localRemovalHashMap.get(removal.value_hash) ?? removal.value_hash, removal.removed_at]
      );
    }
  }
}

const restoreJournalIntegrityDomain = "brainvault:data-restore-journal:v1";

function serializeRestoreJournalForIntegrity(journal: RestoreJournal) {
  if (journal.version === 1 || journal.version === 2) {
    return JSON.stringify([
      journal.version,
      journal.userId,
      journal.operationId,
      journal.hadPreviousAttachments
    ]);
  }
  if (journal.version === 3) {
    return JSON.stringify([
      journal.version,
      journal.userId,
      journal.operationId,
      journal.hadPreviousAttachments,
      journal.restoredAttachmentIds
    ]);
  }
  return JSON.stringify([
    journal.version,
    journal.userId,
    journal.operationId,
    journal.hadPreviousAttachments,
    journal.hadPreviousCustomIcons,
    journal.restoredAttachmentIds,
    journal.restoredCustomIconFiles
  ]);
}

function restoreJournalHmac(journal: RestoreJournal) {
  return createHmac("sha256", env.MFA_ENCRYPTION_KEY)
    .update(restoreJournalIntegrityDomain, "utf8")
    .update("\0", "utf8")
    .update(serializeRestoreJournalForIntegrity(journal), "utf8")
    .digest("hex");
}

function signRestoreJournal(journal: RestoreJournal) {
  return {
    format: "brainvault-restore-journal" as const,
    integrityVersion: 1 as const,
    journal,
    hmac: restoreJournalHmac(journal)
  };
}

function verifyRestoreJournalEnvelope(value: unknown) {
  const envelope = restoreJournalEnvelopeSchema.parse(value);
  const expected = Buffer.from(restoreJournalHmac(envelope.journal), "hex");
  const actual = Buffer.from(envelope.hmac, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Restore journal integrity check failed");
  }
  return envelope.journal;
}

function getRestorePaths(journal: RestoreJournal) {
  const safeUserId = journal.userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    journalPath: path.join(dataTransferTempDir, `${restoreJournalPrefix}${journal.operationId}.json`),
    operationRoot: path.join(dataTransferTempDir, journal.operationId),
    stagedAttachmentDir: path.join(dataTransferTempDir, journal.operationId, "attachments"),
    stagedPageCoverDir: path.join(dataTransferTempDir, journal.operationId, "page-covers"),
    oldAttachmentDir: path.join(attachmentUploadRoot, `.restore-previous-${safeUserId}-${journal.operationId}`),
    targetAttachmentDir: path.join(attachmentUploadRoot, safeUserId),
    stagedCustomIconDir: path.join(dataTransferTempDir, journal.operationId, "custom-icons"),
    oldCustomIconDir: path.join(customIconUploadRoot, `.restore-previous-${safeUserId}-${journal.operationId}`),
    targetCustomIconDir: path.join(customIconUploadRoot, safeUserId)
  };
}

async function writeRestoreJournal(journal: RestoreJournal) {
  await ensureDataTransferDirectories();
  const { journalPath } = getRestorePaths(journal);
  const temporaryPath = `${journalPath}.tmp-${createId("journal")}`;
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(signRestoreJournal(journal))}\n`, "utf8");
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
  if (state.status === "missing") return "an unmarked restore generation";
  return "the current restore generation";
}

async function listTrackedRestoreEntries(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === dataRestoreGenerationMarkerName) continue;
    if (!entry.isFile()) {
      throw new Error(
        `Restore recovery found an unsupported asset entry: ${path.join(directory, entry.name)}`
      );
    }
  }
  return entries;
}

async function preserveRestoreEntry(source: string, destination: string) {
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
        `Restore recovery found conflicting asset files at ${source} and ${destination}; preserving both generations for manual recovery`
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

type TrackedRestoreDirectory = {
  label: string;
  operationId: string;
  hadPrevious: boolean;
  restoredEntries: readonly string[];
  stagedDirectory: string;
  oldDirectory: string;
  targetDirectory: string;
  operationRoot: string;
};

async function recoverTrackedRestoreDirectory(
  tracked: TrackedRestoreDirectory,
  committed: boolean
) {
  let targetExists = await pathExists(tracked.targetDirectory);
  const stagedExists = await pathExists(tracked.stagedDirectory);

  if (committed) {
    if (!targetExists && stagedExists) {
      const stagedGeneration = await readRestoreGenerationMarker(tracked.stagedDirectory, tracked.operationId);
      if (stagedGeneration.status !== "match") {
        throw new Error(
          `Committed restore ${tracked.operationId} cannot promote ${describeRestoreGeneration(stagedGeneration)}`
        );
      }
      await mkdir(path.dirname(tracked.targetDirectory), { recursive: true });
      await rename(tracked.stagedDirectory, tracked.targetDirectory);
      await syncPath(path.dirname(tracked.targetDirectory));
      await syncDirectoryIfPresent(tracked.operationRoot);
      targetExists = true;
    }
    if (!targetExists) {
      throw new Error(`Committed restore ${tracked.operationId} is missing its ${tracked.label} directory`);
    }
    const targetGeneration = await readRestoreGenerationMarker(tracked.targetDirectory, tracked.operationId);
    if (targetGeneration.status !== "match") {
      throw new Error(
        `Committed restore ${tracked.operationId} found ${describeRestoreGeneration(targetGeneration)}; preserving all ${tracked.label} generations for manual recovery`
      );
    }
    await rm(tracked.oldDirectory, { recursive: true, force: true });
    await syncPath(path.dirname(tracked.oldDirectory));
    return;
  }

  const restoredEntries = new Set(tracked.restoredEntries);

  if (tracked.hadPrevious) {
    if (await pathExists(tracked.oldDirectory)) {
      if (targetExists) {
        const targetGeneration = await readRestoreGenerationMarker(tracked.targetDirectory, tracked.operationId);
        if (targetGeneration.status !== "match") {
          throw new Error(
            `Restore ${tracked.operationId} found ${describeRestoreGeneration(targetGeneration)} after a failed rollback; preserving both ${tracked.label} generations for manual recovery`
          );
        }

        // A new upload can commit after the failed restore transaction releases
        // its row lock but before recovery reacquires it. Preserve every file not
        // owned by this restore before discarding the failed restore generation.
        const entries = await listTrackedRestoreEntries(tracked.targetDirectory);
        for (const entry of entries) {
          if (entry.name === dataRestoreGenerationMarkerName || restoredEntries.has(entry.name)) continue;
          await preserveRestoreEntry(
            path.join(tracked.targetDirectory, entry.name),
            path.join(tracked.oldDirectory, entry.name)
          );
        }
        await rm(tracked.targetDirectory, { recursive: true, force: true });
      }
      await rename(tracked.oldDirectory, tracked.targetDirectory);
      await syncPath(path.dirname(tracked.targetDirectory));
      return;
    }

    if (!targetExists) {
      throw new Error(
        `Restore ${tracked.operationId} is missing both the previous and current ${tracked.label} directories`
      );
    }
    const targetGeneration = await readRestoreGenerationMarker(tracked.targetDirectory, tracked.operationId);
    if (targetGeneration.status === "match") {
      throw new Error(
        `Restore ${tracked.operationId} cannot roll back because its previous ${tracked.label} directory is missing`
      );
    }
    return;
  }

  if (!targetExists) return;
  const targetGeneration = await readRestoreGenerationMarker(tracked.targetDirectory, tracked.operationId);
  if (targetGeneration.status === "match") {
    const entries = await listTrackedRestoreEntries(tracked.targetDirectory);
    for (const entry of entries) {
      if (restoredEntries.has(entry.name)) {
        await rm(path.join(tracked.targetDirectory, entry.name), { force: true });
      }
    }
    // Remove the ownership marker last. If recovery crashes earlier, a retry can
    // still identify and finish cleaning this failed restore generation.
    await rm(restoreGenerationMarkerPath(tracked.targetDirectory), { force: true });
    await syncPath(tracked.targetDirectory);
    if ((await readdir(tracked.targetDirectory)).length === 0) {
      await rm(tracked.targetDirectory, { recursive: true, force: true });
      await syncPath(path.dirname(tracked.targetDirectory));
    }
    return;
  }
  if (targetGeneration.status === "missing") return;
  throw new Error(
    `Restore ${tracked.operationId} found ${describeRestoreGeneration(targetGeneration)}; preserving it for manual recovery`
  );
}

async function recoverTrackedRestoreAttachments(
  journal: RestoreJournalV3,
  paths: ReturnType<typeof getRestorePaths>,
  committed: boolean
) {
  await recoverTrackedRestoreDirectory({
    label: "attachment",
    operationId: journal.operationId,
    hadPrevious: journal.hadPreviousAttachments,
    restoredEntries: journal.restoredAttachmentIds,
    stagedDirectory: paths.stagedAttachmentDir,
    oldDirectory: paths.oldAttachmentDir,
    targetDirectory: paths.targetAttachmentDir,
    operationRoot: paths.operationRoot
  }, committed);
}

async function recoverTrackedRestoreAssets(
  journal: RestoreJournalV4,
  paths: ReturnType<typeof getRestorePaths>,
  committed: boolean
) {
  await recoverTrackedRestoreDirectory({
    label: "attachment",
    operationId: journal.operationId,
    hadPrevious: journal.hadPreviousAttachments,
    restoredEntries: journal.restoredAttachmentIds,
    stagedDirectory: paths.stagedAttachmentDir,
    oldDirectory: paths.oldAttachmentDir,
    targetDirectory: paths.targetAttachmentDir,
    operationRoot: paths.operationRoot
  }, committed);
  await recoverTrackedRestoreDirectory({
    label: "custom icon",
    operationId: journal.operationId,
    hadPrevious: journal.hadPreviousCustomIcons,
    restoredEntries: journal.restoredCustomIconFiles,
    stagedDirectory: paths.stagedCustomIconDir,
    oldDirectory: paths.oldCustomIconDir,
    targetDirectory: paths.targetCustomIconDir,
    operationRoot: paths.operationRoot
  }, committed);
}

export async function recoverDataRestoreJournal(journalInput: unknown) {
  return recoverRestoreJournal(verifyRestoreJournalEnvelope(journalInput));
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
    } else if (journal.version === 3) {
      await recoverTrackedRestoreAttachments(journal, paths, committed);
    } else {
      await recoverTrackedRestoreAssets(journal, paths, committed);
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
        if (journal.version === 4) {
          await rm(restoreGenerationMarkerPath(paths.targetCustomIconDir), { force: true });
          await syncDirectoryIfPresent(paths.targetCustomIconDir);
        }
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
    let journal: RestoreJournal;
    try {
      journal = verifyRestoreJournalEnvelope(JSON.parse(await readFile(journalPath, "utf8")));
    } catch (error) {
      console.error("Ignoring unauthenticated data restore journal", { journalPath, error });
      continue;
    }

    try {
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

export async function cleanupStaleDataTransferTempFiles(nowMs = Date.now()) {
  await ensureDataTransferDirectories();
  const entries = await readdir(dataTransferTempDir, { withFileTypes: true });
  const protectedOperationIds = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(restoreJournalPrefix) || !entry.name.endsWith(".json")) continue;
    const operationId = entry.name.slice(restoreJournalPrefix.length, -".json".length);
    if (idSchema.safeParse(operationId).success) protectedOperationIds.add(operationId);
  }

  const cutoff = nowMs - env.ATTACHMENT_TEMP_MAX_AGE_MS;
  for (const entry of entries) {
    if (entry.name.startsWith(restoreJournalPrefix) && entry.name.endsWith(".json")) continue;
    if (protectedOperationIds.has(entry.name)) continue;

    const entryPath = path.join(dataTransferTempDir, entry.name);
    let metadata;
    try {
      metadata = await stat(entryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (metadata.mtimeMs > cutoff) continue;

    if (entry.isDirectory()) {
      await rm(entryPath, { recursive: true, force: true });
    } else {
      await rm(entryPath, { force: true });
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
  const entryNamesCaseFolded = new Set<string>();
  let totalSize = 0n;
  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith("/") || entry.name.includes("\\") || entry.name.split("/").includes("..")) {
      invalidBackup(`ZIP entry path is unsafe: ${entry.name}`);
    }
    const caseFoldedName = entry.name.toLowerCase();
    if (entryByName.has(entry.name) || entryNamesCaseFolded.has(caseFoldedName)) {
      invalidBackup(`ZIP entry is duplicated: ${entry.name}`);
    }
    entryByName.set(entry.name, entry);
    entryNamesCaseFolded.add(caseFoldedName);
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
  const restoreBlockById = new Map(manifest.data.blocks.map((block) => [block.id, block]));
  const restoresCustomIcons = manifest.version >= uploadedAssetBackupVersion;
  const retainedAttachments = manifest.retainedAttachments ?? [];
  const restoredAttachmentBytes = [...manifest.attachments, ...retainedAttachments].reduce(
    (total, attachment) => total + BigInt(attachment.size),
    0n
  );
  assertAttachmentStorageLimit(
    0n,
    restoredAttachmentBytes,
    0,
    manifest.attachments.length + retainedAttachments.length
  );
  if (restoresCustomIcons) {
    const restoredCustomIconBytes = (manifest.customIcons ?? []).reduce(
      (total, icon) => total + BigInt(icon.size),
      0n
    );
    assertCustomIconStorageLimit(
      0n,
      restoredCustomIconBytes,
      0,
      manifest.customIcons?.length ?? 0
    );
  }

  const allowedEntries = new Set([
    manifestName,
    ...manifest.attachments.map((item) => item.path),
    ...retainedAttachments.map((item) => item.path),
    ...(manifest.pageCovers ?? []).map((item) => item.path),
    ...(manifest.customIcons ?? []).map((item) => item.path)
  ]);
  for (const entry of entries) {
    if (!allowedEntries.has(entry.name)) invalidBackup(`Unexpected ZIP entry: ${entry.name}`);
  }
  if (entries.length !== allowedEntries.size) invalidBackup("The ZIP archive is missing one or more declared entries");

  await assertNoForeignIdConflicts(userId, manifest);
  const initialWorkspaceSnapshot = await transaction((client) =>
    createWorkspaceRestoreSnapshot(userId, client, false, restoresCustomIcons)
  );
  await ensureDataTransferDirectories();
  const operationId = createId("restore");
  const restoredAttachmentIds = [
    ...manifest.attachments.map((attachment) => attachment.blockId),
    ...retainedAttachments.map((attachment) => attachment.fileName)
  ];
  const restoredCustomIconFiles = (manifest.customIcons ?? []).map((icon) => icon.fileName);
  const journalSeed: RestoreJournal = restoresCustomIcons
    ? {
      version: 4,
      userId,
      operationId,
      hadPreviousAttachments: false,
      hadPreviousCustomIcons: false,
      restoredAttachmentIds,
      restoredCustomIconFiles
    }
    : {
      version: 3,
      userId,
      operationId,
      hadPreviousAttachments: false,
      restoredAttachmentIds
    };
  const derivedPaths = getRestorePaths(journalSeed);
  const {
    operationRoot,
    stagedAttachmentDir,
    stagedPageCoverDir,
    stagedCustomIconDir,
    oldAttachmentDir,
    targetAttachmentDir,
    oldCustomIconDir,
    targetCustomIconDir,
    journalPath
  } = derivedPaths;
  let journalWritten = false;
  let restoreJournal: RestoreJournal | null = null;
  let restoreSharingPlan: RestoreSharingPlan = { mode: "backup", shares: [] };
  let restoreCollaboratorNavigation: RestoreCollaboratorNavigationPlan = { collapsed: [], order: [] };
  let restoreMutationReceipts: RestoreMutationReceiptPlan = {
    pageVersionResets: [], blockOrders: [], blockCreates: []
  };
  await Promise.all([
    mkdir(stagedAttachmentDir, { recursive: true }),
    mkdir(stagedPageCoverDir, { recursive: true }),
    ...(restoresCustomIcons ? [mkdir(stagedCustomIconDir, { recursive: true })] : [])
  ]);

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
      const block = restoreBlockById.get(attachment.blockId);
      if (!block || block.type !== "ATTACHMENT") invalidBackup(`Attachment block is missing: ${attachment.blockId}`);
      const attachmentInfo = assertLosslessAttachmentMetadata(block.metadata, attachment.size);
      try {
        await inspectStoredAttachmentContent(outputPath, attachmentInfo.mimeType);
      } catch (error) {
        invalidBackup(`Attachment content is not allowed: ${attachment.blockId}`, {
          reason: error instanceof Error ? error.message : "invalid attachment content"
        });
      }
    }
    for (const retained of retainedAttachments) {
      const entry = entryByName.get(retained.path);
      if (!entry) invalidBackup(`Retained attachment entry is missing: ${retained.path}`);
      if (entry.uncompressedSize.toString() !== retained.size || entry.crc32 !== retained.crc32) {
        invalidBackup(`Retained attachment size or CRC does not match: ${retained.fileName}`);
      }
      const outputPath = path.join(stagedAttachmentDir, retained.fileName);
      try {
        await copyZipEntryToFile(zipPath, entry, outputPath);
        await syncPath(outputPath);
      } catch (error) {
        invalidBackup(error instanceof Error ? error.message : `Retained attachment is corrupt: ${retained.fileName}`);
      }
      const inspection = await inspectFile(outputPath);
      if (inspection.sha256 !== retained.sha256 || inspection.size.toString() !== retained.size) {
        invalidBackup(`Retained attachment SHA-256 does not match: ${retained.fileName}`);
      }
      try {
        // Retained files no longer have live metadata, but they still must not
        // be usable as a restore-only executable smuggling channel.
        await inspectStoredAttachmentContent(outputPath, "application/octet-stream");
      } catch (error) {
        invalidBackup(`Retained attachment content is not allowed: ${retained.fileName}`, {
          reason: error instanceof Error ? error.message : "invalid attachment content"
        });
      }
    }
    for (const pageCover of manifest.pageCovers ?? []) {
      const entry = entryByName.get(pageCover.path);
      if (!entry) invalidBackup(`Page cover entry is missing: ${pageCover.path}`);
      if (
        entry.uncompressedSize.toString() !== pageCover.size
        || entry.uncompressedSize > BigInt(maxCustomCoverImageBytes)
        || entry.crc32 !== pageCover.crc32
      ) {
        invalidBackup(`Page cover size or CRC does not match: ${pageCover.pageId}`);
      }
      const outputPath = path.join(stagedPageCoverDir, pageCover.pageId);
      try {
        await copyZipEntryToFile(zipPath, entry, outputPath);
        await syncPath(outputPath);
      } catch (error) {
        invalidBackup(error instanceof Error ? error.message : `Page cover is corrupt: ${pageCover.pageId}`);
      }
      const inspection = await inspectFile(outputPath);
      if (inspection.sha256 !== pageCover.sha256 || inspection.size.toString() !== pageCover.size) {
        invalidBackup(`Page cover SHA-256 does not match: ${pageCover.pageId}`);
      }
      try {
        inspectCustomCoverBytes(pageCover.mimeType, await readFile(outputPath));
      } catch (error) {
        invalidBackup(`Page cover content is invalid: ${pageCover.pageId}`, {
          reason: error instanceof Error ? error.message : "invalid cover"
        });
      }
    }
    for (const customIcon of manifest.customIcons ?? []) {
      const entry = entryByName.get(customIcon.path);
      if (!entry) invalidBackup(`Custom icon entry is missing: ${customIcon.path}`);
      if (
        entry.uncompressedSize.toString() !== customIcon.size
        || entry.uncompressedSize > BigInt(maxCustomIconBytes)
        || entry.crc32 !== customIcon.crc32
      ) {
        invalidBackup(`Custom icon size or CRC does not match: ${customIcon.fileName}`);
      }
      const outputPath = path.join(stagedCustomIconDir, customIcon.fileName);
      try {
        await copyZipEntryToFile(zipPath, entry, outputPath);
        await syncPath(outputPath);
      } catch (error) {
        invalidBackup(error instanceof Error ? error.message : `Custom icon is corrupt: ${customIcon.fileName}`);
      }
      const inspection = await inspectFile(outputPath);
      if (inspection.sha256 !== customIcon.sha256 || inspection.size.toString() !== customIcon.size) {
        invalidBackup(`Custom icon SHA-256 does not match: ${customIcon.fileName}`);
      }
      const fileType = detectCustomIconFileType(await readFile(outputPath));
      if (
        !fileType
        || fileType.mimeType !== customIcon.mimeType
        || fileType.extension !== expectedCustomIconExtension(customIcon.mimeType)
      ) {
        invalidBackup(`Custom icon content is invalid: ${customIcon.fileName}`);
      }
    }
    await writeRestoreGenerationMarker(stagedAttachmentDir, operationId);
    if (restoresCustomIcons) await writeRestoreGenerationMarker(stagedCustomIconDir, operationId);
    await syncPath(operationRoot);

    let movedOldAttachments = false;
    let movedOldCustomIcons = false;
    try {
      await transaction(async (client) => {
        const lockedWorkspaceSnapshot = await createWorkspaceRestoreSnapshot(
          userId,
          client,
          true,
          restoresCustomIcons
        );
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
        restoreCollaboratorNavigation = await prepareRestoreCollaboratorNavigationPlan(
          client,
          userId,
          restoreSharingPlan.shares
        );
        restoreMutationReceipts = await prepareRestoreMutationReceiptPlan(client, userId, manifest);
        // Invalidate every live in-memory Yjs room while the owned page rows are
        // still locked. Otherwise an old owner session can append its pre-restore
        // document after commit and later materialize it over the restored backup.
        for (const pageId of lockedWorkspaceSnapshot.pageIds) {
          disconnectPageCollaborators(pageId, "Workspace data is being restored");
        }

        // The user row lock is shared by attachment and custom-icon writes. Record
        // both live filesystem generations only after acquiring that lock, so any
        // later write either belongs to the previous generation or waits until the
        // restore transaction releases it.
        restoreJournal = restoresCustomIcons
          ? {
            version: 4,
            userId,
            operationId,
            hadPreviousAttachments: await pathExists(targetAttachmentDir),
            hadPreviousCustomIcons: await pathExists(targetCustomIconDir),
            restoredAttachmentIds,
            restoredCustomIconFiles
          }
          : {
            version: 3,
            userId,
            operationId,
            hadPreviousAttachments: await pathExists(targetAttachmentDir),
            restoredAttachmentIds
          };
        await writeRestoreJournal(restoreJournal);
        journalWritten = true;
        const restoreVersion = await createRestoreEditVersion(client, userId, manifest);
        await importRows(
          client,
          userId,
          manifest,
          restoreVersion,
          restoreSharingPlan.shares,
          restoreCollaboratorNavigation,
          restoreMutationReceipts,
          stagedPageCoverDir
        );

        await mkdir(path.dirname(targetAttachmentDir), { recursive: true });
        if (await pathExists(targetAttachmentDir)) {
          await rename(targetAttachmentDir, oldAttachmentDir);
          movedOldAttachments = true;
        }
        await rename(stagedAttachmentDir, targetAttachmentDir);
        await syncPath(attachmentUploadRoot);

        if (restoresCustomIcons) {
          await mkdir(path.dirname(targetCustomIconDir), { recursive: true });
          if (await pathExists(targetCustomIconDir)) {
            await rename(targetCustomIconDir, oldCustomIconDir);
            movedOldCustomIcons = true;
          }
          await rename(stagedCustomIconDir, targetCustomIconDir);
          await syncPath(customIconUploadRoot);
        }
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
        console.error("Data restore commit outcome is unknown; preserving asset generations", {
          userId,
          operationId,
          targetAttachmentDir,
          preservedAttachmentDir: movedOldAttachments ? oldAttachmentDir : null,
          targetCustomIconDir: restoresCustomIcons ? targetCustomIconDir : null,
          preservedCustomIconDir: movedOldCustomIcons ? oldCustomIconDir : null,
          journalPath,
          verificationError
        });
        throw new ApiError(
          500,
          "DATA_RESTORE_OUTCOME_UNKNOWN",
          "The restore outcome could not be verified. Asset generations were preserved for startup recovery."
        );
      }

      const committed = marker?.operation_id === operationId;
      await recoverRestoreJournal(restoreJournal).catch((recoveryError) => {
        console.error("Asset restore reconciliation requires manual recovery", {
          userId,
          operationId,
          committed,
          targetAttachmentDir,
          preservedAttachmentDir: movedOldAttachments ? oldAttachmentDir : null,
          targetCustomIconDir: restoresCustomIcons ? targetCustomIconDir : null,
          preservedCustomIconDir: movedOldCustomIcons ? oldCustomIconDir : null,
          journalPath,
          recoveryError
        });
        throw new ApiError(
          500,
          "DATA_RESTORE_RECOVERY_FAILED",
          "The restore outcome was identified, but asset reconciliation requires manual recovery."
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
        retainedAttachments: retainedAttachments.length,
        pageCovers: manifest.pageCovers?.length ?? 0,
        customIcons: manifest.customIcons?.length ?? 0,
        tags: manifest.data.tags.length,
        shares: restoreSharingPlan.shares.length,
        pageVersions: manifest.data.pageVersions?.length ?? 0,
        navigationCollapsedPages: manifest.data.navigationCollapsedPageIds?.length ?? 0,
      navigationOrderedPages: manifest.data.navigationPageOrder?.length ?? 0
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
