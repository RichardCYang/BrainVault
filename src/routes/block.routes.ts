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
  removeAttachmentFiles,
  removeAttachmentPath,
  sanitizeAttachmentFilename,
  type AttachmentMetadata
} from "../lib/attachments.js";
import { renderBlockHtml } from "../lib/markdown.js";
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
  metadata: metadataSchema.nullable().optional()
});

const reorderSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        sortOrder: z.number().int().min(0),
        parentBlockId: z.string().min(1).nullable().optional()
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

async function assertParentBlock(parentBlockId: string | null | undefined, pageId: string, client: DbClient = db) {
  if (!parentBlockId) return;
  const parent = await client.queryOne("SELECT id FROM blocks WHERE id = ? AND page_id = ?", [parentBlockId, pageId]);
  if (!parent) throw new ApiError(400, "INVALID_PARENT_BLOCK", "Parent block must exist on the same page");
}

async function getAttachmentBlockIdsForSubtree(rootBlockId: string, pageId: string) {
  const rows = await db.query<{ id: string; parent_block_id: string | null; type: string }>(
    "SELECT id, parent_block_id, type FROM blocks WHERE page_id = ?",
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
  const attachmentIds: string[] = [];
  while (pending.length) {
    const id = pending.pop();
    if (!id) continue;
    const row = rowById.get(id);
    if (row?.type === "ATTACHMENT") attachmentIds.push(id);
    pending.push(...(children.get(id) ?? []));
  }
  return attachmentIds;
}

blockRouter.post(
  "/pages/:pageId/attachments",
  validate({ params: idParamSchema }),
  attachmentUpload.single("file"),
  async (req, res, next) => {
    let cleanupPath = req.file?.path ?? null;
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const file = req.file;
      if (!file) throw new ApiError(400, "ATTACHMENT_FILE_REQUIRED", "Select a file to attach");

      const body = attachmentFormSchema.parse(req.body);
      await assertOwnedPage(pageId, user.id);
      await assertParentBlock(body.parentBlockId, pageId);

      const lastBlock = await db.queryOne<{ sort_order: number }>(
        "SELECT sort_order FROM blocks WHERE page_id = ? AND parent_block_id <=> ? ORDER BY sort_order DESC LIMIT 1",
        [pageId, body.parentBlockId]
      );

      const id = createId("blk");
      const originalName = sanitizeAttachmentFilename(file.originalname);
      const metadata: AttachmentMetadata = {
        attachment: {
          originalName,
          mimeType: normalizeAttachmentMimeType(file.mimetype),
          size: file.size
        }
      };

      cleanupPath = await moveAttachmentFile(file.path, user.id, id);
      await db.execute(
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
      cleanupPath = null;

      const block = await db.queryOne<BlockRow>("SELECT * FROM blocks WHERE id = ?", [id]);
      if (!block) throw new ApiError(500, "BLOCK_CREATE_FAILED", "Attachment block was not created");
      res.status(201).json({ block: toBlock(block) });
    } catch (error) {
      if (cleanupPath) await removeAttachmentPath(cleanupPath);
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

    await assertOwnedPage(pageId, user.id);
    await assertParentBlock(body.parentBlockId, pageId);

    const lastBlock = await db.queryOne<{ sort_order: number }>(
      "SELECT sort_order FROM blocks WHERE page_id = ? AND parent_block_id <=> ? ORDER BY sort_order DESC LIMIT 1",
      [pageId, body.parentBlockId ?? null]
    );

    const id = createId("blk");
    await db.execute(
      `INSERT INTO blocks (id, page_id, parent_block_id, type, markdown, html_cache, checked, sort_order, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        pageId,
        body.parentBlockId ?? null,
        body.type,
        body.markdown,
        renderBlockHtml(body.type, body.markdown, Boolean(body.checked), body.metadata),
        body.checked ? 1 : 0,
        body.sortOrder ?? (lastBlock ? lastBlock.sort_order + 1 : 0),
        body.metadata ? JSON.stringify(body.metadata) : null
      ]
    );

    const block = await db.queryOne<BlockRow>("SELECT * FROM blocks WHERE id = ?", [id]);
    if (!block) throw new ApiError(500, "BLOCK_CREATE_FAILED", "Block was not created");

    res.status(201).json({ block: toBlock(block) });
  } catch (error) {
    next(error);
  }
});

blockRouter.patch("/blocks/:blockId", validate({ params: idParamSchema, body: updateBlockSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const blockId = String(req.params.blockId);
    const body = req.body as z.infer<typeof updateBlockSchema>;
    const existing = await assertOwnedBlock(blockId, user.id);

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

    if (body.parentBlockId === blockId) {
      throw new ApiError(400, "INVALID_PARENT_BLOCK", "A block cannot be its own parent");
    }

    await assertParentBlock(body.parentBlockId, existing.page_id);

    const fields: string[] = [];
    const values: DbValue[] = [];

    if (body.type !== undefined) {
      fields.push("type = ?");
      values.push(body.type);
    }
    if (body.markdown !== undefined) {
      fields.push("markdown = ?");
      values.push(body.markdown);
    }
    if (body.checked !== undefined) {
      fields.push("checked = ?");
      values.push(body.checked ? 1 : 0);
    }
    if (
      body.type !== undefined ||
      body.markdown !== undefined ||
      body.checked !== undefined ||
      body.metadata !== undefined
    ) {
      const nextType = body.type ?? existing.type;
      const nextMarkdown = body.markdown ?? existing.markdown;
      const nextChecked = body.checked ?? Boolean(existing.checked);
      const nextMetadata = body.metadata !== undefined ? body.metadata : existing.metadata;
      fields.push("html_cache = ?");
      values.push(renderBlockHtml(nextType, nextMarkdown, nextChecked, nextMetadata));
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
      values.push(body.metadata ? JSON.stringify(body.metadata) : null);
    }

    if (fields.length) {
      await db.execute(`UPDATE blocks SET ${fields.join(", ")} WHERE id = ?`, [...values, blockId]);
    }

    const block = await db.queryOne<BlockRow>("SELECT * FROM blocks WHERE id = ?", [blockId]);
    if (!block) throw notFound("Block");

    res.json({ block: toBlock(block) });
  } catch (error) {
    next(error);
  }
});

blockRouter.delete("/blocks/:blockId", validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const blockId = String(req.params.blockId);
    const block = await assertOwnedBlock(blockId, user.id);
    const attachmentIds = await getAttachmentBlockIdsForSubtree(blockId, block.page_id);
    await db.execute("DELETE FROM blocks WHERE id = ?", [blockId]);
    await removeAttachmentFiles(user.id, attachmentIds);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

blockRouter.post(
  "/pages/:pageId/blocks/reorder",
  validate({ params: idParamSchema, body: reorderSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const { items } = req.body as z.infer<typeof reorderSchema>;
      await assertOwnedPage(pageId, user.id);

      const existing = await db.query<{ id: string }>(
        `SELECT id FROM blocks WHERE page_id = ? AND id IN (${items.map(() => "?").join(",")})`,
        [pageId, ...items.map((item) => item.id)]
      );

      if (existing.length !== items.length) {
        throw new ApiError(400, "INVALID_BLOCKS", "All reordered blocks must belong to the page");
      }

      for (const item of items) {
        if (item.parentBlockId) await assertParentBlock(item.parentBlockId, pageId);
        if (item.parentBlockId === item.id) {
          throw new ApiError(400, "INVALID_PARENT_BLOCK", "A block cannot be its own parent");
        }
      }

      await transaction(async (client) => {
        for (const item of items) {
          if (item.parentBlockId !== undefined) {
            await client.execute("UPDATE blocks SET sort_order = ?, parent_block_id = ? WHERE id = ?", [
              item.sortOrder,
              item.parentBlockId,
              item.id
            ]);
          } else {
            await client.execute("UPDATE blocks SET sort_order = ? WHERE id = ?", [item.sortOrder, item.id]);
          }
        }
      });

      const rows = await db.query<BlockRow>("SELECT * FROM blocks WHERE page_id = ? ORDER BY sort_order ASC, id ASC", [pageId]);
      res.json({ blocks: rows.map(toBlock) });
    } catch (error) {
      next(error);
    }
  }
);
