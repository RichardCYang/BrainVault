import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { db, transaction, type DbClient, type DbValue } from "../lib/db.js";
import { assertCurrentAuthSessionBoundary } from "../lib/auth-sessions.js";
import { createId } from "../lib/id.js";
import { env } from "../config/env.js";
import {
  attachmentFileExists,
  attachmentTempDir,
  createAttachmentFileHash,
  ensureAttachmentDirectories,
  getAttachmentFilePath,
  getAttachmentInfo,
  getAttachmentStorageUsage,
  inspectAttachmentUpload,
  lockUserAttachmentGeneration,
  moveAttachmentFile,
  removeDeletedAttachmentFiles,
  removeAttachmentPath,
  withUserAttachmentLock,
  assertAttachmentStorageLimit,
  sanitizeAttachmentDownloadFilename,
  type AttachmentMetadata
} from "../lib/attachments.js";
import { renderBlockHtml } from "../lib/markdown.js";
import { createMutationRequestHash, isMatchingMutationReplay } from "../lib/mutation.js";
import { areEquivalentPersistedValues } from "../lib/block-move-integrity.js";
import {
  assessBlockDeleteMutationReceipt,
  type BlockDeleteMutationReceipt
} from "../lib/block-delete-mutation.js";
import {
  assessBlockCreateMutationReceipt,
  type BlockCreateMutationReceipt
} from "../lib/block-create-mutation.js";
import {
  fetchBookmarkPreviewWithFallback,
  fetchDatabaseUrlPreview,
  getBookmarkData,
  summarizeBookmarkData
} from "../lib/bookmark.js";
import { getAiChatData, summarizeAiChatData } from "../lib/ai-chat.js";
import { getAccordionData, summarizeAccordionData } from "../lib/accordion.js";
import { getTreeViewData, summarizeTreeViewData } from "../lib/treeview.js";
import {
  assertStructuredBlockMetadataIntegrity,
  StructuredMetadataIntegrityError
} from "../lib/structured-metadata-integrity.js";
import { toBlock } from "../lib/mappers.js";
import {
  BlockSortOrderIntegrityError,
  blockSortOrderLimits,
  nextBlockSortOrder
} from "../lib/block-order-integrity.js";
import {
  BlockPreserveChildrenIntegrityError,
  planBlockDeletePreservingChildren
} from "../lib/block-preserve-children.js";
import { assertPageNotArchived, getBlockAccess, getPageAccess, type PageAccess } from "../lib/page-access.js";
import { broadcastCanonicalAttachment } from "../lib/collaboration-server.js";
import { ensureCollaborationState } from "../lib/collaboration-lineage.js";
import {
  diffPageVersionBlocks,
  recordPageVersion,
  toPageVersionActor
} from "../lib/page-version-history.js";
import { ApiError, notFound } from "../lib/http.js";
import { requireAuth, requireRequestAuthScope } from "../middleware/auth.js";
import {
  attachmentUploadConcurrencyLimit,
  attachmentUploadRateLimit,
  beginAttachmentUploadProcessing
} from "../middleware/attachment-rate-limit.js";
import { bookmarkPreviewRateLimit } from "../middleware/bookmark-rate-limit.js";
import { validate } from "../middleware/validate.js";
import { blockTypeSchema, idParamSchema, metadataSchema, requireUser, routeIdSchema, safeVersionSchema } from "../utils/schemas.js";
import type { BlockRow, PageRow } from "../types/domain.js";

export const blockRouter = Router();

blockRouter.use(requireAuth);

const blockSortOrderSchema = z.number().int()
  .min(blockSortOrderLimits.min)
  .max(blockSortOrderLimits.max);
const mutationIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);

const structuredMetadataKeyByBlockType = new Map<BlockRow["type"], string>([
  ["TABLE", "table"],
  ["KANBAN", "kanban"],
  ["DATABASE", "database"],
  ["TREEVIEW", "treeView"],
  ["ACCORDION", "accordion"],
  ["TIMETABLE", "timetable"],
  ["GANTT", "gantt"],
  ["BOOKMARK", "bookmark"],
  ["AI_CHAT", "aiChat"]
]);

const createBlockSchema = z.object({
  type: blockTypeSchema.default("MARKDOWN"),
  markdown: z.string().max(20_000).default(""),
  checked: z.boolean().optional(),
  parentBlockId: z.string().min(1).nullable().optional(),
  sortOrder: blockSortOrderSchema.optional(),
  metadata: metadataSchema,
  basePageContentVersion: safeVersionSchema.optional(),
  mutationId: mutationIdSchema.optional()
});

const updateBlockSchema = z.object({
  type: blockTypeSchema.optional(),
  markdown: z.string().max(20_000).optional(),
  checked: z.boolean().optional(),
  parentBlockId: z.string().min(1).nullable().optional(),
  sortOrder: blockSortOrderSchema.optional(),
  metadata: metadataSchema.nullable().optional(),
  expectedVersion: safeVersionSchema,
  basePageContentVersion: safeVersionSchema.optional(),
  mutationId: mutationIdSchema.optional()
});

const versionSnapshotSchema = z.object({
  id: z.string().min(1).max(64),
  version: safeVersionSchema
});

const deleteBlockSchema = z
  .object({
    expectedVersions: z.array(versionSnapshotSchema).max(10_000).optional(),
    preserveChildren: z.boolean().optional().default(false),
    expectedPageContentVersion: safeVersionSchema.optional(),
    mutationId: mutationIdSchema.optional()
  })
  .superRefine((body, context) => {
    if (body.preserveChildren && body.expectedPageContentVersion === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedPageContentVersion"],
        message: "The current page content version is required when preserving child blocks"
      });
    }
  })
  .default({});

const moveBlockSchema = z.object({
  targetPageId: routeIdSchema,
  expectedVersions: z.array(versionSnapshotSchema).min(1).max(10_000),
  expectedSourcePageContentVersion: safeVersionSchema,
  mutationId: mutationIdSchema
});

type BlockMoveMutationReceipt = {
  block_id: string;
  source_page_id: string;
  target_page_id: string;
  request_hash: string;
  moved_block_ids: string | string[];
  source_page_content_version: number;
  target_page_content_version: number;
};

const bookmarkPreviewSchema = z.object({
  url: z.string().trim().min(1).max(2_048),
  mode: z.enum(["bookmark", "database-url"]).default("bookmark")
});

function assertLosslessStructuredMetadata(type: BlockRow["type"], metadata: unknown) {
  try {
    const validated = assertStructuredBlockMetadataIntegrity(type, metadata);
    return validated === undefined ? metadata : validated;
  } catch (error) {
    if (error instanceof StructuredMetadataIntegrityError) {
      throw new ApiError(
        400,
        "BLOCK_METADATA_WOULD_TRUNCATE",
        "Structured block data exceeds the lossless storage limits. Nothing was saved.",
        { path: error.path, reason: error.message }
      );
    }
    throw error;
  }
}

function assertExistingMetadataSafeToOverwrite(existing: BlockRow) {
  try {
    assertStructuredBlockMetadataIntegrity(existing.type, existing.metadata);
  } catch (error) {
    if (error instanceof StructuredMetadataIntegrityError) {
      throw new ApiError(
        409,
        "BLOCK_METADATA_RECOVERY_REQUIRED",
        "Stored block metadata failed integrity validation. The original data was preserved and must be recovered or repaired explicitly.",
        { path: error.path, reason: error.message }
      );
    }
    throw error;
  }
}

function assertSafeBlockTypeTransition(
  existingType: BlockRow["type"],
  requestedType: BlockRow["type"] | undefined,
  requestedMetadata: unknown
) {
  if (requestedType === undefined || requestedType === existingType) return;

  const metadataKey = structuredMetadataKeyByBlockType.get(requestedType);
  if (!metadataKey) return;

  // Structured editors keep their canonical user data in metadata, and some of
  // them regenerate markdown from that metadata. A type-only PATCH (or an empty
  // metadata envelope) would otherwise reinterpret an existing note through an
  // implicit empty model.
  if (
    !requestedMetadata
    || typeof requestedMetadata !== "object"
    || Array.isArray(requestedMetadata)
    || !Object.prototype.hasOwnProperty.call(requestedMetadata, metadataKey)
    || (requestedMetadata as Record<string, unknown>)[metadataKey] === null
    || (requestedMetadata as Record<string, unknown>)[metadataKey] === undefined
  ) {
    throw new ApiError(
      400,
      "BLOCK_TYPE_METADATA_REQUIRED",
      `Changing a block to ${requestedType} requires explicit ${metadataKey} metadata. Nothing was saved.`
    );
  }
}

function prepareBlockContent(type: BlockRow["type"], markdown: string, metadata: unknown) {
  if (type === "BOOKMARK") {
    return {
      markdown: summarizeBookmarkData(getBookmarkData(metadata)),
      // Never replace the source payload with a display-normalized projection.
      metadata
    };
  }

  if (type === "AI_CHAT") {
    return {
      markdown: summarizeAiChatData(getAiChatData(metadata)),
      // Derived markdown may be bounded; the authoritative metadata must remain exact.
      metadata
    };
  }

  if (type === "ACCORDION") {
    return {
      markdown: summarizeAccordionData(getAccordionData(metadata)),
      metadata
    };
  }

  if (type === "TREEVIEW") {
    return {
      markdown: summarizeTreeViewData(getTreeViewData(metadata)),
      metadata
    };
  }

  return { markdown, metadata };
}

function isDuplicateEntryError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === "ER_DUP_ENTRY" || Number(candidate.errno) === 1062;
}

