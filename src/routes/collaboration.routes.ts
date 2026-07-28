import { Router } from "express";
import { z } from "zod";
import { db, transaction, type DbClient } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { blockTypeSchema, idParamSchema, requireUser, usernameSchema } from "../utils/schemas.js";
import { ApiError, notFound } from "../lib/http.js";
import {
  assertCollaborationDocumentEpoch,
  ensureCollaborationState,
  getCollaborationState
} from "../lib/collaboration-lineage.js";
import { getOwnedPage, getPageAccess, toAccessPayload, toCollaborationPayload } from "../lib/page-access.js";
import {
  collaborationTicketTtlSeconds,
  signCollaborationToken
} from "../lib/collaboration-token.js";
import {
  collaborationTicketProtocolPrefix,
  collaborationWebSocketProtocol,
  disconnectPageCollaborators,
  disconnectSharedUser
} from "../lib/collaboration-server.js";
import { toBlock, toPublicUser } from "../lib/mappers.js";
import { renderBlockHtml } from "../lib/markdown.js";
import {
  getBookmarkData,
  normalizeBookmarkMetadata,
  summarizeBookmarkData
} from "../lib/bookmark.js";
import { getAiChatData, normalizeAiChatMetadata, summarizeAiChatData } from "../lib/ai-chat.js";
import { removeDeletedAttachmentFiles } from "../lib/attachments.js";
import {
  CollaborationDocumentError,
  validateCollaborationBlockHierarchy
} from "../lib/collaboration-document.js";
import type { BlockRow, PageRow, UserRow } from "../types/domain.js";

export const collaborationRouter = Router();
collaborationRouter.use(requireAuth);

const shareUserSchema = z.object({
  username: usernameSchema
});

const shareParamsSchema = z.object({
  pageId: z.string().min(1),
  userId: z.string().min(1)
});

const materializedBlockSchema = z.object({
  id: z.string().min(1).max(64),
  type: blockTypeSchema,
  markdown: z.string().max(20_000).default(""),
  checked: z.boolean().default(false),
  parentBlockId: z.string().min(1).max(64).nullable().default(null),
  sortOrder: z.number().int().min(0).max(2_147_483_647),
  metadata: z.record(z.string(), z.unknown()).nullable().default(null)
});

const collaborationSessionSchema = z.object({
  documentEpochProtocol: z.literal(1)
}).strict();

const materializeSchema = z.object({
  documentEpoch: z.string().min(1).max(64),
  title: z.string().max(160).refine((value) => value.trim().length > 0, {
    message: "Page title cannot be blank"
  }),
  blocks: z.array(materializedBlockSchema).max(10_000),
  deletedAttachmentIds: z.array(z.string().min(1).max(64)).max(10_000).default([]),
  updateId: z.number().int().min(1)
});

type ShareUserRow = Pick<
  UserRow,
  | "id"
  | "username"
  | "name"
  | "avatar_data"
  | "preferred_language"
  | "default_collection_icon"
  | "created_at"
  | "updated_at"
> & { permission: "EDIT"; shared_at: string };

function assertShareablePage(page: PageRow) {
  if (page.is_collection) {
    throw new ApiError(400, "COLLECTION_SHARING_UNSUPPORTED", "Collections cannot be shared for live editing");
  }
  if (page.is_archived) {
    throw new ApiError(400, "ARCHIVED_PAGE_SHARING_UNSUPPORTED", "Restore the page before sharing it");
  }
}

async function getShareRows(pageId: string, client: DbClient = db) {
  return client.query<ShareUserRow>(
    `SELECT u.id, u.username, u.name, u.avatar_data, u.preferred_language, u.default_collection_icon,
            u.created_at, u.updated_at, ps.permission, ps.created_at AS shared_at
     FROM page_shares ps
     INNER JOIN users u ON u.id = ps.user_id
     WHERE ps.page_id = ?
     ORDER BY ps.created_at ASC, u.username ASC`,
    [pageId]
  );
}

