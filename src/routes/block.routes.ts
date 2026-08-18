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

const bookmarkPreviewSchema = z.object({
  url: z.string().trim().min(1).max(2_048)
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

async function assertAccessiblePage(pageId: string, userId: string, client: DbClient = db) {
  return getPageAccess(pageId, userId, client);
}

async function assertAccessibleBlock(blockId: string, userId: string, client: DbClient = db) {
  return getBlockAccess(blockId, userId, client);
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
}>;

async function authorizeAttachmentUploadTarget(req: Request, res: Response, next: NextFunction) {
  try {
    const user = requireUser(req.user);
    const pageId = String(req.params.pageId);
    const access = await assertAccessiblePage(pageId, user.id);
    assertDirectBlockMutationAllowed(access);
    if (access.page.is_archived) {
      throw new ApiError(409, "PAGE_ARCHIVED", "Restore the page before adding an attachment");
    }
    res.locals.attachmentUploadTarget = Object.freeze({
      actorId: user.id,
      pageId,
      ownerId: access.page.owner_id
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

async function advancePageContentVersion(client: DbClient, pageId: string, _userId: string) {
  const result = await client.execute<{ affectedRows: number }>(
    "UPDATE pages SET content_version = content_version + 1 WHERE id = ?",
    [pageId]
  );
  if (Number(result.affectedRows) === 0) throw notFound("Page");
  const page = await client.queryOne<PageRow>("SELECT * FROM pages WHERE id = ?", [pageId]);
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
       SET parent_block_id = ?, sort_order = ?, edit_version = edit_version + 1
       WHERE id = ? AND edit_version = ?`,
      [update.parentBlockId, update.sortOrder, row.id, Number(row.edit_version ?? 1)]
    );
    if (Number(result.affectedRows) === 0) {
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
  expectedVersions: Array<{ id: string; version: number }>
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
      "This block subtree changed in another session. It was not deleted."
    );
  }
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

          const lockedAccess = await getPageAccess(pageId, user.id, client, { lockPage: true });
          if (lockedAccess.page.owner_id !== ownerId) {
            throw new ApiError(409, "PAGE_OWNER_CHANGED", "The page owner changed while the attachment was uploading");
          }
          const lockedContentVersion = Number(lockedAccess.page.content_version ?? 1);
          const reservation = await reserveBlockCreateMutation(client, {
            actorId: user.id,
            mutationId: body.mutationId,
            pageId,
            blockId: id,
            requestHash: mutationHash
          });
          if (reservation.kind === "replay") {
            return {
              block: reservation.block,
              ...partialMutationVersionPayload(
                lockedContentVersion,
                isAuthoritativePartialMutationReplay(body.basePageContentVersion, lockedContentVersion)
              )
            };
          }

          assertDirectBlockMutationAllowed(lockedAccess);
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
          const lastBlock = await client.queryOne<{ sort_order: number }>(
            "SELECT sort_order FROM blocks WHERE page_id = ? AND parent_block_id <=> ? ORDER BY sort_order DESC LIMIT 1",
            [pageId, body.parentBlockId]
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
              body.sortOrder ?? getNextBlockSortOrder(lastBlock?.sort_order),
              JSON.stringify(metadata)
            ]
          );
          const pageContentVersion = await advancePageContentVersion(client, pageId, user.id);
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
            const confirmedBlock = await db.queryOne<BlockRow>(
              "SELECT * FROM blocks WHERE id = ? AND page_id = ?",
              [id, pageId]
            );
            if (confirmedBlock) {
              const confirmedPage = await db.queryOne<{ content_version: number }>(
                "SELECT content_version FROM pages WHERE id = ?",
                [pageId]
              );
              const confirmedContentVersion = Number(confirmedPage?.content_version ?? 1);
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
            insertDefinitelyFailed = !(await db.queryOne<{ id: string }>("SELECT id FROM blocks WHERE id = ?", [id]));
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
      await broadcastCanonicalAttachment(pageId, payload);
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
    const { block, access } = await assertAccessibleBlock(blockId, user.id);
    if (block.type !== "ATTACHMENT") throw notFound("Attachment");

    const ownerId = access.page.owner_id;
    const info = getAttachmentInfo(toBlock(block).metadata);
    if (!info || !(await attachmentFileExists(ownerId, blockId))) throw notFound("Attachment file");

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", info.mimeType);
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.download(
      getAttachmentFilePath(ownerId, blockId),
      sanitizeAttachmentDownloadFilename(info.originalName),
      (error) => {
        if (!error) return;
        if (!res.headersSent) next(error);
        else console.error("Attachment download failed", { blockId, errorName: error.name });
      }
    );
  } catch (error) {
    next(error);
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
      const lastBlock = await client.queryOne<{ sort_order: number }>(
        "SELECT sort_order FROM blocks WHERE page_id = ? AND parent_block_id <=> ? ORDER BY sort_order DESC LIMIT 1",
        [pageId, creation.parentBlockId ?? null]
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
          creation.sortOrder ?? getNextBlockSortOrder(lastBlock?.sort_order),
          prepared.metadata ? JSON.stringify(prepared.metadata) : null
        ]
      );
      const pageContentVersion = await advancePageContentVersion(client, pageId, user.id);
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
      assertDirectBlockMutationAllowed(lockedAccess);
      const lockedPage = lockedAccess.page;
      let existing: BlockRow;

      if (hierarchyChanged) {
        const hierarchyRows = await client.query<BlockRow>(
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

      const lockedContentVersion = Number(lockedPage.content_version ?? 1);
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
          `UPDATE blocks SET ${[...fields, "edit_version = edit_version + 1"].join(", ")} WHERE id = ? AND edit_version = ?`,
          [...values, blockId, body.expectedVersion]
        );
        if (Number(result.affectedRows) === 0) {
          throw new ApiError(
            409,
            "BLOCK_EDIT_CONFLICT",
            "This block was changed in another session. Your local edits were not overwritten."
          );
        }
        pageContentVersion = await advancePageContentVersion(client, existing.page_id, user.id);
      }

      const updated = await client.queryOne<BlockRow>("SELECT * FROM blocks WHERE id = ?", [blockId]);
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

blockRouter.delete(
  "/blocks/:blockId",
  validate({ params: idParamSchema, body: deleteBlockSchema }),
  async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const authScope = requireRequestAuthScope(req);
    const blockId = String(req.params.blockId);
    const body = req.body as z.infer<typeof deleteBlockSchema>;
    const mutationHash = body.mutationId
      ? createMutationRequestHash({
          kind: "BLOCK_DELETE",
          blockId,
          expectedVersions: body.expectedVersions ?? [],
          preserveChildren: body.preserveChildren,
          expectedPageContentVersion: body.expectedPageContentVersion ?? null
        })
      : undefined;
    if (!body.expectedVersions?.length) {
      throw new ApiError(
        400,
        "BLOCK_DELETE_SNAPSHOT_REQUIRED",
        "Refresh the block deletion snapshot before permanently deleting this block."
      );
    }
    const expectedVersions = body.expectedVersions;
    const deletion = await transaction(async (client) => {
      // Restore and attachment writes serialize on the owner/user row before
      // page locks. Capture that filesystem generation before any delete work.
      const attachmentGeneration = await lockUserAttachmentGeneration(client, user.id);
      if (attachmentGeneration === undefined) {
        throw new ApiError(401, "UNAUTHENTICATED", "Authentication is required");
      }
      await assertCurrentAuthSessionBoundary(user.id, authScope, client);

      if (body.mutationId && mutationHash) {
        const receipt = await client.queryOne<BlockDeleteMutationReceipt>(
          `SELECT page_id, block_id, request_hash, page_content_version, attachment_ids
           FROM block_delete_mutations
           WHERE actor_id = ? AND mutation_id = ?
           FOR UPDATE`,
          [user.id, body.mutationId]
        );
        if (receipt) {
          const assessment = assessBlockDeleteMutationReceipt(receipt, {
            blockId,
            requestHash: mutationHash
          });
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
            ownerId: replayAccess.page.owner_id,
            attachmentIds: assessment.attachmentIds,
            attachmentGeneration,
            pageContentVersion: assessment.pageContentVersion,
            replayed: true
          };
        }
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

      await client.execute("DELETE FROM blocks WHERE id = ?", [blockId]);
      const pageContentVersion = await advancePageContentVersion(client, block.page_id, user.id);
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
      if (body.mutationId && mutationHash) {
        await client.execute(
          `INSERT INTO block_delete_mutations
             (actor_id, mutation_id, page_id, block_id, request_hash, page_content_version, attachment_ids)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            user.id,
            body.mutationId,
            block.page_id,
            blockId,
            mutationHash,
            pageContentVersion,
            JSON.stringify(attachmentIds)
          ]
        );
      }
      return {
        pageId: block.page_id,
        ownerId: lockedAccess.page.owner_id,
        attachmentIds,
        attachmentGeneration,
        pageContentVersion,
        replayed: false
      };
    });
    await removeDeletedAttachmentFiles(
      deletion.ownerId,
      deletion.attachmentIds,
      deletion.attachmentGeneration
    );
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
        assertDirectBlockMutationAllowed(lockedAccess);
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
        assertReorderDoesNotCreateCycle(hierarchyRows, items);

        for (const item of items) {
          const result = item.parentBlockId !== undefined
            ? await client.execute<{ affectedRows: number }>(
                `UPDATE blocks
                 SET sort_order = ?, parent_block_id = ?, edit_version = edit_version + 1
                 WHERE id = ? AND edit_version = ?`,
                [item.sortOrder, item.parentBlockId, item.id, item.expectedVersion]
              )
            : await client.execute<{ affectedRows: number }>(
                `UPDATE blocks
                 SET sort_order = ?, edit_version = edit_version + 1
                 WHERE id = ? AND edit_version = ?`,
                [item.sortOrder, item.id, item.expectedVersion]
              );
          if (Number(result.affectedRows) === 0) {
            throw new ApiError(
              409,
              "BLOCK_EDIT_CONFLICT",
              "The block order changed in another session. Your stale order was not applied."
            );
          }
        }

        const pageContentVersion = await advancePageContentVersion(client, pageId, user.id);
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