async function lockBlockCreateUsers(client: DbClient, userIds: string[]) {
  const uniqueIds = [...new Set(userIds)].sort();
  const rows = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE id IN (${uniqueIds.map(() => "?").join(", ")}) ORDER BY id ASC FOR UPDATE`,
    uniqueIds
  );
  if (rows.length !== uniqueIds.length) throw notFound("User");
}

async function reserveBlockCreateMutation(
  client: DbClient,
  input: {
    actorId: string;
    mutationId: string | undefined;
    pageId: string;
    blockId: string;
    requestHash: string | undefined;
  }
): Promise<{ kind: "new" } | { kind: "replay"; block: BlockRow }> {
  if (!input.mutationId || !input.requestHash) return { kind: "new" };

  try {
    await client.execute(
      `INSERT INTO block_create_mutations (actor_id, mutation_id, page_id, block_id, request_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [input.actorId, input.mutationId, input.pageId, input.blockId, input.requestHash]
    );
    return { kind: "new" };
  } catch (error) {
    if (!isDuplicateEntryError(error)) throw error;
  }

  const receipt = await client.queryOne<BlockCreateMutationReceipt>(
    `SELECT page_id, block_id, request_hash
     FROM block_create_mutations
     WHERE actor_id = ? AND mutation_id = ?
     FOR UPDATE`,
    [input.actorId, input.mutationId]
  );
  if (!receipt) {
    throw new ApiError(500, "BLOCK_CREATE_RECEIPT_MISSING", "The block creation receipt is unavailable");
  }

  const assessment = assessBlockCreateMutationReceipt(receipt, {
    pageId: input.pageId,
    requestHash: input.requestHash
  });
  if (assessment.kind === "collision") {
    throw new ApiError(
      409,
      "MUTATION_ID_REUSED",
      "This mutation id was already used for a different block creation request. No additional block was created."
    );
  }
  if (assessment.kind !== "replay") {
    throw new ApiError(500, "BLOCK_CREATE_RECEIPT_MISSING", "The block creation receipt is unavailable");
  }

  const block = await client.queryOne<BlockRow>(
    "SELECT * FROM blocks WHERE id = ? AND page_id = ?",
    [assessment.blockId, input.pageId]
  );
  if (!block) {
    throw new ApiError(
      409,
      "BLOCK_CREATE_REPLAY_UNAVAILABLE",
      "This block creation was already completed, but the created block is no longer available. No additional block was created."
    );
  }
  return { kind: "replay", block };
}

const reorderSchema = z.object({
  mutationId: mutationIdSchema.optional(),
  items: z
    .array(
      z.object({
        id: routeIdSchema,
        sortOrder: blockSortOrderSchema,
        parentBlockId: routeIdSchema.nullable().optional(),
        expectedVersion: safeVersionSchema
      })
    )
    .min(1)
    .max(500)
});

const attachmentFormSchema = z.object({
  parentBlockId: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value.trim() : null),
    z.string().min(1).nullable()
  ),
  sortOrder: z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : Number(value)),
    blockSortOrderSchema.optional()
  ),
  basePageContentVersion: z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : Number(value)),
    safeVersionSchema.optional()
  ),
  mutationId: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined),
    mutationIdSchema.optional()
  )
});

const maxAttachmentUploadBytes = env.MAX_ATTACHMENT_SIZE_MB * 1024 * 1024;
const maxAttachmentMultipartOverheadBytes = 1024 * 1024;

function enforceAttachmentUploadRequestSize(req: Request, _res: Response, next: NextFunction) {
  const rawContentLength = req.headers["content-length"];
  if (rawContentLength === undefined) {
    next();
    return;
  }
  const contentLength = Number(rawContentLength);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    next(new ApiError(400, "INVALID_CONTENT_LENGTH", "Content-Length is invalid"));
    return;
  }
  if (contentLength > maxAttachmentUploadBytes + maxAttachmentMultipartOverheadBytes) {
    next(new ApiError(413, "ATTACHMENT_TOO_LARGE", "Attachment exceeds the configured size limit"));
    return;
  }
  next();
}

const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      ensureAttachmentDirectories()
        .then(() => callback(null, attachmentTempDir))
        .catch((error) => callback(error, attachmentTempDir));
    },
    filename: (_req, _file, callback) => callback(null, createId("upload"))
  }),
  limits: {
    fileSize: maxAttachmentUploadBytes,
    files: 1,
    fields: 5,
    parts: 7,
    fieldNameSize: 64,
    fieldSize: 16 * 1024,
    headerPairs: 32,
    fieldNestingDepth: 1
  },
  preservePath: false,
  defParamCharset: "utf8"
});

blockRouter.post(
  "/bookmarks/preview",
  bookmarkPreviewRateLimit,
  validate({ body: bookmarkPreviewSchema }),
  async (req, res, next) => {
    try {
      if (req.body.mode === "database-url") {
        const preview = await fetchDatabaseUrlPreview(String(req.body.url));
        res.json({ preview });
        return;
      }
      const result = await fetchBookmarkPreviewWithFallback(String(req.body.url));
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

function getNextBlockSortOrder(lastSortOrder: number | null | undefined) {
  try {
    return nextBlockSortOrder(lastSortOrder);
  } catch (error) {
    if (error instanceof BlockSortOrderIntegrityError) {
      throw new ApiError(
        409,
        "BLOCK_ORDER_RANGE_EXHAUSTED",
        "The block list cannot accept another automatically positioned block until it is reordered. Nothing was saved.",
        { reason: error.code, sortOrder: error.value }
      );
    }
    throw error;
  }
}

async function getCollisionFreeBlockCreateSortOrder(
  client: DbClient,
  pageId: string,
  parentBlockId: string | null | undefined,
  requestedSortOrder: number | undefined
) {
  if (requestedSortOrder !== undefined) {
    const collision = await client.queryOne<{ id: string }>(
      `SELECT id FROM blocks
       WHERE page_id = ? AND parent_block_id <=> ? AND sort_order = ?
       LIMIT 1`,
      [pageId, parentBlockId ?? null, requestedSortOrder]
    );
    if (!collision) return requestedSortOrder;
  }

  // Block creation is a sparse mutation: it must never manufacture duplicate
  // sibling positions while waiting for the caller's complete reorder snapshot.
  // If the requested slot is occupied, append without changing existing sibling
  // edit versions; the reorder endpoint can then apply the intended full order.
  const lastBlock = await client.queryOne<{ sort_order: number }>(
    "SELECT sort_order FROM blocks WHERE page_id = ? AND parent_block_id <=> ? ORDER BY sort_order DESC LIMIT 1",
    [pageId, parentBlockId ?? null]
  );
  return getNextBlockSortOrder(lastBlock?.sort_order);
}

async function assertAccessiblePage(pageId: string, userId: string, client: DbClient = db) {
  return getPageAccess(pageId, userId, client);
}

async function assertAccessibleBlock(blockId: string, userId: string, client: DbClient = db) {
  return getBlockAccess(blockId, userId, client);
}

type PageMutationAdmission = Readonly<{
  ownerId: string;
  ownerWorkspaceGeneration: number;
  actorShareGeneration: string | null;
  isArchived: boolean;
}>;

async function capturePageMutationAdmission(pageId: string, userId: string): Promise<PageMutationAdmission> {
  const row = await db.queryOne<{
    owner_id: string;
    attachment_generation: number | bigint | string;
    access_share_generation: string | null;
    is_archived: number | boolean;
  }>(
    `SELECT p.owner_id, u.attachment_generation, p.is_archived,
            CASE WHEN p.owner_id = ? THEN NULL ELSE ps.generation END AS access_share_generation
     FROM pages p
     INNER JOIN users u ON u.id = p.owner_id
     LEFT JOIN page_shares ps
       ON ps.page_id = p.id
      AND ps.user_id = ?
      AND ps.permission = 'EDIT'
     WHERE p.id = ?
       AND (p.owner_id = ? OR ps.user_id IS NOT NULL)`,
    [userId, userId, pageId, userId]
  );
  if (!row) throw notFound("Page");

  const ownerWorkspaceGeneration = Number(row.attachment_generation);
  if (!Number.isSafeInteger(ownerWorkspaceGeneration) || ownerWorkspaceGeneration < 1) {
    throw new Error(`Invalid workspace generation for page owner: ${row.owner_id}`);
  }
  const actorShareGeneration = row.owner_id === userId ? null : row.access_share_generation;
  if (row.owner_id !== userId && !actorShareGeneration) {
    throw new Error(`Missing collaborator share generation for page: ${pageId}`);
  }
  return Object.freeze({
    ownerId: row.owner_id,
    ownerWorkspaceGeneration,
    actorShareGeneration,
    isArchived: Boolean(row.is_archived)
  });
}

function assertPageOwnerWorkspaceGeneration(expected: number, current: number) {
  if (current === expected) return;
  throw new ApiError(
    409,
    "WORKSPACE_RESTORED",
    "The page owner's workspace was restored while this request was in progress. Refresh before retrying."
  );
}

function assertDirectBlockMutationAllowed(access: Pick<PageAccess, "shareCount">) {
  if (access.shareCount > 0) {
    throw new ApiError(
      409,
      "COLLABORATION_REQUIRED",
      "This shared page must be edited through its real-time collaboration session"
    );
  }
}

type AttachmentUploadTarget = Readonly<{
  actorId: string;
  pageId: string;
  ownerId: string;
  ownerWorkspaceGeneration: number;
  actorShareGeneration: string | null;
}>;

async function authorizeAttachmentUploadTarget(req: Request, res: Response, next: NextFunction) {
  try {
    const user = requireUser(req.user);
    const pageId = String(req.params.pageId);
    const admission = await capturePageMutationAdmission(pageId, user.id);
    if (admission.isArchived) {
      throw new ApiError(409, "PAGE_ARCHIVED", "Restore the page before adding an attachment");
    }
    res.locals.attachmentUploadTarget = Object.freeze({
      actorId: user.id,
      pageId,
      ownerId: admission.ownerId,
      ownerWorkspaceGeneration: admission.ownerWorkspaceGeneration,
      actorShareGeneration: admission.actorShareGeneration
    } satisfies AttachmentUploadTarget);
    next();
  } catch (error) {
    next(error);
  }
}

function requireAttachmentUploadTarget(res: Response, actorId: string, pageId: string) {
  const target = res.locals.attachmentUploadTarget as AttachmentUploadTarget | undefined;
  if (!target || target.actorId !== actorId || target.pageId !== pageId || !target.ownerId) {
    throw new ApiError(500, "ATTACHMENT_UPLOAD_TARGET_MISSING", "Attachment upload authorization is unavailable");
  }
  return target;
}

async function advancePageContentVersion(client: DbClient, pageId: string, ownerId: string) {
  const result = await client.execute<{ affectedRows: number }>(
    "UPDATE pages SET content_version = content_version + 1 WHERE id = ? AND owner_id = ?",
    [pageId, ownerId]
  );
  if (Number(result.affectedRows) !== 1) throw notFound("Page");
  const page = await client.queryOne<PageRow>(
    "SELECT * FROM pages WHERE id = ? AND owner_id = ?",
    [pageId, ownerId]
  );
  if (!page) throw notFound("Page");
  return Number(page.content_version ?? 1);
}

function partialMutationVersionPayload(pageContentVersion: number, authoritative: boolean) {
  return {
    // Omit the global token unless this response proves that the caller's full
    // page snapshot was current. Older clients then fail conservatively too:
    // Number(undefined) is not applied by applyPageContentVersion().
    pageContentVersion: authoritative ? pageContentVersion : undefined,
    pageContentVersionAuthoritative: authoritative
  };
}

function isAuthoritativePartialMutationReplay(basePageContentVersion: number | undefined, currentVersion: number) {
  return basePageContentVersion !== undefined && currentVersion === basePageContentVersion + 1;
}

async function assertParentBlock(parentBlockId: string | null | undefined, pageId: string, client: DbClient = db) {
  if (!parentBlockId) return;
  const parent = await client.queryOne("SELECT id FROM blocks WHERE id = ? AND page_id = ?", [parentBlockId, pageId]);
  if (!parent) throw new ApiError(400, "INVALID_PARENT_BLOCK", "Parent block must exist on the same page");
}

function assertReorderDoesNotCreateCycle(
  rows: Array<{ id: string; parent_block_id: string | null }>,
  items: Array<{ id: string; parentBlockId?: string | null }>
) {
  const parentById = new Map(rows.map((row) => [row.id, row.parent_block_id]));
  for (const item of items) {
    if (item.parentBlockId !== undefined) parentById.set(item.id, item.parentBlockId);
  }
  for (const startId of parentById.keys()) {
    const path = new Set<string>();
    let currentId: string | null | undefined = startId;
    while (currentId) {
      if (path.has(currentId)) {
        throw new ApiError(400, "INVALID_PARENT_BLOCK", "Block hierarchy cannot contain a cycle");
      }
      path.add(currentId);
      currentId = parentById.get(currentId);
    }
  }
}

function collectBlockSubtreeRows<T extends { id: string; parent_block_id: string | null }>(
  rootBlockId: string,
  rows: T[]
) {
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parent_block_id) continue;
    const group = children.get(row.parent_block_id) ?? [];
    group.push(row.id);
    children.set(row.parent_block_id, group);
  }

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const pending = [rootBlockId];
  const subtreeRows: T[] = [];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const row = rowById.get(id);
    if (row) subtreeRows.push(row);
    pending.push(...(children.get(id) ?? []));
  }
  return subtreeRows;
}