function toSharePayload(row: ShareUserRow) {
  return {
    user: toPublicUser(row),
    permission: row.permission,
    sharedAt: row.shared_at
  };
}

function prepareBlockContent(type: BlockRow["type"], markdown: string, metadata: unknown) {
  if (type === "BOOKMARK") {
    const normalizedMetadata = normalizeBookmarkMetadata(metadata);
    return {
      markdown: summarizeBookmarkData(getBookmarkData(normalizedMetadata)),
      metadata: normalizedMetadata
    };
  }
  if (type === "AI_CHAT") {
    const normalizedMetadata = normalizeAiChatMetadata(metadata);
    return {
      markdown: summarizeAiChatData(getAiChatData(normalizedMetadata)),
      metadata: normalizedMetadata
    };
  }
  return { markdown, metadata };
}


collaborationRouter.get(
  "/pages/:pageId/shares",
  validate({ params: idParamSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const page = await getOwnedPage(pageId, user.id);
      assertShareablePage(page);
      const rows = await getShareRows(pageId);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ shares: rows.map(toSharePayload), count: rows.length });
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.post(
  "/pages/:pageId/shares",
  validate({ params: idParamSchema, body: shareUserSchema }),
  async (req, res, next) => {
    try {
      const owner = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const username = String(req.body.username);
      let firstShare = false;

      const sharedUser = await transaction(async (client) => {
        const page = await client.queryOne<PageRow>(
          "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
          [pageId, owner.id]
        );
        if (!page) throw notFound("Page");
        assertShareablePage(page);

        const target = await client.queryOne<ShareUserRow>(
          `SELECT id, username, name, avatar_data, preferred_language, default_collection_icon,
                  created_at, updated_at, 'EDIT' AS permission, created_at AS shared_at
           FROM users WHERE username = ?`,
          [username]
        );
        if (!target) throw notFound("User");
        if (target.id === owner.id) {
          throw new ApiError(400, "CANNOT_SHARE_WITH_SELF", "The page owner already has access");
        }

        const existing = await client.queryOne<{ user_id: string }>(
          "SELECT user_id FROM page_shares WHERE page_id = ? AND user_id = ?",
          [pageId, target.id]
        );
        if (existing) {
          throw new ApiError(409, "PAGE_ALREADY_SHARED", "This user already has access to the page");
        }
        const count = await client.queryOne<{ share_count: number }>(
          "SELECT COUNT(*) AS share_count FROM page_shares WHERE page_id = ?",
          [pageId]
        );
        firstShare = Number(count?.share_count ?? 0) === 0;
        if (firstShare) {
          await client.execute("DELETE FROM page_yjs_updates WHERE page_id = ?", [pageId]);
          await client.execute("DELETE FROM page_collaboration_state WHERE page_id = ?", [pageId]);
          await ensureCollaborationState(pageId, client);
        }
        await client.execute(
          `INSERT INTO page_shares (page_id, user_id, permission, shared_by)
           VALUES (?, ?, 'EDIT', ?)`,
          [pageId, target.id, owner.id]
        );
        const created = await client.queryOne<ShareUserRow>(
          `SELECT u.id, u.username, u.name, u.avatar_data, u.preferred_language, u.default_collection_icon,
                  u.created_at, u.updated_at, ps.permission, ps.created_at AS shared_at
           FROM page_shares ps INNER JOIN users u ON u.id = ps.user_id
           WHERE ps.page_id = ? AND ps.user_id = ?`,
          [pageId, target.id]
        );
        if (!created) throw new ApiError(500, "PAGE_SHARE_FAILED", "The page share was not created");
        return created;
      });

      if (firstShare) disconnectPageCollaborators(pageId, "Collaboration state was initialized");
      const rows = await getShareRows(pageId);
      res.status(201).json({ share: toSharePayload(sharedUser), count: rows.length });
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.delete(
  "/pages/:pageId/shares/:userId",
  validate({ params: shareParamsSchema }),
  async (req, res, next) => {
    try {
      const owner = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const sharedUserId = String(req.params.userId);
      const result = await transaction(async (client) => {
        const page = await client.queryOne<PageRow>(
          "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
          [pageId, owner.id]
        );
        if (!page) throw notFound("Page");
        const deletion = await client.execute<{ affectedRows: number }>(
          "DELETE FROM page_shares WHERE page_id = ? AND user_id = ?",
          [pageId, sharedUserId]
        );
        if (Number(deletion.affectedRows) === 0) throw notFound("Page share");
        const count = await client.queryOne<{ share_count: number }>(
          "SELECT COUNT(*) AS share_count FROM page_shares WHERE page_id = ?",
          [pageId]
        );
        const remaining = Number(count?.share_count ?? 0);
        if (remaining === 0) {
          const latestUpdateRow = await client.queryOne<{ max_update_id: number | null }>(
            "SELECT MAX(id) AS max_update_id FROM page_yjs_updates WHERE page_id = ?",
            [pageId]
          );
          const collaborationState = await client.queryOne<{ materialized_update_id: number }>(
            "SELECT materialized_update_id FROM page_collaboration_state WHERE page_id = ?",
            [pageId]
          );
          const latestUpdateId = Number(latestUpdateRow?.max_update_id ?? 0);
          const materializedUpdateId = Number(collaborationState?.materialized_update_id ?? 0);
          if (latestUpdateId > materializedUpdateId) {
            throw new ApiError(
              409,
              "COLLABORATION_CHANGES_PENDING",
              "Synchronize the latest collaborative edits before removing the final shared user",
              { latestUpdateId, materializedUpdateId }
            );
          }
          await client.execute("DELETE FROM page_yjs_updates WHERE page_id = ?", [pageId]);
          await client.execute("DELETE FROM page_collaboration_state WHERE page_id = ?", [pageId]);
        }
        return remaining;
      });

      disconnectSharedUser(pageId, sharedUserId);
      if (result === 0) disconnectPageCollaborators(pageId);
      res.json({ removed: true, count: result });
    } catch (error) {
      next(error);
    }
  }
);

collaborationRouter.post(
  "/pages/:pageId/collaboration/session",
  validate({ params: idParamSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      if (!collaborationSessionSchema.safeParse(req.body).success) {
        throw new ApiError(
          409,
          "COLLABORATION_CLIENT_REFRESH_REQUIRED",
          "Refresh BrainVault before reconnecting to this collaboration document"
        );
      }
      const session = await transaction(async (client) => {
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
      const ticket = signCollaborationToken({
        sub: user.id,
        username: user.username,
        pageId,
        documentEpoch: session.collaborationState.document_epoch,
        scope: "page:collaborate"
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
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const body = req.body as z.infer<typeof materializeSchema>;
      let orderedBlocks: z.infer<typeof materializedBlockSchema>[];
      try {
        orderedBlocks = validateCollaborationBlockHierarchy(body.blocks);
      } catch (error) {
        if (error instanceof CollaborationDocumentError) {
          throw new ApiError(400, error.code, error.message);
        }
        throw error;
      }
      const activeIds = new Set(orderedBlocks.map((block) => block.id));
      const deletedAttachmentIds = new Set(body.deletedAttachmentIds);
      for (const blockId of deletedAttachmentIds) {
        if (activeIds.has(blockId)) {
          throw new ApiError(
            400,
            "ATTACHMENT_DELETE_CONFLICT",
            "An attachment cannot be active and deleted in the same collaboration snapshot"
          );
        }
      }
      const deletedFiles: string[] = [];

      const result = await transaction(async (client) => {
        const access = await getPageAccess(pageId, user.id, client, { lockPage: true });
        assertShareablePage(access.page);
        if (access.shareCount < 1) {
          throw new ApiError(409, "COLLABORATION_DISABLED", "Collaboration is no longer enabled");
        }

        const latestUpdateRow = await client.queryOne<{ max_update_id: number | null }>(
          "SELECT MAX(id) AS max_update_id FROM page_yjs_updates WHERE page_id = ?",
          [pageId]
        );
        const latestUpdateId = Number(latestUpdateRow?.max_update_id ?? 0);
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
        if (body.updateId <= materializedUpdateId) {
          const currentPage = await client.queryOne<PageRow>("SELECT * FROM pages WHERE id = ?", [pageId]);
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
            materializedUpdateId
          };
        }

        const existingRows = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY id ASC FOR UPDATE",
          [pageId]
        );
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

        // The block parent FK uses ON DELETE CASCADE. Detach every row that must survive
        // before deleting an obsolete ancestor, otherwise a legitimate moved child (or a
        // canonical attachment omitted from the Yjs payload) could be deleted implicitly.
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
          await client.execute(
            "UPDATE blocks SET parent_block_id = NULL, edit_version = edit_version + 1 WHERE id = ? AND page_id = ?",
            [row.id, pageId]
          );
          row.parent_block_id = null;
        }

        for (const row of existingRows) {
          if (row.type !== "ATTACHMENT" || !deletedAttachmentIds.has(row.id)) continue;
          deletedFiles.push(row.id);
          await client.execute("DELETE FROM blocks WHERE id = ? AND page_id = ?", [row.id, pageId]);
          existingById.delete(row.id);
        }

        for (const row of existingRows) {
          if (row.type === "ATTACHMENT" || activeIds.has(row.id)) continue;
          await client.execute("DELETE FROM blocks WHERE id = ? AND page_id = ?", [row.id, pageId]);
          existingById.delete(row.id);
        }

        for (const block of orderedBlocks) {
          const existing = existingById.get(block.id);
          if (existing?.type === "ATTACHMENT") {
            await client.execute(
              `UPDATE blocks
               SET parent_block_id = ?, sort_order = ?, edit_version = edit_version + 1
               WHERE id = ? AND page_id = ?`,
              [block.parentBlockId, block.sortOrder, block.id, pageId]
            );
            continue;
          }

          const prepared = prepareBlockContent(block.type, block.markdown, block.metadata);
          const html = renderBlockHtml(block.type, prepared.markdown, block.checked, prepared.metadata);
          const metadata = prepared.metadata ? JSON.stringify(prepared.metadata) : null;
          if (existing) {
            await client.execute(
              `UPDATE blocks
               SET parent_block_id = ?, type = ?, markdown = ?, html_cache = ?, checked = ?, sort_order = ?,
                   metadata = ?, edit_version = edit_version + 1
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

        await client.execute(
          `UPDATE pages
           SET title = ?, edit_version = edit_version + 1, content_version = content_version + 1
           WHERE id = ?`,
          [body.title, pageId]
        );
        await client.execute(
          `UPDATE page_collaboration_state
           SET materialized_update_id = ?, materialized_at = CURRENT_TIMESTAMP(3)
           WHERE page_id = ? AND document_epoch = ?`,
          [body.updateId, pageId, body.documentEpoch]
        );

        const currentPage = await client.queryOne<PageRow>("SELECT * FROM pages WHERE id = ?", [pageId]);
        const currentBlocks = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY COALESCE(parent_block_id, ''), sort_order ASC, id ASC",
          [pageId]
        );
        if (!currentPage) throw notFound("Page");
        return {
          applied: true,
          page: currentPage,
          blocks: currentBlocks,
          ownerId: currentPage.owner_id,
          materializedUpdateId: body.updateId
        };
      });

      if (deletedFiles.length) await removeDeletedAttachmentFiles(result.ownerId, deletedFiles);
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
      next(error);
    }
  }
);
