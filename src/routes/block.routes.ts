import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { db, transaction, type DbClient, type DbValue } from "../lib/db.js";
import { createId } from "../lib/id.js";
import { env } from "../config/env.js";
import {
  attachmentFileExists,
  attachmentTempDir,
  ensureAttachmentDirectories,
  getAttachmentFilePath,
  getAttachmentInfo,
  moveAttachmentFile,
  normalizeAttachmentMimeType,
  removeDeletedAttachmentFiles,
  removeAttachmentPath,
  sanitizeAttachmentFilename,
  type AttachmentMetadata
} from "../lib/attachments.js";
import { renderBlockHtml } from "../lib/markdown.js";
import {
  fetchBookmarkPreviewWithFallback,
  getBookmarkData,
  normalizeBookmarkMetadata,
  summarizeBookmarkData
} from "../lib/bookmark.js";
import { getAiChatData, normalizeAiChatMetadata, summarizeAiChatData } from "../lib/ai-chat.js";
import { toBlock } from "../lib/mappers.js";
import { ApiError, notFound } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { blockTypeSchema, idParamSchema, metadataSchema, requireUser } from "../utils/schemas.js";
import type { BlockRow, PageRow } from "../types/domain.js";

export const blockRouter = Router();

blockRouter.use(requireAuth);

const createBlockSchema = z.object({
  type: blockTypeSchema.default("MARKDOWN"),
  markdown: z.string().max(20_000).default(""),
  checked: z.boolean().optional(),
  parentBlockId: z.string().min(1).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  metadata: metadataSchema
});

const updateBlockSchema = z.object({
  type: blockTypeSchema.optional(),
  markdown: z.string().max(20_000).optional(),
  checked: z.boolean().optional(),
  parentBlockId: z.string().min(1).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  metadata: metadataSchema.nullable().optional(),
  expectedVersion: z.number().int().min(1)
});

const versionSnapshotSchema = z.object({
  id: z.string().min(1).max(64),
  version: z.number().int().min(1)
});

const deleteBlockSchema = z
  .object({
    expectedVersions: z.array(versionSnapshotSchema).max(10_000).optional()
  })
  .default({});

const bookmarkPreviewSchema = z.object({
  url: z.string().trim().min(1).max(2_048)
});

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

const reorderSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        sortOrder: z.number().int().min(0),
        parentBlockId: z.string().min(1).nullable().optional(),
        expectedVersion: z.number().int().min(1)
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
    z.number().int().min(0).optional()
  )
});

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
    fileSize: env.MAX_ATTACHMENT_SIZE_MB * 1024 * 1024,
    files: 1,
    fields: 4,
    fieldSize: 16 * 1024
  },
  preservePath: false,
  defParamCharset: "utf8"
});

blockRouter.post("/bookmarks/preview", validate({ body: bookmarkPreviewSchema }), async (req, res, next) => {
  try {
    const result = await fetchBookmarkPreviewWithFallback(String(req.body.url));
    res.json(result);
  } catch (error) {
    next(error);
  }
});

async function assertOwnedPage(pageId: string, ownerId: string, client: DbClient = db) {
  const page = await client.queryOne<PageRow>("SELECT * FROM pages WHERE id = ? AND owner_id = ?", [pageId, ownerId]);
  if (!page) throw notFound("Page");
  return page;
}

async function assertOwnedBlock(blockId: string, ownerId: string, client: DbClient = db) {
  const block = await client.queryOne<BlockRow>(
    `SELECT b.* FROM blocks b
     INNER JOIN pages p ON p.id = b.page_id
     WHERE b.id = ? AND p.owner_id = ?`,
    [blockId, ownerId]
  );
  if (!block) throw notFound("Block");
  return block;
}

async function advancePageContentVersion(client: DbClient, pageId: string, ownerId: string) {
  const result = await client.execute<{ affectedRows: number }>(
    "UPDATE pages SET content_version = content_version + 1 WHERE id = ? AND owner_id = ?",
    [pageId, ownerId]
  );
  if (Number(result.affectedRows) === 0) throw notFound("Page");
  const page = await client.queryOne<PageRow>(
    "SELECT * FROM pages WHERE id = ? AND owner_id = ?",
    [pageId, ownerId]
  );
  if (!page) throw notFound("Page");
  return Number(page.content_version ?? 1);
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
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parent_block_id) continue;
    const group = children.get(row.parent_block_id) ?? [];
    group.push(row.id);
    children.set(row.parent_block_id, group);
  }

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const pending = [rootBlockId];
  const subtreeRows = [] as typeof rows;
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