async function getBlockSubtreeRows(rootBlockId: string, pageId: string, client: DbClient = db, lock = false) {
  const rows = await client.query<{
    id: string;
    parent_block_id: string | null;
    type: string;
    edit_version: number;
  }>(
    `SELECT id, parent_block_id, type, edit_version FROM blocks WHERE page_id = ?${lock ? " FOR UPDATE" : ""}`,
    [pageId]
  );
  return collectBlockSubtreeRows(rootBlockId, rows);
}

async function promoteBlockChildrenBeforeDelete(
  client: DbClient,
  target: BlockRow,
  hierarchyRows: BlockRow[]
) {
  let plan;
  try {
    plan = planBlockDeletePreservingChildren(target.id, hierarchyRows);
  } catch (error) {
    if (error instanceof BlockPreserveChildrenIntegrityError) {
      throw new ApiError(409, "BLOCK_EDIT_CONFLICT", `${error.message}. Nothing was deleted.`);
    }
    throw error;
  }

  const rowById = new Map(hierarchyRows.map((row) => [row.id, row]));
  for (const update of plan.updates) {
    const row = rowById.get(update.id);
    if (!row) {
      throw new ApiError(409, "BLOCK_EDIT_CONFLICT", "The block hierarchy changed. Nothing was deleted.");
    }
    const result = await client.execute<{ affectedRows: number }>(
      `UPDATE blocks
       SET parent_block_id = ?, sort_order = ?, last_mutation_id = NULL,
           last_mutation_hash = NULL, edit_version = edit_version + 1
       WHERE id = ? AND page_id = ? AND edit_version = ?`,
      [update.parentBlockId, update.sortOrder, row.id, row.page_id, Number(row.edit_version ?? 1)]
    );
    if (Number(result.affectedRows) !== 1) {
      throw new ApiError(
        409,
        "BLOCK_EDIT_CONFLICT",
        "The block hierarchy changed in another session. Nothing was deleted."
      );
    }
  }
}

function assertBlockVersionSnapshot(
  rows: Array<{ id: string; edit_version?: number }>,
  expectedVersions: Array<{ id: string; version: number }>,
  message = "This block subtree changed in another session. It was not deleted."
) {

  const expectedById = new Map(expectedVersions.map((item) => [item.id, item.version]));
  const currentById = new Map(rows.map((item) => [item.id, Number(item.edit_version ?? 1)]));
  const exactSnapshot =
    expectedById.size === expectedVersions.length &&
    expectedById.size === rows.length &&
    rows.every((row) => expectedById.get(row.id) === currentById.get(row.id));

  if (!exactSnapshot) {
    throw new ApiError(
      409,
      "BLOCK_EDIT_CONFLICT",
      message
    );
  }
}

function parseMovedBlockIds(value: unknown) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new ApiError(
        500,
        "BLOCK_MOVE_RECEIPT_INCOMPLETE",
        "The block move receipt is incomplete. The move was not repeated."
      );
    }
  }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.some((id) => typeof id !== "string" || !routeIdSchema.safeParse(id).success)
    || new Set(parsed).size !== parsed.length
  ) {
    throw new ApiError(
      500,
      "BLOCK_MOVE_RECEIPT_INCOMPLETE",
      "The block move receipt is incomplete. The move was not repeated."
    );
  }
  return parsed as string[];
}

