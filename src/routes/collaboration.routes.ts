import { Router, raw } from "express";
import { z } from "zod";
import { db, transaction, type DbClient } from "../lib/db.js";
import { assertCurrentAuthSessionBoundary } from "../lib/auth-sessions.js";
import { requireAuth, requireRequestAuthScope } from "../middleware/auth.js";
import {
  collaborationSessionPageRateLimit,
  collaborationShareAccountRateLimit,
  collaborationShareIpRateLimit
} from "../middleware/auth-rate-limit.js";
import { getValidatedQuery, validate } from "../middleware/validate.js";
import { idParamSchema, requireUser, routeIdSchema, safeVersionSchema, usernameSchema } from "../utils/schemas.js";
import { ApiError, notFound } from "../lib/http.js";
import { createId } from "../lib/id.js";
import {
  assertCollaborationDocumentEpoch,
  ensureCollaborationState,
  getCollaborationState
} from "../lib/collaboration-lineage.js";
import {
  assertPageCanAdminister,
  assertPageCanEdit,
  assertPageNotArchived,
  getEffectivePageShareCount,
  getPageAccess,
  toAccessPayload,
  toCollaborationPayload
} from "../lib/page-access.js";
import {
  collaborationTicketTtlSeconds,
  createCollaborationSessionBinding,
  signCollaborationToken
} from "../lib/collaboration-token.js";
import {
  collaborationTicketProtocolPrefix,
  collaborationWebSocketProtocol,
  disconnectPageCollaboratorsForDocumentEpoch,
  disconnectSharedUserGrant
} from "../lib/collaboration-server.js";
import { toBlock, toPublicUser } from "../lib/mappers.js";
import { renderBlockHtml } from "../lib/markdown.js";
import {
  getBookmarkData,
  summarizeBookmarkData
} from "../lib/bookmark.js";
import { getAiChatData, summarizeAiChatData } from "../lib/ai-chat.js";
import {
  assertStructuredBlockMetadataIntegrity,
  StructuredMetadataIntegrityError
} from "../lib/structured-metadata-integrity.js";
import { lockUserAttachmentGeneration, removeDeletedAttachmentFiles } from "../lib/attachments.js";
import { CollaborationDocumentError } from "../lib/collaboration-document.js";
import type { CollaborationMaterialization } from "../lib/collaboration-materialization.js";
import {
  diffPageVersionBlocks,
  diffPageVersionPage,
  loadPageVersionActors,
  recordPageVersion,
  toPageVersionActor
} from "../lib/page-version-history.js";
import {
  currentCollaborationMaterializationVersion,
  isUnsupportedCollaborationMaterializationVersion,
  needsCollaborationMaterialization
} from "../lib/collaboration-protocol.js";
import { assessCollaborationHistoryReplay } from "../lib/collaboration-update-policy.js";
import {
  CollaborationHistoryTimeoutError,
  CollaborationValidationCapacityError,
  CollaborationValidationPool,
  CollaborationValidationResourceLimitError
} from "../lib/collaboration-update-worker-pool.js";
import { getClientWebRtcSignal } from "../lib/vpn-access-policy.js";
import { readAuthSessionCookie } from "../lib/session-cookie.js";
import type { BlockRow, PageRow, UserRow } from "../types/domain.js";
import { assertNoActiveCollaborationWriteLeases } from "../lib/collaboration-write-lease.js";
import {
  deleteRecoveryCandidate,
  directRecoveryLineageKey,
  getRecoveryCandidate,
  grantDirectPageRecovery,
  grantLegacyYjsPageRecovery,
  grantYjsPageRecovery,
  legacyYjsRecoveryLineageKey,
  listRecoveryCandidates,
  maxRecoveryCandidateBytes,
  storeRecoveryCandidate,
  yjsRecoveryLineageKey,
  type RecoveryCandidateKind
} from "../lib/recovery-candidates.js";

export const collaborationRouter = Router();
collaborationRouter.use(requireAuth);

// HTTP snapshot materialization uses a dedicated bounded worker so replaying a
// large persisted Yjs history never monopolizes Node's shared event loop.
const collaborationMaterializationPool = new CollaborationValidationPool(1);