function assertBlockVersionSnapshot(
  rows: Array<{ id: string; edit_version: number }>,
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
  attachmentUpload.single("file"),
  async (req, res, next) => {
    let cleanupPath = req.file?.path ?? null;
    let movedPath: string | null = null;
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const file = req.file;
      if (!file) throw new ApiError(400, "ATTACHMENT_FILE_REQUIRED", "Select a file to attach");

      const body = attachmentFormSchema.parse(req.body);
      await assertOwnedPage(pageId, user.id);
      await assertParentBlock(body.parentBlockId, pageId);

      const id = createId("blk");
      const originalName = sanitizeAttachmentFilename(file.originalname);
      const metadata: AttachmentMetadata = {
        attachment: {
          originalName,
          mimeType: normalizeAttachmentMimeType(file.mimetype),
          size: file.size
        }
      };

      let pageContentVersion = 1;
      try {
        await transaction(async (client) => {
          const lockedUser = await client.queryOne<{ id: string }>(
            "SELECT id FROM users WHERE id = ? FOR UPDATE",
            [user.id]
          );
          if (!lockedUser) throw notFound("User");
          const lockedPage = await client.queryOne<PageRow>(
            "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
            [pageId, user.id]
          );
          if (!lockedPage) throw notFound("Page");
          await assertParentBlock(body.parentBlockId, pageId, client);
          const lastBlock = await client.queryOne<{ sort_order: number }>(
            "SELECT sort_order FROM blocks WHERE page_id = ? AND parent_block_id <=> ? ORDER BY sort_order DESC LIMIT 1",
            [pageId, body.parentBlockId]
          );
          movedPath = await moveAttachmentFile(file.path, user.id, id);
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
              body.sortOrder ?? (lastBlock ? lastBlock.sort_order + 1 : 0),
              JSON.stringify(metadata)
            ]
          );
          pageContentVersion = await advancePageContentVersion(client, pageId, user.id);
        });
        movedPath = null;
      } catch (error) {
        let insertDefinitelyFailed = false;
        try {
          insertDefinitelyFailed = !(await db.queryOne<{ id: string }>("SELECT id FROM blocks WHERE id = ?", [id]));
        } catch (verificationError) {
          console.error("Attachment insert outcome is unknown; preserving the moved file", {
            id,
            movedPath,
            verificationError
          });
        }
        if (insertDefinitelyFailed && movedPath) {
          await removeAttachmentPath(movedPath);
          movedPath = null;
        }
        throw error;
      }

      const block = await db.queryOne<BlockRow>("SELECT * FROM blocks WHERE id = ?", [id]);
      if (!block) throw new ApiError(500, "BLOCK_CREATE_FAILED", "Attachment block was not created");
      res.status(201).json({ block: toBlock(block), pageContentVersion });
    } catch (error) {
      if (cleanupPath) await removeAttachmentPath(cleanupPath);
      if (movedPath) {
        console.error("Preserving an attachment file because the database write outcome is unknown", { movedPath });
      }
      next(error);
    }
  }
);

blockRouter.get("/blocks/:blockId/attachment", validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const blockId = String(req.params.blockId);
    const block = await assertOwnedBlock(blockId, user.id);
    if (block.type !== "ATTACHMENT") throw notFound("Attachment");

    const info = getAttachmentInfo(toBlock(block).metadata);
    if (!info || !(await attachmentFileExists(user.id, blockId))) throw notFound("Attachment file");

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", info.mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.download(getAttachmentFilePath(user.id, blockId), info.originalName, (error) => {
      if (!error) return;
      if (!res.headersSent) next(error);
      else console.error("Attachment download failed", error);
    });
  } catch (error) {
    next(error);
  }
});