function comparableBlockMetadata(value: BlockRow["metadata"]) {
  if (typeof value !== "string") return JSON.stringify(value ?? null);
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function assertMovedBlockDataPreserved(
  beforeRows: BlockRow[],
  afterRows: BlockRow[],
  rootBlockId: string,
  targetPageId: string,
  targetRootSortOrder: number
) {
  if (beforeRows.length !== afterRows.length) {
    throw new ApiError(
      500,
      "BLOCK_MOVE_INTEGRITY_FAILED",
      "The block move failed its integrity check. No block was moved."
    );
  }

  const beforeById = new Map(beforeRows.map((row) => [row.id, row]));
  const afterById = new Map(afterRows.map((row) => [row.id, row]));
  const contentFields = ["type", "markdown", "html_cache", "checked", "created_at"] as const;

  for (const [id, before] of beforeById) {
    const after = afterById.get(id);
    const expectedParentId = id === rootBlockId ? null : before.parent_block_id;
    const expectedSortOrder = id === rootBlockId ? targetRootSortOrder : before.sort_order;
    const preserved =
      Boolean(after)
      && after!.page_id === targetPageId
      && after!.parent_block_id === expectedParentId
      && Number(after!.sort_order) === Number(expectedSortOrder)
      && Number(after!.edit_version ?? 1) === Number(before.edit_version ?? 1) + 1
      && comparableBlockMetadata(after!.metadata) === comparableBlockMetadata(before.metadata)
      && contentFields.every((field) => areEquivalentPersistedValues(after![field], before[field]));

    if (!preserved) {
      throw new ApiError(
        500,
        "BLOCK_MOVE_INTEGRITY_FAILED",
        "The block move failed its integrity check. No block was moved."
      );
    }
  }
}

async function lockMovePages(
  client: DbClient,
  userId: string,
  sourcePageId: string,
  targetPageId: string
) {
  const accessById = new Map<string, PageAccess>();
  for (const pageId of [sourcePageId, targetPageId].sort()) {
    accessById.set(pageId, await getPageAccess(pageId, userId, client, { lockPage: true }));
  }
  return {
    sourceAccess: accessById.get(sourcePageId)!,
    targetAccess: accessById.get(targetPageId)!
  };
}

blockRouter.post(
  "/pages/:pageId/attachments",
  validate({ params: idParamSchema }),
  attachmentUploadRateLimit,
  enforceAttachmentUploadRequestSize,
  authorizeAttachmentUploadTarget,
  attachmentUploadConcurrencyLimit,
  attachmentUpload.single("file"),
  async (req, res, next) => {
    let cleanupPath = req.file?.path ?? null;
    let movedPath: string | null = null;
    let movedAttachmentGeneration: number | null = null;
    let releaseAttachmentUpload: (() => void) | null = null;
    try {
      releaseAttachmentUpload = beginAttachmentUploadProcessing(res);
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const pageId = String(req.params.pageId);
      const target = requireAttachmentUploadTarget(res, user.id, pageId);
      const file = req.file;
      if (!file) throw new ApiError(400, "ATTACHMENT_FILE_REQUIRED", "Select a file to attach");

      const body = attachmentFormSchema.parse(req.body);
      const ownerId = target.ownerId;
      const id = createId("blk");
      const [inspectedUpload, fileHash] = await Promise.all([
        inspectAttachmentUpload(file.path, file.originalname, file.mimetype),
        createAttachmentFileHash(file.path)
      ]);
      const originalName = inspectedUpload.originalName;
      const metadata: AttachmentMetadata = {
        attachment: {
          originalName,
          mimeType: inspectedUpload.mimeType,
          size: file.size
        }
      };
      const mutationHash = body.mutationId
        ? createMutationRequestHash({
            kind: "ATTACHMENT",
            pageId,
            parentBlockId: body.parentBlockId,
            sortOrder: body.sortOrder,
            basePageContentVersion: body.basePageContentVersion,
            file: {
              originalName,
              mimeType: inspectedUpload.mimeType,
              size: file.size,
              sha256: fileHash
            }
          })
        : undefined;

      let collaborationDocumentEpochAtWrite: string | null = null;
      let result: {
        block: BlockRow;
        pageContentVersion: number | undefined;
        pageContentVersionAuthoritative: boolean;
      } | null = null;
      try {
        result = await transaction(async (client) => {
          // Lock every user row before the page. This preserves the workspace
          // snapshot lock order while the receipt's actor FK is reserved.
          await lockBlockCreateUsers(client, [user.id, ownerId]);
          await assertCurrentAuthSessionBoundary(user.id, authScope, client);
          const attachmentGeneration = await lockUserAttachmentGeneration(client, ownerId);
          if (attachmentGeneration === undefined) throw notFound("User");
          assertPageOwnerWorkspaceGeneration(target.ownerWorkspaceGeneration, attachmentGeneration);

          const lockedAccess = await getPageAccess(pageId, user.id, client, { lockPage: true });
          if (lockedAccess.page.owner_id !== ownerId) {
            throw new ApiError(409, "PAGE_OWNER_CHANGED", "The page owner changed while the attachment was uploading");
          }
          if (lockedAccess.shareGeneration !== target.actorShareGeneration) {
            throw new ApiError(
              409,
              "PAGE_SHARE_GENERATION_CHANGED",
              "The collaborator grant changed while this attachment was uploading. Refresh before retrying."
            );
          }
          const lockedContentVersion = Number(lockedAccess.page.content_version ?? 1);
          const reservation = await reserveBlockCreateMutation(client, {
            actorId: user.id,
            mutationId: body.mutationId,
            pageId,
            blockId: id,
            requestHash: mutationHash
          });
          collaborationDocumentEpochAtWrite = lockedAccess.shareCount > 0
            ? (await ensureCollaborationState(pageId, client)).document_epoch
            : null;
          if (reservation.kind === "replay") {
            return {
              block: reservation.block,
              ...partialMutationVersionPayload(
                lockedContentVersion,
                isAuthoritativePartialMutationReplay(body.basePageContentVersion, lockedContentVersion)
              )
            };
          }

          // Canonical attachment creation is intentionally allowed while shared:
          // Yjs materialization refuses to mint attachment rows itself and adopts
          // this server-validated binary row into the active collaboration document.
          if (lockedAccess.page.is_archived) {
            throw new ApiError(409, "PAGE_ARCHIVED", "Restore the page before adding an attachment");
          }
          await assertParentBlock(body.parentBlockId, pageId, client);
          const currentAttachmentUsage = await getAttachmentStorageUsage(ownerId);
          assertAttachmentStorageLimit(
            currentAttachmentUsage.bytes,
            BigInt(file.size),
            currentAttachmentUsage.files,
            1
          );
          const createSortOrder = await getCollisionFreeBlockCreateSortOrder(
            client,
            pageId,
            body.parentBlockId,
            body.sortOrder
          );
          movedPath = await moveAttachmentFile(file.path, ownerId, id);
          movedAttachmentGeneration = attachmentGeneration;
          cleanupPath = null;
          await client.execute(
            `INSERT INTO blocks (id, page_id, parent_block_id, type, markdown, html_cache, checked, sort_order, metadata)
             VALUES (?, ?, ?, 'ATTACHMENT', ?, ?, 0, ?, ?)`,
            [
              id,
              pageId,
              body.parentBlockId,
              originalName,
              renderBlockHtml("ATTACHMENT", originalName, false, metadata),
              createSortOrder,
              JSON.stringify(metadata)
            ]
          );
          const pageContentVersion = await advancePageContentVersion(client, pageId, ownerId);
          const createdBlock = await client.queryOne<BlockRow>("SELECT * FROM blocks WHERE id = ?", [id]);
          if (!createdBlock) throw new ApiError(500, "BLOCK_CREATE_FAILED", "Attachment block was not created");
          await recordPageVersion(client, {
            pageId,
            actors: [toPageVersionActor(user)],
            source: "ATTACHMENT_CREATE",
            changes: diffPageVersionBlocks([], [createdBlock])
          });
          return {
            block: createdBlock,
            ...partialMutationVersionPayload(
              pageContentVersion,
              body.basePageContentVersion !== undefined && body.basePageContentVersion === lockedContentVersion
            )
          };
        });
        movedPath = null;
      } catch (error) {
        const commitOutcomeUnknown = Boolean(
          error && typeof error === "object" && "commitOutcomeUnknown" in error && error.commitOutcomeUnknown === true
        );

        if (commitOutcomeUnknown) {
          try {
            const confirmedBlock = await withUserAttachmentLock(
              ownerId,
              async (client, currentAttachmentGeneration) => {
                if (
                  movedAttachmentGeneration === null
                  || currentAttachmentGeneration !== movedAttachmentGeneration
                ) {
                  return null;
                }
                return client.queryOne<BlockRow & { page_content_version: number | bigint | string }>(
                  `SELECT b.*, p.content_version AS page_content_version
                   FROM blocks b
                   INNER JOIN pages p ON p.id = b.page_id
                   WHERE b.id = ? AND b.page_id = ? AND p.owner_id = ?`,
                  [id, pageId, ownerId]
                );
              }
            );
            if (confirmedBlock) {
              const confirmedContentVersion = Number(confirmedBlock.page_content_version);
              if (!Number.isSafeInteger(confirmedContentVersion) || confirmedContentVersion < 1) {
                throw new Error(`Invalid page content version during attachment commit verification: ${pageId}`);
              }
              result = {
                block: confirmedBlock,
                ...partialMutationVersionPayload(
                  confirmedContentVersion,
                  isAuthoritativePartialMutationReplay(body.basePageContentVersion, confirmedContentVersion)
                )
              };
              movedPath = null;
            } else {
              console.error("Attachment commit outcome is unknown; preserving the moved file", {
                id,
                movedPath,
                errorName: error instanceof Error ? error.name : typeof error,
                errorCode: typeof error === "object" && error !== null && "code" in error ? String(error.code) : null
              });
              throw error;
            }
          } catch (verificationError) {
            if (verificationError === error) throw error;
            console.error("Attachment commit verification failed; preserving the moved file", {
              id,
              movedPath,
              errorName: verificationError instanceof Error ? verificationError.name : typeof verificationError,
              errorCode: typeof verificationError === "object" && verificationError !== null && "code" in verificationError
                ? String(verificationError.code)
                : null
            });
            throw error;
          }
        } else {
          let insertDefinitelyFailed = false;
          try {
            insertDefinitelyFailed = !(await db.queryOne<{ id: string }>(
              `SELECT b.id
               FROM blocks b
               INNER JOIN pages p ON p.id = b.page_id
               WHERE b.id = ? AND b.page_id = ? AND p.owner_id = ?`,
              [id, pageId, ownerId]
            ));
          } catch (verificationError) {
            console.error("Attachment insert outcome is unknown; preserving the moved file", {
              id,
              movedPath,
              errorName: verificationError instanceof Error ? verificationError.name : typeof verificationError,
              errorCode: typeof verificationError === "object" && verificationError !== null && "code" in verificationError
                ? String(verificationError.code)
                : null
            });
          }
          if (insertDefinitelyFailed && movedPath && movedAttachmentGeneration !== null) {
            const failedMovedPath = movedPath;
            const expectedAttachmentGeneration = movedAttachmentGeneration;
            await withUserAttachmentLock(ownerId, async (_client, currentAttachmentGeneration) => {
              // If restore replaced the owner's attachment directory after the
              // failed INSERT released its lock, this path now belongs to the
              // restored generation and must not be removed as upload rollback.
              if (currentAttachmentGeneration !== expectedAttachmentGeneration) return;
              await removeAttachmentPath(failedMovedPath);
            });
            movedPath = null;
          }
          throw error;
        }
      }

      if (!result) throw new ApiError(500, "BLOCK_CREATE_FAILED", "Attachment block was not created");
      if (cleanupPath) {
        await removeAttachmentPath(cleanupPath);
        cleanupPath = null;
      }
      const payload = toBlock(result.block);
      if (collaborationDocumentEpochAtWrite) {
        await broadcastCanonicalAttachment(pageId, collaborationDocumentEpochAtWrite, payload);
      }
      res.status(201).json({
        block: payload,
        pageContentVersion: result.pageContentVersion,
        pageContentVersionAuthoritative: result.pageContentVersionAuthoritative
      });
    } catch (error) {
      if (cleanupPath) await removeAttachmentPath(cleanupPath);
      if (movedPath) {
        console.error("Preserving an attachment file because the database write outcome is unknown", { movedPath });
      }
      next(error);
    } finally {
      releaseAttachmentUpload?.();
    }
  }
);

blockRouter.get("/blocks/:blockId/attachment", validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const blockId = String(req.params.blockId);
    const initial = await assertAccessibleBlock(blockId, user.id);
    if (initial.block.type !== "ATTACHMENT") throw notFound("Attachment");
    const ownerId = initial.access.page.owner_id;

    // Workspace restore swaps the owner's complete attachment directory while
    // holding this same user-row lock. Revalidate access after taking the lock
    // and hold it through streaming so an old shared generation can never open
    // or continue into a restored private file that reused the same block id.
    await withUserAttachmentLock(ownerId, async (client) => {
      const { block, access } = await assertAccessibleBlock(blockId, user.id, client);
      if (access.page.owner_id !== ownerId || block.type !== "ATTACHMENT") throw notFound("Attachment");

      const info = getAttachmentInfo(toBlock(block).metadata);
      if (!info || !(await attachmentFileExists(ownerId, blockId))) throw notFound("Attachment file");

      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Type", info.mimeType);
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
      await new Promise<void>((resolve, reject) => {
        res.download(
          getAttachmentFilePath(ownerId, blockId),
          sanitizeAttachmentDownloadFilename(info.originalName),
          (error) => error ? reject(error) : resolve()
        );
      });
    });
  } catch (error) {
    if (!res.headersSent) next(error);
    else console.error("Attachment download failed", {
      blockId: String(req.params.blockId),
      errorName: error instanceof Error ? error.name : "UnknownError"
    });
  }
});