async function lockCollaborationMutationUsers(client: DbClient, userIds: string[]) {
  const uniqueIds = [...new Set(userIds)].sort();
  const rows = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE id IN (${uniqueIds.map(() => "?").join(", ")}) ORDER BY id ASC FOR UPDATE`,
    uniqueIds
  );
  if (rows.length !== uniqueIds.length) throw notFound("User");
}

const shareUserSchema = z.object({
  username: usernameSchema
});

const removeShareSchema = z.object({
  expectedGeneration: routeIdSchema
});

const shareParamsSchema = z.object({
  pageId: routeIdSchema,
  userId: routeIdSchema
});

const pageCommentTextSchema = z.string().trim().min(1).max(2_000);

const pageCommentBodySchema = z.object({
  body: pageCommentTextSchema
}).strict();

const pageCommentEditSchema = z.object({
  body: pageCommentTextSchema,
  expectedVersion: safeVersionSchema
}).strict();

const pageCommentDeleteSchema = z.object({
  expectedVersion: safeVersionSchema
}).strict();

const pageCommentParamsSchema = z.object({
  pageId: routeIdSchema,
  commentId: routeIdSchema
});

const maxPageCommentsPerPage = 500;

// Pre-fix tabs may still send title/blocks/deletedAttachmentIds. Zod strips
// those unknown fields, but the server never trusts or materializes them.
const materializeSchema = z.object({
  documentEpoch: z.string().min(1).max(64),
  updateId: z.number().int().min(1)
});

const collaborationSessionSchema = z.object({
  documentEpochProtocol: z.literal(2)
}).strict();

const recoveryCandidateUploadQuerySchema = z.object({
  kind: z.enum(["DIRECT_DRAFT", "YJS_UPDATE", "YJS_LEGACY_UPDATE"]),
  documentEpoch: z.string().min(1).max(64).optional(),
  sourceId: z.string().min(1).max(128),
  generation: z.string().min(1).max(128)
}).superRefine((value, context) => {
  if (value.kind === "YJS_UPDATE" && !value.documentEpoch) {
    context.addIssue({ code: "custom", path: ["documentEpoch"], message: "documentEpoch is required" });
  }
  if (value.kind !== "YJS_UPDATE" && value.documentEpoch) {
    context.addIssue({ code: "custom", path: ["documentEpoch"], message: "documentEpoch is valid only for epoch-bound Yjs recovery" });
  }
});

const recoveryCandidateParamsSchema = z.object({
  candidateId: routeIdSchema
});

type ShareTargetRow = Pick<
  UserRow,
  | "id"
  | "username"
  | "name"
  | "avatar_data"
  | "preferred_language"
  | "default_collection_icon"
  | "theme"
  | "created_at"
  | "updated_at"
>;

type ShareUserRow = ShareTargetRow & {
  permission: "EDIT";
  shared_at: string;
  share_generation: string;
};

type PageCommentRow = ShareTargetRow & {
  comment_id: string;
  page_id: string;
  user_id: string;
  body: string;
  edit_version: number;
  comment_created_at: string;
  comment_updated_at: string;
};

type CollaborationUpdateRow = {
  id: number | bigint;
  user_id: string;
  update_data: Buffer;
};

type CollaborationHistoryStatsRow = {
  history_entries: number | string | bigint | null;
  history_bytes: number | string | bigint | null;
};

function toSafeHistoryMetric(value: unknown, label: string) {
  const metric = Number(value ?? 0);
  if (!Number.isSafeInteger(metric) || metric < 0) {
    throw new ApiError(
      500,
      "INVALID_COLLABORATION_STATE",
      `Stored collaboration ${label} is invalid`
    );
  }
  return metric;
}

function assertShareablePage(page: PageRow) {
  if (page.is_collection) {
    throw new ApiError(400, "COLLECTION_SHARING_UNSUPPORTED", "Collections cannot be shared for live editing");
  }
  if (page.is_archived) {
    throw new ApiError(400, "ARCHIVED_PAGE_SHARING_UNSUPPORTED", "Restore the page before sharing it");
  }
}

async function getShareRows(pageId: string, ownerId: string, client: DbClient = db) {
  return client.query<ShareUserRow>(
    `SELECT u.id, u.username, u.name, u.avatar_data, u.preferred_language, u.default_collection_icon, u.theme,
            u.created_at, u.updated_at, ps.permission, ps.created_at AS shared_at, ps.generation AS share_generation
     FROM page_shares ps
     INNER JOIN pages p ON p.id = ps.page_id AND p.owner_id = ?
     INNER JOIN users u ON u.id = ps.user_id
     WHERE ps.page_id = ? AND ps.permission = 'EDIT'
     ORDER BY ps.created_at ASC, u.username ASC`,
    [ownerId, pageId]
  );
}

function toSharePayload(row: ShareUserRow) {
  return {
    user: toPublicUser(row),
    permission: row.permission,
    sharedAt: row.shared_at,
    generation: row.share_generation
  };
}

async function getPageCommentRow(
  pageId: string,
  commentId: string,
  client: DbClient = db
): Promise<PageCommentRow | null> {
  return (await client.queryOne<PageCommentRow>(
    `SELECT pc.id AS comment_id, pc.page_id, pc.user_id, pc.body, pc.edit_version,
            pc.created_at AS comment_created_at, pc.updated_at AS comment_updated_at,
            u.id, u.username, u.name, u.avatar_data, u.preferred_language,
            u.default_collection_icon, u.theme, u.created_at, u.updated_at
     FROM page_comments pc
     INNER JOIN users u ON u.id = pc.user_id
     WHERE pc.page_id = ? AND pc.id = ?`,
    [pageId, commentId]
  )) ?? null;
}

function toPageCommentPayload(
  row: PageCommentRow,
  viewer: { id: string; isOwner: boolean }
) {
  const isAuthor = row.user_id === viewer.id;
  return {
    id: row.comment_id,
    pageId: row.page_id,
    body: row.body,
    version: Number(row.edit_version),
    author: toPublicUser(row),
    createdAt: row.comment_created_at,
    updatedAt: row.comment_updated_at,
    canEdit: isAuthor,
    canDelete: isAuthor || viewer.isOwner
  };
}

function assertLosslessStructuredMetadata(type: BlockRow["type"], metadata: unknown) {
  try {
    const validated = assertStructuredBlockMetadataIntegrity(type, metadata);
    return validated === undefined ? metadata : validated;
  } catch (error) {
    if (error instanceof StructuredMetadataIntegrityError) {
      throw new ApiError(
        409,
        "COLLABORATION_METADATA_WOULD_TRUNCATE",
        "The collaboration snapshot contains structured data that cannot be materialized losslessly.",
        { path: error.path, reason: error.message }
      );
    }
    throw error;
  }
}

function assertExistingMetadataSafeToMaterialize(existing: BlockRow) {
  try {
    assertStructuredBlockMetadataIntegrity(existing.type, existing.metadata);
  } catch (error) {
    if (error instanceof StructuredMetadataIntegrityError) {
      throw new ApiError(
        409,
        "BLOCK_METADATA_RECOVERY_REQUIRED",
        "Stored block metadata failed integrity validation. The original data was preserved and must be recovered or repaired explicitly.",
        {
          blockId: existing.id,
          path: error.path,
          reason: error.message
        }
      );
    }
    throw error;
  }
}

function prepareBlockContent(type: BlockRow["type"], markdown: string, metadata: unknown) {
  if (type === "BOOKMARK") {
    return {
      markdown: summarizeBookmarkData(getBookmarkData(metadata)),
      metadata
    };
  }
  if (type === "AI_CHAT") {
    return {
      markdown: summarizeAiChatData(getAiChatData(metadata)),
      metadata
    };
  }
  return { markdown, metadata };
}

function canonicalJsonForComparison(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;

  let decoded: unknown = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      return undefined;
    }
  }

  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, normalize(entry)])
      );
    }
    return candidate;
  };

  try {
    return JSON.stringify(normalize(decoded));
  } catch {
    return undefined;
  }
}


collaborationRouter.get(
  "/pages/:pageId/comments",
  validate({ params: idParamSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const result = await transaction(async (client) => {
        const access = await getPageAccess(pageId, user.id, client);
        const rows = await client.query<PageCommentRow>(
          `SELECT pc.id AS comment_id, pc.page_id, pc.user_id, pc.body, pc.edit_version,
                  pc.created_at AS comment_created_at, pc.updated_at AS comment_updated_at,
                  u.id, u.username, u.name, u.avatar_data, u.preferred_language,
                  u.default_collection_icon, u.theme, u.created_at, u.updated_at
           FROM page_comments pc
           INNER JOIN users u ON u.id = pc.user_id
           WHERE pc.page_id = ?
           ORDER BY pc.created_at ASC, pc.id ASC
           LIMIT ${maxPageCommentsPerPage}`,
          [pageId]
        );
        const viewer = { id: user.id, isOwner: access.role === "OWNER" || access.role === "ADMIN" };
        return rows.map((row) => toPageCommentPayload(row, viewer));
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ comments: result, count: result.length });
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.post(
  "/pages/:pageId/comments",
  validate({ params: idParamSchema, body: pageCommentBodySchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const pageId = String(req.params.pageId);
      const body = String(req.body.body).trim();
      const comment = await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(user.id, authScope, client);
        const access = await getPageAccess(pageId, user.id, client, { lockPage: true });
        assertPageCanEdit(access, "This shared collection is read-only for your account");
        assertPageNotArchived(access.page, "Restore the page before adding a comment");
        const countRow = await client.queryOne<{ count: number }>(
          "SELECT COUNT(*) AS count FROM page_comments WHERE page_id = ?",
          [pageId]
        );
        if (Number(countRow?.count ?? 0) >= maxPageCommentsPerPage) {
          throw new ApiError(409, "PAGE_COMMENT_LIMIT_REACHED", `A page can contain up to ${maxPageCommentsPerPage} comments`);
        }
        const commentId = createId("cmt");
        await client.execute(
          `INSERT INTO page_comments (id, page_id, user_id, body)
           VALUES (?, ?, ?, ?)`,
          [commentId, pageId, user.id, body]
        );
        const created = await getPageCommentRow(pageId, commentId, client);
        if (!created) throw new ApiError(500, "PAGE_COMMENT_CREATE_FAILED", "The comment was not created");
        return toPageCommentPayload(created, { id: user.id, isOwner: access.role === "OWNER" || access.role === "ADMIN" });
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.status(201).json({ comment });
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.patch(
  "/pages/:pageId/comments/:commentId",
  validate({ params: pageCommentParamsSchema, body: pageCommentEditSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const pageId = String(req.params.pageId);
      const commentId = String(req.params.commentId);
      const body = String(req.body.body).trim();
      const expectedVersion = Number(req.body.expectedVersion);
      const comment = await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(user.id, authScope, client);
        const access = await getPageAccess(pageId, user.id, client, { lockPage: true });
        assertPageCanEdit(access, "This shared collection is read-only for your account");
        assertPageNotArchived(access.page, "Restore the page before editing a comment");
        const existing = await client.queryOne<{ user_id: string; edit_version: number }>(
          `SELECT user_id, edit_version FROM page_comments
           WHERE page_id = ? AND id = ? FOR UPDATE`,
          [pageId, commentId]
        );
        if (!existing) throw notFound("Page comment");
        if (existing.user_id !== user.id) {
          throw new ApiError(403, "PAGE_COMMENT_EDIT_FORBIDDEN", "Only the comment author can edit this comment");
        }
        const currentVersion = Number(existing.edit_version);
        if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
          throw new ApiError(500, "INVALID_PAGE_COMMENT_VERSION", "The stored comment version is invalid");
        }
        if (currentVersion !== expectedVersion || currentVersion >= Number.MAX_SAFE_INTEGER) {
          throw new ApiError(
            409,
            "PAGE_COMMENT_EDIT_CONFLICT",
            "This comment changed in another session. Your change was not applied."
          );
        }
        const update = await client.execute<{ affectedRows: number }>(
          `UPDATE page_comments
           SET body = ?, edit_version = edit_version + 1, updated_at = CURRENT_TIMESTAMP(3)
           WHERE page_id = ? AND id = ? AND edit_version = ?`,
          [body, pageId, commentId, expectedVersion]
        );
        if (Number(update.affectedRows) !== 1) {
          throw new ApiError(
            409,
            "PAGE_COMMENT_EDIT_CONFLICT",
            "This comment changed in another session. Your change was not applied."
          );
        }
        const updated = await getPageCommentRow(pageId, commentId, client);
        if (!updated) throw notFound("Page comment");
        return toPageCommentPayload(updated, { id: user.id, isOwner: access.role === "OWNER" || access.role === "ADMIN" });
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ comment });
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.delete(
  "/pages/:pageId/comments/:commentId",
  validate({ params: pageCommentParamsSchema, body: pageCommentDeleteSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const pageId = String(req.params.pageId);
      const commentId = String(req.params.commentId);
      const expectedVersion = Number(req.body.expectedVersion);
      await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(user.id, authScope, client);
        const access = await getPageAccess(pageId, user.id, client, { lockPage: true });
        assertPageCanEdit(access, "This shared collection is read-only for your account");
        assertPageNotArchived(access.page, "Restore the page before deleting a comment");
        const existing = await client.queryOne<{ user_id: string; edit_version: number }>(
          `SELECT user_id, edit_version FROM page_comments
           WHERE page_id = ? AND id = ? FOR UPDATE`,
          [pageId, commentId]
        );
        if (!existing) throw notFound("Page comment");
        if (existing.user_id !== user.id && access.role !== "OWNER" && access.role !== "ADMIN") {
          throw new ApiError(403, "PAGE_COMMENT_DELETE_FORBIDDEN", "You cannot delete this comment");
        }
        const currentVersion = Number(existing.edit_version);
        if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
          throw new ApiError(500, "INVALID_PAGE_COMMENT_VERSION", "The stored comment version is invalid");
        }
        if (currentVersion !== expectedVersion) {
          throw new ApiError(
            409,
            "PAGE_COMMENT_EDIT_CONFLICT",
            "This comment changed in another session. It was not deleted."
          );
        }
        const deletion = await client.execute<{ affectedRows: number }>(
          "DELETE FROM page_comments WHERE page_id = ? AND id = ? AND edit_version = ?",
          [pageId, commentId, expectedVersion]
        );
        if (Number(deletion.affectedRows) !== 1) {
          throw new ApiError(
            409,
            "PAGE_COMMENT_EDIT_CONFLICT",
            "This comment changed before deletion completed. It was not deleted."
          );
        }
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.get(
  "/pages/:pageId/shares",
  validate({ params: idParamSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      // Keep the ownership decision and the share rows in one repeatable-read
      // snapshot. Backup restore/import preserves page IDs, so separate
      // autocommit reads could authorize an old owner generation and then read
      // shares belonging to a replacement page that reused the same ID.
      const rows = await transaction(async (client) => {
        const access = await getPageAccess(pageId, user.id, client);
        assertPageCanAdminister(access);
        assertShareablePage(access.page);
        return getShareRows(pageId, access.page.owner_id, client);
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ shares: rows.map(toSharePayload), count: rows.length });
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.post(
  "/pages/:pageId/shares",
  collaborationShareIpRateLimit,
  collaborationShareAccountRateLimit,
  validate({ params: idParamSchema, body: shareUserSchema }),
  async (req, res, next) => {
    try {
      const actor = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const pageId = String(req.params.pageId);
      const username = String(req.body.username);
      let firstShare = false;
      let previousDocumentEpoch: string | null = null;

      const shareResult = await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(actor.id, authScope, client);
        const access = await getPageAccess(pageId, actor.id, client, { lockPage: true });
        assertPageCanAdminister(access);
        if (access.role !== "OWNER" || access.scope !== "OWNER") {
          throw new ApiError(403, "PAGE_OWNER_REQUIRED", "Direct page shares can only be created by the workspace owner");
        }
        const page = access.page;
        const workspaceOwnerId = page.owner_id;
        assertShareablePage(page);

        const target = await client.queryOne<ShareTargetRow>(
          `SELECT u.id, u.username, u.name, u.avatar_data, u.preferred_language, u.default_collection_icon, u.theme,
                  u.created_at, u.updated_at
           FROM users u
           WHERE u.username = ? AND u.id <> ?
             AND NOT EXISTS (
               SELECT 1 FROM page_shares ps
               WHERE ps.page_id = ? AND ps.user_id = u.id AND ps.permission = 'EDIT'
             )`,
          [username, workspaceOwnerId, pageId]
        );
        if (!target) {
          throw new ApiError(400, "SHARE_TARGET_UNAVAILABLE", "The requested account cannot be added");
        }
        firstShare = (await getEffectivePageShareCount(pageId, client, access.collectionId)) === 0;
        if (firstShare) {
          const previousState = await getCollaborationState(pageId, client, { lock: true });
          previousDocumentEpoch = previousState?.document_epoch ?? null;
          // Another browser can hold a durable direct-edit draft that this
          // browser cannot see. Preserve a server recovery admission before
          // switching this page to a fresh collaboration lineage.
          await grantDirectPageRecovery(client, {
            pageId,
            principalId: workspaceOwnerId,
            ownerId: workspaceOwnerId,
            reason: "SHARE_STARTED"
          });
          await grantLegacyYjsPageRecovery(client, {
            pageId,
            principalId: workspaceOwnerId,
            ownerId: workspaceOwnerId,
            reason: "SHARE_STARTED"
          });
          await assertNoActiveCollaborationWriteLeases(client, [pageId]);
          await client.execute("DELETE FROM page_yjs_updates WHERE page_id = ?", [pageId]);
          await client.execute("DELETE FROM page_collaboration_state WHERE page_id = ?", [pageId]);
          await ensureCollaborationState(pageId, client);
        }
        const shareGeneration = createId("share");
        await client.execute(
          `INSERT INTO page_shares (page_id, user_id, permission, shared_by, generation)
           VALUES (?, ?, 'EDIT', ?, ?)`,
          [pageId, target.id, actor.id, shareGeneration]
        );
        const created = await client.queryOne<ShareUserRow>(
          `SELECT u.id, u.username, u.name, u.avatar_data, u.preferred_language, u.default_collection_icon, u.theme,
                  u.created_at, u.updated_at, ps.permission, ps.created_at AS shared_at, ps.generation AS share_generation
           FROM page_shares ps INNER JOIN users u ON u.id = ps.user_id
           WHERE ps.page_id = ? AND ps.user_id = ? AND ps.permission = 'EDIT'`,
          [pageId, target.id]
        );
        if (!created) throw new ApiError(500, "PAGE_SHARE_FAILED", "The page share was not created");
        const rows = await getShareRows(pageId, workspaceOwnerId, client);
        return { created, count: rows.length };
      });

      if (previousDocumentEpoch) {
        disconnectPageCollaboratorsForDocumentEpoch(
          pageId,
          previousDocumentEpoch,
          "Collaboration state was initialized"
        );
      }
      res.status(201).json({ share: toSharePayload(shareResult.created), count: shareResult.count });
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.delete(
  "/pages/:pageId/shares/:userId",
  validate({ params: shareParamsSchema, body: removeShareSchema }),
  async (req, res, next) => {
    try {
      const actor = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const pageId = String(req.params.pageId);
      const sharedUserId = String(req.params.userId);
      const expectedGeneration = String(req.body.expectedGeneration);
      const result = await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(actor.id, authScope, client);
        const access = await getPageAccess(pageId, actor.id, client, { lockPage: true });
        assertPageCanAdminister(access);
        const page = access.page;
        const workspaceOwnerId = page.owner_id;
        assertShareablePage(page);
        await assertNoActiveCollaborationWriteLeases(client, [pageId]);
        const existingShare = await client.queryOne<{ user_id: string; generation: string }>(
          `SELECT user_id, generation FROM page_shares
           WHERE page_id = ? AND user_id = ? AND permission = 'EDIT'
           FOR UPDATE`,
          [pageId, sharedUserId]
        );
        if (!existingShare) throw notFound("Page share");
        if (existingShare.generation !== expectedGeneration) {
          throw new ApiError(
            409,
            "PAGE_SHARE_GENERATION_CHANGED",
            "The collaborator grant changed in another session. Refresh before removing it."
          );
        }

        // Register both possible local persistence lineages before revoking
        // access. Uploads through these grants are quarantined as recovery
        // candidates and can never mutate the current page automatically.
        await grantDirectPageRecovery(client, {
          pageId,
          principalId: sharedUserId,
          ownerId: workspaceOwnerId,
          reason: "SHARE_REMOVED"
        });
        await grantLegacyYjsPageRecovery(client, {
          pageId,
          principalId: sharedUserId,
          ownerId: workspaceOwnerId,
          reason: "SHARE_REMOVED"
        });
        await grantLegacyYjsPageRecovery(client, {
          pageId,
          principalId: workspaceOwnerId,
          ownerId: workspaceOwnerId,
          reason: "SHARE_REMOVED"
        });
        const preRemovalState = await getCollaborationState(pageId, client, { lock: true });
        if (
          preRemovalState
          && isUnsupportedCollaborationMaterializationVersion(preRemovalState.materialization_version)
        ) {
          throw new ApiError(
            409,
            "COLLABORATION_MATERIALIZATION_VERSION_UNSUPPORTED",
            "This collaboration state was written by a newer BrainVault version. Upgrade this server before removing access."
          );
        }
        if (preRemovalState) {
          await grantYjsPageRecovery(client, {
            pageId,
            principalId: sharedUserId,
            ownerId: workspaceOwnerId,
            documentEpoch: preRemovalState.document_epoch,
            reason: "SHARE_REMOVED"
          });
          await grantYjsPageRecovery(client, {
            pageId,
            principalId: workspaceOwnerId,
            ownerId: workspaceOwnerId,
            documentEpoch: preRemovalState.document_epoch,
            reason: "SHARE_REMOVED"
          });
        }
        const deletion = await client.execute<{ affectedRows: number }>(
          `DELETE FROM page_shares
           WHERE page_id = ? AND user_id = ? AND permission = 'EDIT' AND generation = ?`,
          [pageId, sharedUserId, expectedGeneration]
        );
        if (Number(deletion.affectedRows) === 0) {
          throw new ApiError(
            409,
            "PAGE_SHARE_GENERATION_CHANGED",
            "The collaborator grant changed in another session. Refresh before removing it."
          );
        }
        const remaining = await getEffectivePageShareCount(pageId, client, access.collectionId);
        if (remaining === 0) {
          const latestUpdateRow = await client.queryOne<{ max_update_id: number | null }>(
            "SELECT MAX(id) AS max_update_id FROM page_yjs_updates WHERE page_id = ?",
            [pageId]
          );
          const collaborationState = preRemovalState ?? await getCollaborationState(pageId, client, { lock: true });
          const latestUpdateId = Number(latestUpdateRow?.max_update_id ?? 0);
          const materializedUpdateId = Number(collaborationState?.materialized_update_id ?? 0);
          const materializationVersion = Number(collaborationState?.materialization_version ?? 0);
          if (!Number.isSafeInteger(latestUpdateId) || latestUpdateId < 0) {
            throw new ApiError(
              500,
              "INVALID_COLLABORATION_STATE",
              "Collaboration update id exceeded the supported range"
            );
          }
          if (needsCollaborationMaterialization({
            latestUpdateId,
            materializedUpdateId,
            materializationVersion
          })) {
            throw new ApiError(
              409,
              "COLLABORATION_CHANGES_PENDING",
              "Synchronize the latest collaborative edits before removing the final shared user",
              { latestUpdateId, materializedUpdateId, materializationVersion }
            );
          }
          await client.execute("DELETE FROM page_yjs_updates WHERE page_id = ?", [pageId]);
          await client.execute("DELETE FROM page_collaboration_state WHERE page_id = ?", [pageId]);
        }
        return {
          remaining,
          removedShareGeneration: existingShare.generation,
          removedDocumentEpoch: remaining === 0 ? (preRemovalState?.document_epoch ?? null) : null
        };
      });

      if (result.remaining === 0) {
        if (result.removedDocumentEpoch) {
          disconnectPageCollaboratorsForDocumentEpoch(
            pageId,
            result.removedDocumentEpoch,
            "Collaboration sharing ended"
          );
        }
      } else {
        disconnectSharedUserGrant(
          pageId,
          sharedUserId,
          result.removedShareGeneration,
          "Page access was removed"
        );
      }
      res.json({ removed: true, count: result.remaining });
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.post(
  "/recovery/pages/:pageId/candidates",
  validate({ params: idParamSchema, query: recoveryCandidateUploadQuerySchema }),
  raw({ type: "application/octet-stream", limit: maxRecoveryCandidateBytes }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const pageId = String(req.params.pageId);
      const query = getValidatedQuery<{
        kind: RecoveryCandidateKind;
        documentEpoch?: string;
        sourceId: string;
        generation: string;
      }>(req);
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        throw new ApiError(400, "RECOVERY_CANDIDATE_EMPTY", "A recovery candidate payload is required");
      }
      const lineageKey = query.kind === "YJS_UPDATE"
        ? yjsRecoveryLineageKey(String(query.documentEpoch))
        : query.kind === "YJS_LEGACY_UPDATE"
          ? legacyYjsRecoveryLineageKey()
          : directRecoveryLineageKey();
      const stored = await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(user.id, authScope, client);
        return storeRecoveryCandidate({
          pageId,
          principalId: user.id,
          lineageKey,
          kind: query.kind,
          sourceId: query.sourceId,
          generation: query.generation,
          payload: req.body
        }, client);
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.status(stored.created ? 201 : 200).json({ candidate: stored });
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.get("/recovery/candidates", async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const candidates = await listRecoveryCandidates(user.id);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        pageId: candidate.page_id,
        principalId: candidate.principal_id,
        ownerId: candidate.owner_id,
        lineageKey: candidate.lineage_key,
        kind: candidate.kind,
        sourceId: candidate.source_id,
        generation: candidate.generation,
        payloadSha256: candidate.payload_sha256,
        payloadBytes: Number(candidate.payload_bytes),
        createdAt: candidate.created_at
      }))
    });
  } catch (error) {
    next(error);
  }
});

collaborationRouter.get(
  "/recovery/candidates/:candidateId",
  validate({ params: recoveryCandidateParamsSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const candidate = await getRecoveryCandidate(String(req.params.candidateId), user.id);
      const safeFilename = `${candidate.id}-${candidate.kind === "DIRECT_DRAFT" ? "draft.json" : "yjs.bin"}`;
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
      res.setHeader("X-BrainVault-Recovery-SHA256", candidate.payload_sha256);
      res.send(candidate.payload);
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.delete(
  "/recovery/candidates/:candidateId",
  validate({ params: recoveryCandidateParamsSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const candidateId = String(req.params.candidateId);
      await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(user.id, authScope, client);
        await deleteRecoveryCandidate(candidateId, user.id, client);
      });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.post(
  "/pages/:pageId/collaboration/session",
  collaborationSessionPageRateLimit,
  validate({ params: idParamSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const pageId = String(req.params.pageId);
      if (!collaborationSessionSchema.safeParse(req.body).success) {
        throw new ApiError(
          409,
          "COLLABORATION_CLIENT_REFRESH_REQUIRED",
          "Refresh BrainVault before reconnecting to this collaboration document"
        );
      }
      const authSessionToken = readAuthSessionCookie(req);
      if (!authSessionToken) {
        throw new ApiError(
          401,
          "COLLABORATION_COOKIE_SESSION_REQUIRED",
          "Live collaboration requires the authenticated browser session cookie"
        );
      }
      const session = await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(user.id, authScope, client);
        const access = await getPageAccess(pageId, user.id, client, { lockPage: true });
        assertShareablePage(access.page);
        if (access.shareCount < 1) {
          throw new ApiError(409, "COLLABORATION_DISABLED", "Add at least one shared user to enable collaboration");
        }
        const collaborationState = await ensureCollaborationState(pageId, client);
        const documentBlocks = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY COALESCE(parent_block_id, ''), sort_order ASC, id ASC",
          [pageId]
        );
        return { access, collaborationState, documentBlocks };
      });
      const authVersion = authScope.authVersion;
      const webRtcSignal = getClientWebRtcSignal(req);
      const ticket = signCollaborationToken({
        sub: user.id,
        username: user.username,
        pageId,
        documentEpoch: session.collaborationState.document_epoch,
        shareGeneration: session.access.shareGeneration,
        authVersion,
        workspaceGeneration: authScope.workspaceGeneration,
        sessionBinding: createCollaborationSessionBinding(authSessionToken),
        scope: "page:collaborate",
        webRtcState: webRtcSignal.state,
        webRtcObservedIps: webRtcSignal.observedIps
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        pageId,
        documentEpoch: session.collaborationState.document_epoch,
        protocol: collaborationWebSocketProtocol,
        ticketProtocol: `${collaborationTicketProtocolPrefix}${ticket}`,
        path: `/api/collaboration/${encodeURIComponent(pageId)}`,
        expiresIn: collaborationTicketTtlSeconds,
        access: toAccessPayload(session.access),
        collaboration: toCollaborationPayload(session.access),
        document: {
          title: session.access.page.title,
          blocks: session.documentBlocks.map(toBlock)
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.put(
  "/pages/:pageId/collaboration/snapshot",
  validate({ params: idParamSchema, body: materializeSchema }),
  async (req, res, next) => {
    const deletedFiles: string[] = [];
    let attachmentCleanupOwnerId: string | null = null;
    let attachmentCleanupGeneration: number | null = null;
    let attachmentCleanupCompleted = false;
    const reconcileDeletedAttachmentFiles = async () => {
      if (
        attachmentCleanupCompleted
        || !deletedFiles.length
        || attachmentCleanupOwnerId === null
        || attachmentCleanupGeneration === null
      ) return;
      await removeDeletedAttachmentFiles(
        attachmentCleanupOwnerId,
        deletedFiles,
        attachmentCleanupGeneration
      );
      attachmentCleanupCompleted = true;
    };

    try {
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const pageId = String(req.params.pageId);
      const body = req.body as z.infer<typeof materializeSchema>;

      // Resolve and authorize the owner without taking a page lock. The
      // transaction can then preserve the global user-before-page lock order
      // used by workspace restore while re-checking access under the page lock.
      const preflightAccess = await getPageAccess(pageId, user.id);
      const attachmentOwnerId = preflightAccess.page.owner_id;
      attachmentCleanupOwnerId = attachmentOwnerId;

      const result = await transaction(async (client) => {
        // Shared editors can differ from the attachment owner. Lock every
        // participating user row deterministically before the auth/session
        // boundary and page row to preserve the global user-before-page order.
        await lockCollaborationMutationUsers(client, [user.id, attachmentOwnerId]);
        await assertCurrentAuthSessionBoundary(user.id, authScope, client);
        const attachmentGeneration = await lockUserAttachmentGeneration(client, attachmentOwnerId);
        if (attachmentGeneration === undefined) throw notFound("Page");
        attachmentCleanupGeneration = attachmentGeneration;

        const access = await getPageAccess(pageId, user.id, client, { lockPage: true });
        if (access.page.owner_id !== attachmentOwnerId) {
          throw new ApiError(
            409,
            "PAGE_OWNER_CHANGED",
            "The page owner changed before collaboration materialization. Refresh and try again."
          );
        }
        assertShareablePage(access.page);
        assertPageCanEdit(access, "This shared collection is read-only for your account");
        if (access.shareCount < 1) {
          throw new ApiError(409, "COLLABORATION_DISABLED", "Collaboration is no longer enabled");
        }

        // Every Yjs writer first locks the page row. Holding the same lock makes
        // this ordered history immutable until the relational transaction ends.
        // Inspect aggregate metadata before selecting BLOBs so a legacy or
        // tampered log cannot force an unbounded HTTP materialization replay.
        const historyStats = await client.queryOne<CollaborationHistoryStatsRow>(
          `SELECT COUNT(*) AS history_entries,
                  COALESCE(SUM(OCTET_LENGTH(update_data)), 0) AS history_bytes
           FROM page_yjs_updates
           WHERE page_id = ?`,
          [pageId]
        );
        const historyEntries = toSafeHistoryMetric(historyStats?.history_entries, "entry count");
        const historyBytes = toSafeHistoryMetric(historyStats?.history_bytes, "byte count");
        const replayAssessment = assessCollaborationHistoryReplay({ historyEntries, historyBytes });
        if (!replayAssessment.accepted) {
          throw new ApiError(
            503,
            "COLLABORATION_HISTORY_REPLAY_LIMIT",
            "Stored collaboration history exceeds the safe replay limit"
          );
        }

        const updateRows = await client.query<CollaborationUpdateRow>(
          `SELECT id, update_data, user_id
           FROM page_yjs_updates
           WHERE page_id = ?
           ORDER BY id ASC
           FOR UPDATE`,
          [pageId]
        );
        const actualHistoryBytes = updateRows.reduce(
          (total, row) => total + Buffer.from(row.update_data).length,
          0
        );
        if (updateRows.length !== historyEntries || actualHistoryBytes !== historyBytes) {
          throw new ApiError(
            500,
            "INVALID_COLLABORATION_STATE",
            "Stored collaboration history changed during bounded replay"
          );
        }
        const latestUpdateId = Number(updateRows.at(-1)?.id ?? 0);
        if (!Number.isSafeInteger(latestUpdateId) || latestUpdateId !== body.updateId) {
          throw new ApiError(
            409,
            "COLLABORATION_SNAPSHOT_STALE",
            "A newer collaboration update must be applied before materializing this page",
            { lastUpdateId: latestUpdateId }
          );
        }

        const state = await getCollaborationState(pageId, client, { lock: true });
        assertCollaborationDocumentEpoch(state, body.documentEpoch);
        const materializedUpdateId = Number(state.materialized_update_id ?? 0);
        const materializationVersion = Number(state.materialization_version ?? 0);
        if (isUnsupportedCollaborationMaterializationVersion(materializationVersion)) {
          throw new ApiError(
            409,
            "COLLABORATION_MATERIALIZATION_VERSION_UNSUPPORTED",
            "This collaboration state was written by a newer BrainVault version. Upgrade this server before materializing the page."
          );
        }
        if (materializedUpdateId > latestUpdateId) {
          throw new ApiError(
            500,
            "INVALID_COLLABORATION_STATE",
            "The collaboration materialization checkpoint is ahead of durable history"
          );
        }

        if (!needsCollaborationMaterialization({
          latestUpdateId,
          materializedUpdateId,
          materializationVersion
        })) {
          const currentPage = await client.queryOne<PageRow>(
            "SELECT * FROM pages WHERE id = ? AND owner_id = ?",
            [pageId, attachmentOwnerId]
          );
          const currentBlocks = await client.query<BlockRow>(
            "SELECT * FROM blocks WHERE page_id = ? ORDER BY COALESCE(parent_block_id, ''), sort_order ASC, id ASC",
            [pageId]
          );
          if (!currentPage) throw notFound("Page");
          return {
            applied: false,
            page: currentPage,
            blocks: currentBlocks,
            ownerId: currentPage.owner_id,
            attachmentGeneration,
            materializedUpdateId
          };
        }

        let materialization: CollaborationMaterialization;
        try {
          // The durable Yjs log is the sole content authority. updateId is only
          // a checkpoint; browser-supplied relational content is never accepted.
          // Replay and semantic decoding stay inside a resource-capped worker.
          materialization = (await collaborationMaterializationPool.materializeHistory({
            principalKey: user.id,
            updates: updateRows.map((row) => Buffer.from(row.update_data))
          })).materialization;
        } catch (error) {
          if (error instanceof CollaborationDocumentError) {
            throw new ApiError(409, error.code, error.message);
          }
          if (
            error instanceof CollaborationValidationCapacityError
            || error instanceof CollaborationValidationResourceLimitError
            || error instanceof CollaborationHistoryTimeoutError
          ) {
            throw new ApiError(
              503,
              "COLLABORATION_MATERIALIZATION_UNAVAILABLE",
              "Collaboration materialization exceeded the available server resource budget. Retry shortly."
            );
          }
          throw error;
        }

        const orderedBlocks = materialization.blocks.map((block) => ({
          ...block,
          metadata: assertLosslessStructuredMetadata(block.type, block.metadata) as Record<string, unknown> | null
        }));
        const activeIds = new Set(orderedBlocks.map((block) => block.id));
        const deletedAttachmentIds = new Set(materialization.deletedAttachmentIds);
        for (const blockId of deletedAttachmentIds) {
          if (activeIds.has(blockId)) {
            throw new ApiError(
              409,
              "ATTACHMENT_DELETE_CONFLICT",
              "An attachment cannot be active and deleted in the same collaboration document"
            );
          }
        }

        const existingRows = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY id ASC FOR UPDATE",
          [pageId]
        );
        // Access projections intentionally hide custom cover bytes. Version diffs need the
        // raw row so an unrelated collaboration materialization does not look like a cover change.
        const versionBeforePage = await client.queryOne<PageRow>(
          "SELECT * FROM pages WHERE id = ? AND owner_id = ?",
          [pageId, attachmentOwnerId]
        );
        if (!versionBeforePage) throw notFound("Page");
        const versionBeforeRows = existingRows.map((row) => ({ ...row }));
        const existingById = new Map(existingRows.map((row) => [row.id, row]));
        const newBlockIds = orderedBlocks
          .map((block) => block.id)
          .filter((blockId) => !existingById.has(blockId));
        for (let offset = 0; offset < newBlockIds.length; offset += 500) {
          const batch = newBlockIds.slice(offset, offset + 500);
          if (!batch.length) continue;
          const placeholders = batch.map(() => "?").join(", ");
          const conflicts = await client.query<{ id: string }>(
            `SELECT id FROM blocks WHERE id IN (${placeholders}) FOR UPDATE`,
            batch
          );
          if (conflicts.length) {
            throw new ApiError(
              409,
              "BLOCK_ID_CONFLICT",
              "A collaboration block id is already in use"
            );
          }
        }

        for (const block of orderedBlocks) {
          const existing = existingById.get(block.id);
          if (block.type === "ATTACHMENT" && !existing) {
            throw new ApiError(
              400,
              "USE_ATTACHMENT_UPLOAD",
              "Attachment blocks must be created through the file upload endpoint"
            );
          }
          if (existing?.type === "ATTACHMENT" && block.type !== "ATTACHMENT") {
            throw new ApiError(400, "ATTACHMENT_TYPE_IMMUTABLE", "Attachment blocks cannot be converted");
          }
          if (existing && existing.type !== "ATTACHMENT" && block.type === "ATTACHMENT") {
            throw new ApiError(400, "ATTACHMENT_TYPE_IMMUTABLE", "Blocks cannot be converted into attachments");
          }
        }

        // Materialization can rewrite or delete any canonical non-attachment row based
        // on the Yjs document. Validate the full raw relational set first so a
        // recoverable block omitted from orderedBlocks cannot bypass the guard and be
        // deleted below before explicit recovery or repair.
        for (const existing of existingRows) {
          if (existing.type !== "ATTACHMENT") {
            assertExistingMetadataSafeToMaterialize(existing);
          }
        }

        // The block parent FK uses ON DELETE CASCADE. Detach every row that must survive
        // before deleting an obsolete ancestor, otherwise a legitimate moved child (or a
        // canonical attachment omitted from the Yjs document) could be deleted implicitly.
        const deletedExistingIds = new Set(
          existingRows
            .filter((row) => row.type === "ATTACHMENT"
              ? deletedAttachmentIds.has(row.id)
              : !activeIds.has(row.id))
            .map((row) => row.id)
        );
        for (const row of existingRows) {
          if (deletedExistingIds.has(row.id)) continue;
          if (!row.parent_block_id || !deletedExistingIds.has(row.parent_block_id)) continue;
          const detachedSurvivor = await client.execute<{ affectedRows: number }>(
            "UPDATE blocks SET parent_block_id = NULL, last_mutation_id = NULL, last_mutation_hash = NULL, edit_version = edit_version + 1 WHERE id = ? AND page_id = ?",
            [row.id, pageId]
          );
          if (Number(detachedSurvivor.affectedRows) !== 1) {
            throw new ApiError(
              409,
              "COLLABORATION_MATERIALIZATION_CONFLICT",
              "A canonical block changed before collaboration materialization completed"
            );
          }
          row.parent_block_id = null;
        }

        // Delete intended descendants before ancestors so the parent FK cascade never
        // substitutes for an explicit, page-scoped destructive write. This lets every
        // canonical deletion prove that exactly one locked row was removed.
        const parentByDeletedId = new Map(
          existingRows
            .filter((row) => deletedExistingIds.has(row.id))
            .map((row) => [row.id, row.parent_block_id] as const)
        );
        const deletedDepth = (row: BlockRow) => {
          let depth = 0;
          let currentId = row.id;
          const visited = new Set<string>();
          while (!visited.has(currentId)) {
            visited.add(currentId);
            const parentId = parentByDeletedId.get(currentId);
            if (!parentId || !deletedExistingIds.has(parentId)) break;
            depth += 1;
            currentId = parentId;
          }
          return depth;
        };
        const rowsToDelete = existingRows
          .filter((row) => deletedExistingIds.has(row.id))
          .sort((left, right) => deletedDepth(right) - deletedDepth(left) || left.id.localeCompare(right.id));

        for (const row of rowsToDelete) {
          const deletion = await client.execute<{ affectedRows: number }>(
            "DELETE FROM blocks WHERE id = ? AND page_id = ?",
            [row.id, pageId]
          );
          if (Number(deletion.affectedRows) !== 1) {
            throw new ApiError(
              409,
              "COLLABORATION_MATERIALIZATION_CONFLICT",
              "A canonical block changed before collaboration materialization completed"
            );
          }
          if (row.type === "ATTACHMENT" && deletedAttachmentIds.has(row.id)) {
            deletedFiles.push(row.id);
          }
          existingById.delete(row.id);
        }

        for (const block of orderedBlocks) {
          const existing = existingById.get(block.id);
          if (existing?.type === "ATTACHMENT") {
            const attachmentUpdate = await client.execute<{ affectedRows: number }>(
              `UPDATE blocks
               SET parent_block_id = ?, sort_order = ?, last_mutation_id = NULL,
                   last_mutation_hash = NULL, edit_version = edit_version + 1
               WHERE id = ? AND page_id = ?`,
              [block.parentBlockId, block.sortOrder, block.id, pageId]
            );
            if (Number(attachmentUpdate.affectedRows) !== 1) {
              throw new ApiError(
                409,
                "COLLABORATION_MATERIALIZATION_CONFLICT",
                "A canonical attachment changed before collaboration materialization completed"
              );
            }
            continue;
          }

          const prepared = prepareBlockContent(block.type, block.markdown, block.metadata);
          const html = renderBlockHtml(block.type, prepared.markdown, block.checked, prepared.metadata);
          const metadata = prepared.metadata ? JSON.stringify(prepared.metadata) : null;
          if (existing) {
            const blockUpdate = await client.execute<{ affectedRows: number }>(
              `UPDATE blocks
               SET parent_block_id = ?, type = ?, markdown = ?, html_cache = ?, checked = ?, sort_order = ?,
                   metadata = ?, last_mutation_id = NULL, last_mutation_hash = NULL,
                   edit_version = edit_version + 1
               WHERE id = ? AND page_id = ?`,
              [
                block.parentBlockId,
                block.type,
                prepared.markdown,
                html,
                block.checked ? 1 : 0,
                block.sortOrder,
                metadata,
                block.id,
                pageId
              ]
            );
            if (Number(blockUpdate.affectedRows) !== 1) {
              throw new ApiError(
                409,
                "COLLABORATION_MATERIALIZATION_CONFLICT",
                "A canonical block changed before collaboration materialization completed"
              );
            }
          } else {
            await client.execute(
              `INSERT INTO blocks
                 (id, page_id, parent_block_id, type, markdown, html_cache, checked, sort_order, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                block.id,
                pageId,
                block.parentBlockId,
                block.type,
                prepared.markdown,
                html,
                block.checked ? 1 : 0,
                block.sortOrder,
                metadata
              ]
            );
          }
        }

        const pageUpdate = await client.execute<{ affectedRows: number }>(
          `UPDATE pages
           SET title = ?, last_mutation_id = NULL, last_mutation_hash = NULL,
               edit_version = edit_version + 1, content_version = content_version + 1
           WHERE id = ? AND owner_id = ?`,
          [materialization.title, pageId, attachmentOwnerId]
        );
        if (Number(pageUpdate.affectedRows) !== 1) {
          throw new ApiError(
            409,
            "COLLABORATION_MATERIALIZATION_CONFLICT",
            "The canonical page changed before collaboration materialization completed"
          );
        }

        // Do not advance the durable materialization checkpoint until the canonical
        // relational state exactly matches the collaboration document. Checking IDs
        // alone can certify a same-ID row whose content or hierarchy was not persisted
        // as intended. Attachments omitted from Yjs are intentionally retained unless
        // explicitly tombstoned, so verify their retained hierarchy separately.
        const currentPage = await client.queryOne<PageRow>(
          "SELECT * FROM pages WHERE id = ? AND owner_id = ?",
          [pageId, attachmentOwnerId]
        );
        const currentBlocks = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY COALESCE(parent_block_id, ''), sort_order ASC, id ASC",
          [pageId]
        );
        if (!currentPage) throw notFound("Page");
        const expectedFinalBlockIds = new Set(activeIds);
        for (const row of existingRows) {
          if (row.type === "ATTACHMENT" && !deletedAttachmentIds.has(row.id)) {
            expectedFinalBlockIds.add(row.id);
          }
        }
        const currentBlockIds = new Set(currentBlocks.map((row) => row.id));
        const canonicalBlockSetMatches = currentBlockIds.size === expectedFinalBlockIds.size
          && [...expectedFinalBlockIds].every((blockId) => currentBlockIds.has(blockId));
        const currentBlocksById = new Map(currentBlocks.map((row) => [row.id, row]));
        let canonicalMaterializedStateMatches = currentPage.title === materialization.title;

        for (const block of orderedBlocks) {
          if (!canonicalMaterializedStateMatches) break;
          const current = currentBlocksById.get(block.id);
          if (
            !current
            || current.type !== block.type
            || current.parent_block_id !== block.parentBlockId
            || Number(current.sort_order) !== Number(block.sortOrder)
          ) {
            canonicalMaterializedStateMatches = false;
            break;
          }

          // Attachment payload metadata is owned by the upload route. Collaboration
          // materialization is authoritative only for its hierarchy/order.
          if (block.type === "ATTACHMENT") continue;

          const prepared = prepareBlockContent(block.type, block.markdown, block.metadata);
          const expectedHtml = renderBlockHtml(block.type, prepared.markdown, block.checked, prepared.metadata);
          if (
            current.markdown !== prepared.markdown
            || current.html_cache !== expectedHtml
            || Number(current.checked) !== (block.checked ? 1 : 0)
            || canonicalJsonForComparison(current.metadata) !== canonicalJsonForComparison(prepared.metadata)
          ) {
            canonicalMaterializedStateMatches = false;
            break;
          }
        }

        if (canonicalMaterializedStateMatches) {
          for (const row of existingRows) {
            if (
              row.type !== "ATTACHMENT"
              || deletedAttachmentIds.has(row.id)
              || activeIds.has(row.id)
            ) continue;
            const current = currentBlocksById.get(row.id);
            if (
              !current
              || current.type !== "ATTACHMENT"
              || current.parent_block_id !== row.parent_block_id
              || Number(current.sort_order) !== Number(row.sort_order)
            ) {
              canonicalMaterializedStateMatches = false;
              break;
            }
          }
        }

        if (!canonicalBlockSetMatches || !canonicalMaterializedStateMatches) {
          throw new ApiError(
            409,
            "COLLABORATION_MATERIALIZATION_CONFLICT",
            "The canonical page state did not match the collaboration document"
          );
        }

        const checkpoint = await client.execute<{ affectedRows: number }>(
          `UPDATE page_collaboration_state
           SET materialized_update_id = ?, materialization_version = ?,
               materialized_at = CURRENT_TIMESTAMP(3)
           WHERE page_id = ? AND document_epoch = ?`,
          [
            latestUpdateId,
            currentCollaborationMaterializationVersion,
            pageId,
            body.documentEpoch
          ]
        );
        if (Number(checkpoint.affectedRows) !== 1) {
          throw new ApiError(
            409,
            "COLLABORATION_LINEAGE_CHANGED",
            "The collaboration document was replaced before materialization completed"
          );
        }

        const versionActors = await loadPageVersionActors(
          client,
          updateRows
            .filter((row) => Number(row.id) > materializedUpdateId)
            .map((row) => row.user_id)
        );
        await recordPageVersion(client, {
          pageId,
          actors: versionActors.length ? versionActors : [toPageVersionActor(user)],
          source: "COLLABORATION",
          changes: [
            ...diffPageVersionPage(versionBeforePage, currentPage),
            ...diffPageVersionBlocks(versionBeforeRows, currentBlocks)
          ]
        });
        return {
          applied: true,
          page: currentPage,
          blocks: currentBlocks,
          ownerId: currentPage.owner_id,
          attachmentGeneration,
          materializedUpdateId: latestUpdateId
        };
      });

      await reconcileDeletedAttachmentFiles();
      res.json({
        applied: result.applied,
        documentEpoch: body.documentEpoch,
        materializedUpdateId: result.materializedUpdateId,
        pageVersion: Number(result.page.edit_version ?? 1),
        pageContentVersion: Number(result.page.content_version ?? 1),
        pageUpdatedAt: result.page.updated_at,
        blocks: result.blocks.map(toBlock)
      });
    } catch (error) {
      try {
        // The SQL transaction may have committed even when COMMIT acknowledgement
        // was lost. Reconcile against the live canonical rows before surfacing
        // the original error so a successful attachment tombstone cannot strand
        // bytes forever. The helper is generation-scoped and reference-aware,
        // so a rollback or workspace restore keeps any still-live/new-generation file.
        await reconcileDeletedAttachmentFiles();
      } catch (cleanupError) {
        console.error("Failed to reconcile collaboration attachment cleanup after materialization failure", {
          errorName: cleanupError instanceof Error ? cleanupError.name : typeof cleanupError,
          deletedFileCount: deletedFiles.length
        });
      }
      next(error);
    }
  }
);