blockRouter.post("/pages/:pageId/blocks", validate({ params: idParamSchema, body: createBlockSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const pageId = String(req.params.pageId);
    const body = req.body as z.infer<typeof createBlockSchema>;

    if (body.type === "ATTACHMENT") {
      throw new ApiError(400, "USE_ATTACHMENT_UPLOAD", "Create attachment blocks through the file upload endpoint");
    }

    const id = createId("blk");
    const prepared = prepareBlockContent(body.type, body.markdown, body.metadata);
    const result = await transaction(async (client) => {
      const lockedPage = await client.queryOne<PageRow>(
        "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
        [pageId, user.id]
      );
      if (!lockedPage) throw notFound("Page");
      await assertParentBlock(body.parentBlockId, pageId, client);
      const lastBlock = await client.queryOne<{ sort_order: number }>(
        "SELECT sort_order FROM blocks WHERE page_id = ? AND parent_block_id <=> ? ORDER BY sort_order DESC LIMIT 1",
        [pageId, body.parentBlockId ?? null]
      );
      await client.execute(
        `INSERT INTO blocks (id, page_id, parent_block_id, type, markdown, html_cache, checked, sort_order, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          pageId,
          body.parentBlockId ?? null,
          body.type,
          prepared.markdown,
          renderBlockHtml(body.type, prepared.markdown, Boolean(body.checked), prepared.metadata),
          body.checked ? 1 : 0,
          body.sortOrder ?? (lastBlock ? lastBlock.sort_order + 1 : 0),
          prepared.metadata ? JSON.stringify(prepared.metadata) : null
        ]
      );
      const pageContentVersion = await advancePageContentVersion(client, pageId, user.id);
      const block = await client.queryOne<BlockRow>("SELECT * FROM blocks WHERE id = ?", [id]);
      if (!block) throw new ApiError(500, "BLOCK_CREATE_FAILED", "Block was not created");
      return { block, pageContentVersion };
    });

    res.status(201).json({ block: toBlock(result.block), pageContentVersion: result.pageContentVersion });
  } catch (error) {
    next(error);
  }
});

blockRouter.patch("/blocks/:blockId", validate({ params: idParamSchema, body: updateBlockSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const blockId = String(req.params.blockId);
    const body = req.body as z.infer<typeof updateBlockSchema>;

    const result = await transaction(async (client) => {
      const hierarchyChanged = body.parentBlockId !== undefined || body.sortOrder !== undefined;
      const identity = await assertOwnedBlock(blockId, user.id, client);
      const lockedPage = await client.queryOne<PageRow>(
        "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
        [identity.page_id, user.id]
      );
      if (!lockedPage) throw notFound("Page");
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

      const fields: string[] = [];
      const values: DbValue[] = [];
      const contentChanged =
        body.type !== undefined ||
        body.markdown !== undefined ||
        body.checked !== undefined ||
        body.metadata !== undefined;
      const nextType = body.type ?? existing.type;
      const prepared = prepareBlockContent(
        nextType,
        body.markdown ?? existing.markdown,
        body.metadata !== undefined ? body.metadata : existing.metadata
      );
      const nextChecked = body.checked ?? Boolean(existing.checked);

      if (body.type !== undefined) {
        fields.push("type = ?");
        values.push(body.type);
      }
      if (body.markdown !== undefined || (contentChanged && (nextType === "BOOKMARK" || nextType === "AI_CHAT"))) {
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
      if (body.metadata !== undefined || (contentChanged && (nextType === "BOOKMARK" || nextType === "AI_CHAT"))) {
        fields.push("metadata = ?");
        values.push(prepared.metadata ? JSON.stringify(prepared.metadata) : null);
      }

      let pageContentVersion = Number(lockedPage.content_version ?? 1);
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
      return { block: updated, pageContentVersion };
    });

    res.json({ block: toBlock(result.block), pageContentVersion: result.pageContentVersion });
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
    const blockId = String(req.params.blockId);
    const body = req.body as z.infer<typeof deleteBlockSchema>;
    if (!body.expectedVersions?.length) {
      throw new ApiError(
        400,
        "BLOCK_DELETE_SNAPSHOT_REQUIRED",
        "Refresh the block deletion snapshot before permanently deleting this block."
      );
    }
    const expectedVersions = body.expectedVersions;
    const deletion = await transaction(async (client) => {
      const block = await assertOwnedBlock(blockId, user.id, client);
      const lockedPage = await client.queryOne<PageRow>(
        "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
        [block.page_id, user.id]
      );
      if (!lockedPage) throw notFound("Page");
      const subtreeRows = await getBlockSubtreeRows(blockId, block.page_id, client, true);
      assertBlockVersionSnapshot(subtreeRows, expectedVersions);
      await client.execute("DELETE FROM blocks WHERE id = ?", [blockId]);
      await advancePageContentVersion(client, block.page_id, user.id);
      return {
        pageId: block.page_id,
        attachmentIds: subtreeRows.filter((row) => row.type === "ATTACHMENT").map((row) => row.id)
      };
    });
    await removeDeletedAttachmentFiles(user.id, deletion.attachmentIds);
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
      const pageId = String(req.params.pageId);
      const { items } = req.body as z.infer<typeof reorderSchema>;

      const result = await transaction(async (client) => {
        const lockedPage = await client.queryOne<PageRow>(
          "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
          [pageId, user.id]
        );
        if (!lockedPage) throw notFound("Page");
        const hierarchyRows = await client.query<{
          id: string;
          parent_block_id: string | null;
          edit_version: number;
        }>(
          "SELECT id, parent_block_id, edit_version FROM blocks WHERE page_id = ? ORDER BY id ASC FOR UPDATE",
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
        const rows = await client.query<BlockRow>(
          "SELECT * FROM blocks WHERE page_id = ? ORDER BY sort_order ASC, id ASC",
          [pageId]
        );
        return { rows, pageContentVersion };
      });

      res.json({ blocks: result.rows.map(toBlock), pageContentVersion: result.pageContentVersion });
    } catch (error) {
      next(error);
    }
  }
);