blockRouter.post("/pages/:pageId/blocks", validate({ params: idParamSchema, body: createBlockSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const authScope = requireRequestAuthScope(req);
    const pageId = String(req.params.pageId);
    const body = req.body as z.infer<typeof createBlockSchema>;
    const { mutationId, basePageContentVersion, ...creation } = body;

    if (creation.type === "ATTACHMENT") {
      throw new ApiError(400, "USE_ATTACHMENT_UPLOAD", "Create attachment blocks through the file upload endpoint");
    }

    const access = await assertAccessiblePage(pageId, user.id);
    const ownerId = access.page.owner_id;
    const id = createId("blk");
    const mutationHash = mutationId
      ? createMutationRequestHash({ kind: "BLOCK", pageId, basePageContentVersion, creation })
      : undefined;
    const losslessMetadata = assertLosslessStructuredMetadata(creation.type, creation.metadata);
    const prepared = prepareBlockContent(creation.type, creation.markdown, losslessMetadata);
    const result = await transaction(async (client) => {
      await lockBlockCreateUsers(client, [user.id, ownerId]);
      await assertCurrentAuthSessionBoundary(user.id, authScope, client);
      const lockedAccess = await getPageAccess(pageId, user.id, client, { lockPage: true });
      if (lockedAccess.page.owner_id !== ownerId) {
        throw new ApiError(409, "PAGE_OWNER_CHANGED", "The page owner changed while the block was being created");
      }
      const lockedContentVersion = Number(lockedAccess.page.content_version ?? 1);
      const reservation = await reserveBlockCreateMutation(client, {
        actorId: user.id,
        mutationId,
        pageId,
        blockId: id,
        requestHash: mutationHash
      });
      if (reservation.kind === "replay") {
        return {
          block: reservation.block,
          ...partialMutationVersionPayload(
            lockedContentVersion,
            isAuthoritativePartialMutationReplay(basePageContentVersion, lockedContentVersion)
          )
        };
      }

      assertDirectBlockMutationAllowed(lockedAccess);
      assertPageNotArchived(lockedAccess.page);
      await assertParentBlock(creation.parentBlockId, pageId, client);
      const createSortOrder = await getCollisionFreeBlockCreateSortOrder(
        client,
        pageId,
        creation.parentBlockId,
        creation.sortOrder
      );
      await client.execute(
        `INSERT INTO blocks (id, page_id, parent_block_id, type, markdown, html_cache, checked, sort_order, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          pageId,
          creation.parentBlockId ?? null,
          creation.type,
          prepared.markdown,
          renderBlockHtml(creation.type, prepared.markdown, Boolean(creation.checked), prepared.metadata),
          creation.checked ? 1 : 0,
          createSortOrder,
          prepared.metadata ? JSON.stringify(prepared.metadata) : null
        ]
      );
      const pageContentVersion = await advancePageContentVersion(client, pageId, ownerId);
      const block = await client.queryOne<BlockRow>("SELECT * FROM blocks WHERE id = ?", [id]);
      if (!block) throw new ApiError(500, "BLOCK_CREATE_FAILED", "Block was not created");
      await recordPageVersion(client, {
        pageId,
        actors: [toPageVersionActor(user)],
        source: "BLOCK_CREATE",
        changes: diffPageVersionBlocks([], [block])
      });
      return {
        block,
        ...partialMutationVersionPayload(
          pageContentVersion,
          basePageContentVersion !== undefined && basePageContentVersion === lockedContentVersion
        )
      };
    });

    res.status(201).json({
      block: toBlock(result.block),
      pageContentVersion: result.pageContentVersion,
      pageContentVersionAuthoritative: result.pageContentVersionAuthoritative
    });
  } catch (error) {
    next(error);
  }
});

blockRouter.patch("/blocks/:blockId", validate({ params: idParamSchema, body: updateBlockSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const authScope = requireRequestAuthScope(req);
    const blockId = String(req.params.blockId);
    const body = req.body as z.infer<typeof updateBlockSchema>;
    const { mutationId, basePageContentVersion, ...mutationPayload } = body;
    const mutationHash = mutationId
      ? createMutationRequestHash({ basePageContentVersion, ...mutationPayload })
      : undefined;

    const result = await transaction(async (client) => {
      await assertCurrentAuthSessionBoundary(user.id, authScope, client);
      const hierarchyChanged = body.parentBlockId !== undefined || body.sortOrder !== undefined;
      const { block: identity } = await assertAccessibleBlock(blockId, user.id, client);
      const lockedAccess = await getPageAccess(identity.page_id, user.id, client, { lockPage: true });
      const lockedPage = lockedAccess.page;
      let existing: BlockRow;
      let hierarchyRows: BlockRow[] | null = null;

      if (hierarchyChanged) {
        hierarchyRows = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY id ASC FOR UPDATE",
          [identity.page_id]
        );
        const rowById = new Map(hierarchyRows.map((row) => [row.id, row]));
        const lockedBlock = rowById.get(blockId);
        if (!lockedBlock) throw notFound("Block");
        existing = lockedBlock;

        if (body.parentBlockId && !rowById.has(body.parentBlockId)) {
          throw new ApiError(400, "INVALID_PARENT_BLOCK", "Parent block must exist on the same page");
        }
        if (body.parentBlockId === blockId) {
          throw new ApiError(400, "INVALID_PARENT_BLOCK", "A block cannot be its own parent");
        }
        if (body.parentBlockId !== undefined) {
          assertReorderDoesNotCreateCycle(hierarchyRows, [{ id: blockId, parentBlockId: body.parentBlockId }]);
        }
      } else {
        const lockedBlock = await client.queryOne<BlockRow>(
          "SELECT * FROM blocks WHERE id = ? AND page_id = ? FOR UPDATE",
          [blockId, identity.page_id]
        );
        if (!lockedBlock) throw notFound("Block");
        existing = lockedBlock;
      }

      if (
        isMatchingMutationReplay(
          existing.last_mutation_id,
          existing.last_mutation_hash,
          mutationId,
          mutationHash
        )
      ) {
        const currentContentVersion = Number(lockedPage.content_version ?? 1);
        return {
          block: existing,
          ...partialMutationVersionPayload(
            currentContentVersion,
            isAuthoritativePartialMutationReplay(basePageContentVersion, currentContentVersion)
          )
        };
      }

      // An exact response-loss replay is read-only. Resolve it before enforcing
      // the current shared-page write path so a mutation committed while the
      // page was private remains replayable after sharing is enabled.
      assertDirectBlockMutationAllowed(lockedAccess);
      assertPageNotArchived(lockedPage);

      if (Number(existing.edit_version ?? 1) !== body.expectedVersion) {
        throw new ApiError(
          409,
          "BLOCK_EDIT_CONFLICT",
          "This block was changed in another session. Your local edits were not overwritten."
        );
      }

      if (body.type === "ATTACHMENT" && existing.type !== "ATTACHMENT") {
        throw new ApiError(400, "USE_ATTACHMENT_UPLOAD", "Create attachment blocks through the file upload endpoint");
      }
      if (existing.type === "ATTACHMENT") {
        if (body.type !== undefined && body.type !== "ATTACHMENT") {
          throw new ApiError(400, "ATTACHMENT_TYPE_IMMUTABLE", "Attachment blocks cannot be converted to another type");
        }
        if (body.type !== undefined || body.markdown !== undefined || body.checked !== undefined || body.metadata !== undefined) {
          throw new ApiError(400, "ATTACHMENT_READ_ONLY", "Attachment block content is read-only");
        }
      }

      assertSafeBlockTypeTransition(existing.type, body.type, body.metadata);

      const lockedContentVersion = Number(lockedPage.content_version ?? 1);
      if (hierarchyChanged) {
        if (basePageContentVersion === undefined) {
          throw new ApiError(
            400,
            "BLOCK_HIERARCHY_VERSION_REQUIRED",
            "Changing a block's hierarchy requires the page content version from the complete sibling snapshot."
          );
        }
        if (basePageContentVersion !== lockedContentVersion) {
          throw new ApiError(
            409,
            "BLOCK_EDIT_CONFLICT",
            "The block hierarchy changed in another session. Your stale position was not applied."
          );
        }

        const nextParentBlockId = body.parentBlockId === undefined ? existing.parent_block_id : body.parentBlockId;
        const nextSortOrder = body.sortOrder === undefined ? Number(existing.sort_order) : body.sortOrder;
        const siblingPositionOccupied = hierarchyRows!.some(
          (row) => row.id !== blockId
            && row.parent_block_id === nextParentBlockId
            && Number(row.sort_order) === nextSortOrder
        );
        if (siblingPositionOccupied) {
          throw new ApiError(
            409,
            "BLOCK_EDIT_CONFLICT",
            "That sibling position is already occupied. Use the reorder endpoint with the complete sibling list."
          );
        }
      }

      const fields: string[] = [];
      const values: DbValue[] = [];
      const contentChanged =
        body.type !== undefined ||
        body.markdown !== undefined ||
        body.checked !== undefined ||
        body.metadata !== undefined;
      if (contentChanged) {
        assertExistingMetadataSafeToOverwrite(existing);
      }
      const nextType = body.type ?? existing.type;
      const sourceMetadata = body.metadata !== undefined ? body.metadata : existing.metadata;
      const nextMetadata = contentChanged
        ? assertLosslessStructuredMetadata(nextType, sourceMetadata)
        : sourceMetadata;
      const prepared = prepareBlockContent(
        nextType,
        body.markdown ?? existing.markdown,
        nextMetadata
      );
      const nextChecked = body.checked ?? Boolean(existing.checked);

      if (body.type !== undefined) {
        fields.push("type = ?");
        values.push(body.type);
      }
      if (body.markdown !== undefined || (contentChanged && (nextType === "BOOKMARK" || nextType === "AI_CHAT" || nextType === "ACCORDION" || nextType === "TREEVIEW"))) {
        fields.push("markdown = ?");
        values.push(prepared.markdown);
      }
      if (body.checked !== undefined) {
        fields.push("checked = ?");
        values.push(body.checked ? 1 : 0);
      }
      if (contentChanged) {
        fields.push("html_cache = ?");
        values.push(renderBlockHtml(nextType, prepared.markdown, nextChecked, prepared.metadata));
      }
      if (body.parentBlockId !== undefined) {
        fields.push("parent_block_id = ?");
        values.push(body.parentBlockId);
      }
      if (body.sortOrder !== undefined) {
        fields.push("sort_order = ?");
        values.push(body.sortOrder);
      }
      if (body.metadata !== undefined) {
        fields.push("metadata = ?");
        values.push(prepared.metadata ? JSON.stringify(prepared.metadata) : null);
      }

      if (fields.length) {
        if (mutationId && mutationHash) {
          fields.push("last_mutation_id = ?", "last_mutation_hash = ?");
          values.push(mutationId, mutationHash);
        } else {
          fields.push("last_mutation_id = NULL", "last_mutation_hash = NULL");
        }
      }

      let pageContentVersion = lockedContentVersion;
      if (fields.length) {
        const result = await client.execute<{ affectedRows: number }>(
          `UPDATE blocks SET ${[...fields, "edit_version = edit_version + 1"].join(", ")} WHERE id = ? AND page_id = ? AND edit_version = ?`,
          [...values, blockId, existing.page_id, body.expectedVersion]
        );
        if (Number(result.affectedRows) !== 1) {
          throw new ApiError(
            409,
            "BLOCK_EDIT_CONFLICT",
            "This block was changed in another session. Your local edits were not overwritten."
          );
        }
        pageContentVersion = await advancePageContentVersion(client, existing.page_id, lockedAccess.page.owner_id);
      }

      const updated = await client.queryOne<BlockRow>(
        "SELECT * FROM blocks WHERE id = ? AND page_id = ?",
        [blockId, existing.page_id]
      );
      if (!updated) throw notFound("Block");
      await recordPageVersion(client, {
        pageId: existing.page_id,
        actors: [toPageVersionActor(user)],
        source: "BLOCK_UPDATE",
        changes: diffPageVersionBlocks([existing], [updated])
      });
      return {
        block: updated,
        ...partialMutationVersionPayload(
          pageContentVersion,
          basePageContentVersion !== undefined && basePageContentVersion === lockedContentVersion
        )
      };
    });

    res.json({
      block: toBlock(result.block),
      pageContentVersion: result.pageContentVersion,
      pageContentVersionAuthoritative: result.pageContentVersionAuthoritative
    });
  } catch (error) {
    next(error);
  }
});

blockRouter.post(
  "/blocks/:blockId/move",
  validate({ params: idParamSchema, body: moveBlockSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const blockId = String(req.params.blockId);
      const body = req.body as z.infer<typeof moveBlockSchema>;
      const normalizedExpectedVersions = [...body.expectedVersions]
        .sort((left, right) => left.id.localeCompare(right.id));
      const mutationHash = createMutationRequestHash({
        kind: "BLOCK_MOVE",
        blockId,
        targetPageId: body.targetPageId,
        expectedVersions: normalizedExpectedVersions,
        expectedSourcePageContentVersion: body.expectedSourcePageContentVersion
      });

      const move = await transaction(async (client) => {
        // Mutation receipt FKs reference the actor. Lock that row before any
        // page row so account restore/import operations keep a consistent lock order.
        await lockBlockCreateUsers(client, [user.id]);
        await assertCurrentAuthSessionBoundary(user.id, authScope, client);

        const receipt = await client.queryOne<BlockMoveMutationReceipt>(
          `SELECT block_id, source_page_id, target_page_id, request_hash, moved_block_ids,
                  source_page_content_version, target_page_content_version
           FROM block_move_mutations
           WHERE actor_id = ? AND mutation_id = ?
           FOR UPDATE`,
          [user.id, body.mutationId]
        );

        if (receipt) {
          if (
            receipt.block_id !== blockId
            || receipt.target_page_id !== body.targetPageId
            || receipt.request_hash !== mutationHash
          ) {
            throw new ApiError(
              409,
              "MUTATION_ID_REUSED",
              "This mutation id was already used for a different block move. No block was moved."
            );
          }

          const movedBlockIds = parseMovedBlockIds(receipt.moved_block_ids);
          const {
            sourceAccess: replaySourceAccess,
            targetAccess: replayTargetAccess
          } = await lockMovePages(
            client,
            user.id,
            receipt.source_page_id,
            receipt.target_page_id
          );
          if (
            replaySourceAccess.role !== "OWNER"
            || replayTargetAccess.role !== "OWNER"
            || replaySourceAccess.page.owner_id !== user.id
            || replayTargetAccess.page.owner_id !== user.id
            || replaySourceAccess.page.owner_id !== replayTargetAccess.page.owner_id
          ) {
            throw new ApiError(
              409,
              "BLOCK_MOVE_REPLAY_SUPERSEDED",
              "The completed block move belongs to an older workspace state and was not repeated."
            );
          }

          const currentSourcePageContentVersion = Number(replaySourceAccess.page.content_version ?? 1);
          const receiptSourcePageContentVersion = Number(receipt.source_page_content_version);
          if (currentSourcePageContentVersion !== receiptSourcePageContentVersion) {
            throw new ApiError(
              409,
              "BLOCK_MOVE_REPLAY_SUPERSEDED",
              "The completed block move belongs to an older source-page generation and was not replayed. Refresh before moving again."
            );
          }

          const currentTargetPageContentVersion = Number(replayTargetAccess.page.content_version ?? 1);
          const receiptTargetPageContentVersion = Number(receipt.target_page_content_version);
          if (currentTargetPageContentVersion !== receiptTargetPageContentVersion) {
            throw new ApiError(
              409,
              "BLOCK_MOVE_REPLAY_SUPERSEDED",
              "The completed block move belongs to an older destination-page generation and was not replayed. Refresh before moving again."
            );
          }

          const placeholders = movedBlockIds.map(() => "?").join(", ");
          const replayRows = await client.query<BlockRow>(
            `SELECT * FROM blocks
             WHERE page_id = ? AND id IN (${placeholders})
             ORDER BY sort_order ASC, id ASC
             FOR UPDATE`,
            [receipt.target_page_id, ...movedBlockIds]
          );
          if (replayRows.length !== movedBlockIds.length) {
            throw new ApiError(
              409,
              "BLOCK_MOVE_REPLAY_SUPERSEDED",
              "The completed block move belongs to an older block generation and was not repeated."
            );
          }
          const replayRoot = replayRows.find((row) => row.id === blockId);
          if (!replayRoot) {
            throw new ApiError(
              409,
              "BLOCK_MOVE_REPLAY_SUPERSEDED",
              "The completed block move belongs to an older block generation and was not repeated."
            );
          }

          return {
            block: replayRoot,
            sourcePageId: receipt.source_page_id,
            targetPageId: receipt.target_page_id,
            movedBlockIds,
            sourcePageContentVersion: Number(receipt.source_page_content_version),
            targetPageContentVersion: Number(receipt.target_page_content_version),
            replayed: true
          };
        }

        // Resolve the current source only after the durable receipt check.
        // A response-loss retry runs after the block is already on the target
        // page, so checking "same page" before the receipt would turn a
        // committed success into a false failure.
        const currentIdentity = await assertAccessibleBlock(blockId, user.id, client);
        const sourcePageId = currentIdentity.block.page_id;
        if (sourcePageId === body.targetPageId) {
          throw new ApiError(400, "BLOCK_MOVE_SAME_PAGE", "Choose a different destination page.");
        }

        const { sourceAccess, targetAccess } = await lockMovePages(
          client,
          user.id,
          sourcePageId,
          body.targetPageId
        );
        if (
          sourceAccess.role !== "OWNER"
          || targetAccess.role !== "OWNER"
          || sourceAccess.page.owner_id !== user.id
          || targetAccess.page.owner_id !== user.id
          || sourceAccess.page.owner_id !== targetAccess.page.owner_id
        ) {
          throw new ApiError(
            403,
            "BLOCK_MOVE_OWNER_REQUIRED",
            "Blocks can only be moved between pages owned by the same account."
          );
        }
        assertDirectBlockMutationAllowed(sourceAccess);
        assertDirectBlockMutationAllowed(targetAccess);
        assertPageNotArchived(sourceAccess.page, "Restore the source page before moving a block");
        assertPageNotArchived(targetAccess.page, "Restore the destination page before moving a block");
        if (sourceAccess.page.is_collection || targetAccess.page.is_collection) {
          throw new ApiError(
            400,
            "BLOCK_MOVE_PAGE_REQUIRED",
            "Blocks can only be moved between regular pages."
          );
        }
        if (Number(sourceAccess.page.content_version ?? 1) !== body.expectedSourcePageContentVersion) {
          throw new ApiError(
            409,
            "BLOCK_EDIT_CONFLICT",
            "The source page changed in another session. No block was moved."
          );
        }

        const sourceRows = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY sort_order ASC, id ASC FOR UPDATE",
          [sourcePageId]
        );
        const root = sourceRows.find((row) => row.id === blockId);
        if (!root) {
          throw new ApiError(
            409,
            "BLOCK_EDIT_CONFLICT",
            "The block moved or changed in another session. No block was moved."
          );
        }
        const subtreeRows = collectBlockSubtreeRows(blockId, sourceRows);
        assertBlockVersionSnapshot(
          subtreeRows,
          body.expectedVersions,
          "This block subtree changed in another session. No block was moved."
        );

        const targetRows = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY sort_order ASC, id ASC FOR UPDATE",
          [body.targetPageId]
        );
        const lastTargetRoot = targetRows
          .filter((row) => row.parent_block_id === null)
          .sort((left, right) => Number(left.sort_order) - Number(right.sort_order) || left.id.localeCompare(right.id))
          .at(-1);
        const targetRootSortOrder = getNextBlockSortOrder(lastTargetRoot?.sort_order);
        const movedBlockIds = subtreeRows.map((row) => row.id);
        const placeholders = movedBlockIds.map(() => "?").join(", ");

        // The parent/page FK intentionally forbids cross-page parent references.
        // Temporarily detach the whole subtree inside this transaction, change
        // only page ownership, then restore its internal hierarchy. No block row
        // is deleted or re-created, so IDs and authoritative data stay intact.
        await client.execute(
          `UPDATE blocks SET parent_block_id = NULL WHERE id IN (${placeholders}) AND page_id = ?`,
          [...movedBlockIds, sourcePageId]
        );
        const pageUpdate = await client.execute<{ affectedRows: number }>(
          `UPDATE blocks SET page_id = ? WHERE id IN (${placeholders}) AND page_id = ?`,
          [body.targetPageId, ...movedBlockIds, sourcePageId]
        );
        if (Number(pageUpdate.affectedRows) !== movedBlockIds.length) {
          throw new ApiError(
            409,
            "BLOCK_EDIT_CONFLICT",
            "The block subtree changed while it was being moved. No block was moved."
          );
        }

        for (const before of subtreeRows) {
          const parentBlockId = before.id === blockId ? null : before.parent_block_id;
          const sortOrder = before.id === blockId ? targetRootSortOrder : before.sort_order;
          const restored = await client.execute<{ affectedRows: number }>(
            `UPDATE blocks
             SET parent_block_id = ?, sort_order = ?, last_mutation_id = NULL,
                 last_mutation_hash = NULL, edit_version = edit_version + 1
             WHERE id = ? AND page_id = ? AND edit_version = ?`,
            [
              parentBlockId,
              sortOrder,
              before.id,
              body.targetPageId,
              Number(before.edit_version ?? 1)
            ]
          );
          if (Number(restored.affectedRows) === 0) {
            throw new ApiError(
              409,
              "BLOCK_EDIT_CONFLICT",
              "The block subtree changed while it was being moved. No block was moved."
            );
          }
        }

        const movedRows = await client.query<BlockRow>(
          `SELECT * FROM blocks
           WHERE page_id = ? AND id IN (${placeholders})
           ORDER BY sort_order ASC, id ASC`,
          [body.targetPageId, ...movedBlockIds]
        );
        assertMovedBlockDataPreserved(
          subtreeRows,
          movedRows,
          blockId,
          body.targetPageId,
          targetRootSortOrder
        );

        const sourcePageContentVersion = await advancePageContentVersion(client, sourcePageId, sourceAccess.page.owner_id);
        const targetPageContentVersion = await advancePageContentVersion(client, body.targetPageId, targetAccess.page.owner_id);
        const sourceAfterRows = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY sort_order ASC, id ASC",
          [sourcePageId]
        );
        const targetAfterRows = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY sort_order ASC, id ASC",
          [body.targetPageId]
        );
        await recordPageVersion(client, {
          pageId: sourcePageId,
          actors: [toPageVersionActor(user)],
          source: "BLOCK_MOVE_OUT",
          changes: diffPageVersionBlocks(sourceRows, sourceAfterRows)
        });
        await recordPageVersion(client, {
          pageId: body.targetPageId,
          actors: [toPageVersionActor(user)],
          source: "BLOCK_MOVE_IN",
          changes: diffPageVersionBlocks(targetRows, targetAfterRows)
        });

        await client.execute(
          `INSERT INTO block_move_mutations
             (actor_id, mutation_id, block_id, source_page_id, target_page_id, request_hash,
              moved_block_ids, source_page_content_version, target_page_content_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            user.id,
            body.mutationId,
            blockId,
            sourcePageId,
            body.targetPageId,
            mutationHash,
            JSON.stringify(movedBlockIds),
            sourcePageContentVersion,
            targetPageContentVersion
          ]
        );

        const movedRoot = movedRows.find((row) => row.id === blockId);
        if (!movedRoot) {
          throw new ApiError(
            500,
            "BLOCK_MOVE_INTEGRITY_FAILED",
            "The block move failed its integrity check. No block was moved."
          );
        }
        return {
          block: movedRoot,
          sourcePageId,
          targetPageId: body.targetPageId,
          movedBlockIds,
          sourcePageContentVersion,
          targetPageContentVersion,
          replayed: false
        };
      });

      res.json({
        block: toBlock(move.block),
        sourcePageId: move.sourcePageId,
        targetPageId: move.targetPageId,
        movedBlockIds: move.movedBlockIds,
        sourcePageContentVersion: move.sourcePageContentVersion,
        targetPageContentVersion: move.targetPageContentVersion,
        replayed: move.replayed
      });
    } catch (error) {
      next(error);
    }
  }
);

blockRouter.delete(
  "/blocks/:blockId",
  validate({ params: idParamSchema, body: deleteBlockSchema }),
  async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const authScope = requireRequestAuthScope(req);
    const blockId = String(req.params.blockId);
    const body = req.body as z.infer<typeof deleteBlockSchema>;
    if (!body.mutationId) {
      throw new ApiError(
        400,
        "MUTATION_ID_REQUIRED",
        "A mutation id is required for block deletion."
      );
    }
    const mutationId = body.mutationId;
    if (!body.expectedVersions?.length) {
      throw new ApiError(
        400,
        "BLOCK_DELETE_SNAPSHOT_REQUIRED",
        "Refresh the block deletion snapshot before permanently deleting this block."
      );
    }
    const expectedVersions = body.expectedVersions;
    const normalizedExpectedVersions = [...expectedVersions]
      .sort((left, right) => left.id.localeCompare(right.id));
    const mutationRequest = {
      kind: "BLOCK_DELETE",
      blockId,
      expectedVersions: normalizedExpectedVersions,
      preserveChildren: body.preserveChildren,
      expectedPageContentVersion: body.expectedPageContentVersion ?? null
    };
    const mutationHash = createMutationRequestHash(mutationRequest);
    // Older receipts hashed the caller-provided snapshot order. Keep same-order
    // retries replayable across this deployment while new receipts use a
    // canonical set order and therefore survive harmless snapshot reordering.
    const legacyMutationHash = createMutationRequestHash({
      ...mutationRequest,
      expectedVersions
    });
    const deletion = await transaction(async (client) => {
      // Restore and attachment writes serialize on the owner/user row before
      // page locks. Capture that filesystem generation before any delete work.
      const attachmentGeneration = await lockUserAttachmentGeneration(client, user.id);
      if (attachmentGeneration === undefined) {
        throw new ApiError(401, "UNAUTHENTICATED", "Authentication is required");
      }
      await assertCurrentAuthSessionBoundary(user.id, authScope, client);

      const receipt = await client.queryOne<BlockDeleteMutationReceipt>(
        `SELECT page_id, block_id, request_hash, page_content_version, attachment_ids, attachment_generation
         FROM block_delete_mutations
         WHERE actor_id = ? AND mutation_id = ?
         FOR UPDATE`,
        [user.id, mutationId]
      );
      if (receipt) {
        let assessment = assessBlockDeleteMutationReceipt(receipt, {
          blockId,
          requestHash: mutationHash
        });
        if (assessment.kind === "collision" && legacyMutationHash !== mutationHash) {
          const legacyAssessment = assessBlockDeleteMutationReceipt(receipt, {
            blockId,
            requestHash: legacyMutationHash
          });
          if (legacyAssessment.kind !== "collision") {
            assessment = legacyAssessment;
          }
        }
        if (assessment.kind === "collision") {
          throw new ApiError(
            409,
            "MUTATION_ID_REUSED",
            "This mutation id was already used for a different block deletion request. No additional block was deleted."
          );
        }
        if (assessment.kind === "incomplete") {
          throw new ApiError(
            500,
            "BLOCK_DELETE_RECEIPT_INCOMPLETE",
            "The block deletion receipt is incomplete. The deletion was not repeated."
          );
        }
        const replayAccess = await getPageAccess(assessment.pageId, user.id, client, { lockPage: true });
        if (replayAccess.role !== "OWNER" || replayAccess.page.owner_id !== user.id) {
          throw new ApiError(
            409,
            "BLOCK_DELETE_REPLAY_SUPERSEDED",
            "This deletion belongs to an older page ownership generation and was not replayed."
          );
        }
        const currentPageContentVersion = Number(replayAccess.page.content_version ?? 1);
        if (currentPageContentVersion !== assessment.pageContentVersion) {
          throw new ApiError(
            409,
            "BLOCK_DELETE_REPLAY_SUPERSEDED",
            "This deletion belongs to an older block generation. The page has changed since it completed, so the old deletion was not replayed. Refresh before deleting again."
          );
        }
        const recreatedBlock = await client.queryOne<{ id: string }>(
          "SELECT id FROM blocks WHERE id = ? AND page_id = ? FOR UPDATE",
          [assessment.blockId, assessment.pageId]
        );
        if (recreatedBlock) {
          throw new ApiError(
            409,
            "BLOCK_DELETE_REPLAY_SUPERSEDED",
            "This deletion belongs to an older block generation. A block with the same id now exists and was not deleted. Refresh before deleting again."
          );
        }
        return {
          pageId: assessment.pageId,
          ownerId: user.id,
          attachmentIds: assessment.attachmentIds,
          attachmentGeneration: assessment.attachmentGeneration,
          pageContentVersion: assessment.pageContentVersion,
          replayed: true
        };
      }
      const { block } = await assertAccessibleBlock(blockId, user.id, client);
      const lockedAccess = await getPageAccess(block.page_id, user.id, client, { lockPage: true });
      assertDirectBlockMutationAllowed(lockedAccess);
      assertPageNotArchived(lockedAccess.page);
      const hierarchyRows = await client.query<BlockRow>(
        "SELECT * FROM blocks WHERE page_id = ? ORDER BY sort_order ASC, id ASC FOR UPDATE",
        [block.page_id]
      );
      const subtreeRows = collectBlockSubtreeRows(blockId, hierarchyRows);
      assertBlockVersionSnapshot(subtreeRows, expectedVersions);

      let versionRows = subtreeRows;
      let attachmentIds = subtreeRows.filter((row) => row.type === "ATTACHMENT").map((row) => row.id);
      if (body.preserveChildren) {
        const expectedPageContentVersion = Number(body.expectedPageContentVersion);
        if (Number(lockedAccess.page.content_version ?? 1) !== expectedPageContentVersion) {
          throw new ApiError(
            409,
            "BLOCK_EDIT_CONFLICT",
            "The page changed in another session. Its block hierarchy was not modified."
          );
        }
        const target = hierarchyRows.find((row) => row.id === blockId);
        if (!target) throw notFound("Block");
        versionRows = hierarchyRows;
        attachmentIds = target.type === "ATTACHMENT" ? [target.id] : [];
        await promoteBlockChildrenBeforeDelete(client, target, hierarchyRows);
      }

      const deleteResult = await client.execute<{ affectedRows: number }>(
        "DELETE FROM blocks WHERE id = ? AND page_id = ?",
        [blockId, block.page_id]
      );
      if (Number(deleteResult.affectedRows) !== 1) {
        throw new ApiError(
          409,
          "BLOCK_EDIT_CONFLICT",
          "The block changed before deletion completed. Nothing was deleted."
        );
      }
      const pageContentVersion = await advancePageContentVersion(client, block.page_id, lockedAccess.page.owner_id);
      const afterRows = body.preserveChildren
        ? await client.query<BlockRow>(
            "SELECT * FROM blocks WHERE page_id = ? ORDER BY sort_order ASC, id ASC",
            [block.page_id]
          )
        : [];
      await recordPageVersion(client, {
        pageId: block.page_id,
        actors: [toPageVersionActor(user)],
        source: "BLOCK_DELETE",
        changes: diffPageVersionBlocks(versionRows, afterRows)
      });
      await client.execute(
        `INSERT INTO block_delete_mutations
           (actor_id, mutation_id, page_id, block_id, request_hash, page_content_version, attachment_ids, attachment_generation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          mutationId,
          block.page_id,
          blockId,
          mutationHash,
          pageContentVersion,
          JSON.stringify(attachmentIds),
          attachmentGeneration
        ]
      );
      return {
        pageId: block.page_id,
        ownerId: lockedAccess.page.owner_id,
        attachmentIds,
        attachmentGeneration,
        pageContentVersion,
        replayed: false
      };
    });
    // A pre-migration receipt has no trustworthy filesystem generation.
    // Replay the already-committed SQL delete, but never let that legacy receipt
    // authorize filesystem cleanup in whichever workspace generation exists now.
    if (deletion.attachmentGeneration !== undefined) {
      await removeDeletedAttachmentFiles(
        deletion.ownerId,
        deletion.attachmentIds,
        deletion.attachmentGeneration
      );
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
  }
);

blockRouter.post(
  "/pages/:pageId/blocks/reorder",
  validate({ params: idParamSchema, body: reorderSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const pageId = String(req.params.pageId);
      const { items, mutationId } = req.body as z.infer<typeof reorderSchema>;
      const mutationHash = mutationId ? createMutationRequestHash({ pageId, items }) : undefined;

      const result = await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(user.id, authScope, client);
        const lockedAccess = await getPageAccess(pageId, user.id, client, { lockPage: true });
        const lockedPage = lockedAccess.page;

        if (mutationId) {
          const receipt = await client.queryOne<{ page_id: string; request_hash: string | null }>(
            `SELECT page_id, request_hash
             FROM block_order_mutations
             WHERE owner_id = ? AND mutation_id = ?
             FOR UPDATE`,
            [user.id, mutationId]
          );
          if (receipt) {
            if (receipt.page_id !== pageId || !mutationHash || receipt.request_hash !== mutationHash) {
              throw new ApiError(
                409,
                "MUTATION_ID_REUSED",
                "This mutation id was already used for a different request. The new order was not applied."
              );
            }
            const rows = await client.query<BlockRow>(
              "SELECT * FROM blocks WHERE page_id = ? ORDER BY sort_order ASC, id ASC",
              [pageId]
            );
            return { rows, pageContentVersion: Number(lockedPage.content_version ?? 1) };
          }
        }

        // Like block create/delete/move receipts, a completed reorder receipt is
        // safe to replay after the page becomes shared because no write occurs.
        assertDirectBlockMutationAllowed(lockedAccess);
        assertPageNotArchived(lockedPage);

        const hierarchyRows = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY id ASC FOR UPDATE",
          [pageId]
        );
        const rowById = new Map(hierarchyRows.map((row) => [row.id, row]));
        const itemIds = new Set(items.map((item) => item.id));
        if (itemIds.size !== items.length || items.some((item) => !rowById.has(item.id))) {
          throw new ApiError(400, "INVALID_BLOCKS", "All reordered blocks must belong to the page");
        }

        for (const item of items) {
          const current = rowById.get(item.id)!;
          if (Number(current.edit_version ?? 1) !== item.expectedVersion) {
            throw new ApiError(
              409,
              "BLOCK_EDIT_CONFLICT",
              "The block order changed in another session. Your stale order was not applied."
            );
          }
          if (item.parentBlockId && !rowById.has(item.parentBlockId)) {
            throw new ApiError(400, "INVALID_PARENT_BLOCK", "Parent block must exist on the same page");
          }
          if (item.parentBlockId === item.id) {
            throw new ApiError(400, "INVALID_PARENT_BLOCK", "A block cannot be its own parent");
          }
        }

        // Reorders are sibling-list snapshots, not sparse position patches. A block
        // can be created or moved into one of these parents without changing the
        // edit_version of any block named by this stale request. Require each
        // affected final sibling list to be complete before writing so an unlisted
        // concurrent sibling cannot be assigned a duplicate/obsolete position.
        const requestedParentById = new Map<string, string | null>();
        const affectedParentIds = new Set<string | null>();
        for (const item of items) {
          const current = rowById.get(item.id)!;
          const requestedParentId =
            item.parentBlockId === undefined ? current.parent_block_id : item.parentBlockId;
          requestedParentById.set(item.id, requestedParentId);
          affectedParentIds.add(current.parent_block_id);
          affectedParentIds.add(requestedParentId);
        }

        for (const parentBlockId of affectedParentIds) {
          const requestedSiblings = items.filter(
            (item) => requestedParentById.get(item.id) === parentBlockId
          );
          const requestedSiblingIds = new Set(requestedSiblings.map((item) => item.id));
          const finalSiblingIds = hierarchyRows
            .filter((row) => {
              const finalParentId = requestedParentById.has(row.id)
                ? requestedParentById.get(row.id)!
                : row.parent_block_id;
              return finalParentId === parentBlockId;
            })
            .map((row) => row.id);

          if (
            finalSiblingIds.length !== requestedSiblings.length
            || finalSiblingIds.some((id) => !requestedSiblingIds.has(id))
          ) {
            throw new ApiError(
              409,
              "BLOCK_EDIT_CONFLICT",
              "The sibling list changed in another session. Your stale order was not applied."
            );
          }

          const requestedSortOrders = requestedSiblings
            .map((item) => item.sortOrder)
            .sort((left, right) => left - right);
          if (requestedSortOrders.some((sortOrder, index) => sortOrder !== index)) {
            throw new ApiError(
              400,
              "INVALID_BLOCK_ORDER",
              "Each affected sibling list must use every sort position exactly once."
            );
          }
        }

        assertReorderDoesNotCreateCycle(hierarchyRows, items);

        for (const item of items) {
          const result = item.parentBlockId !== undefined
            ? await client.execute<{ affectedRows: number }>(
                `UPDATE blocks
                 SET sort_order = ?, parent_block_id = ?, last_mutation_id = NULL,
                     last_mutation_hash = NULL, edit_version = edit_version + 1
                 WHERE id = ? AND page_id = ? AND edit_version = ?`,
                [item.sortOrder, item.parentBlockId, item.id, pageId, item.expectedVersion]
              )
            : await client.execute<{ affectedRows: number }>(
                `UPDATE blocks
                 SET sort_order = ?, last_mutation_id = NULL, last_mutation_hash = NULL,
                     edit_version = edit_version + 1
                 WHERE id = ? AND page_id = ? AND edit_version = ?`,
                [item.sortOrder, item.id, pageId, item.expectedVersion]
              );
          if (Number(result.affectedRows) !== 1) {
            throw new ApiError(
              409,
              "BLOCK_EDIT_CONFLICT",
              "The block order changed in another session. Your stale order was not applied."
            );
          }
        }

        const pageContentVersion = await advancePageContentVersion(client, pageId, lockedAccess.page.owner_id);
        if (mutationId && mutationHash) {
          await client.execute(
            `INSERT INTO block_order_mutations (owner_id, mutation_id, page_id, request_hash)
             VALUES (?, ?, ?, ?)`,
            [user.id, mutationId, pageId, mutationHash]
          );
        }
        const rows = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY sort_order ASC, id ASC",
          [pageId]
        );
        await recordPageVersion(client, {
          pageId,
          actors: [toPageVersionActor(user)],
          source: "BLOCK_REORDER",
          changes: diffPageVersionBlocks(hierarchyRows, rows)
        });
        return { rows, pageContentVersion };
      });

      res.json({ blocks: result.rows.map(toBlock), pageContentVersion: result.pageContentVersion });
    } catch (error) {
      next(error);
    }
  }
);
