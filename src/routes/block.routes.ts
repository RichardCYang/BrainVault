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
  expectedVersion: z.number().int().min(1).optional()
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

async function assertParentBlock(parentBlockId: string | null | undefined, pageId: string, client: DbClient = db) {
  if (!parentBlockId) return;
  const parent = await client.queryOne("SELECT id FROM blocks WHERE id = ? AND page_id = ?", [parentBlockId, pageId]);
  if (!parent) throw new ApiError(400, "INVALID_PARENT_BLOCK", "Parent block must exist on the same page");
}

async function assertBlockParentDoesNotCycle(
  blockId: string,
  parentBlockId: string | null | undefined,
  pageId: string,
  client: DbClient = db
) {
  let currentId = parentBlockId ?? null;
  const visited = new Set<string>();
  while (currentId) {
    if (currentId === blockId || visited.has(currentId)) {
      throw new ApiError(400, "INVALID_PARENT_BLOCK", "Block hierarchy cannot contain a cycle");
    }
    visited.add(currentId);
    const current = await client.queryOne<{ parent_block_id: string | null }>(
      "SELECT parent_block_id FROM blocks WHERE id = ? AND page_id = ?",
      [currentId, pageId]
    );
    if (!current) throw new ApiError(400, "INVALID_PARENT_BLOCK", "Parent block must exist on the same page");
    currentId = current.parent_block_id;
  }
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
  expectedVersions: Array<{ id: string; version: number }> | undefined
) {
  if (!expectedVersions) return;

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

      movedPath = await moveAttachmentFile(file.path, user.id, id);
      cleanupPath = null;
      try {
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
      res.status(201).json({ block: toBlock(block) });
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

    await assertOwnedPage(pageId, user.id);
    await assertParentBlock(body.parentBlockId, pageId);

    const lastBlock = await db.queryOne<{ sort_order: number }>(
      "SELECT sort_order FROM blocks WHERE page_id = ? AND parent_block_id <=> ? ORDER BY sort_order DESC LIMIT 1",
      [pageId, body.parentBlockId ?? null]
    );

    const id = createId("blk");
    const prepared = prepareBlockContent(body.type, body.markdown, body.metadata);
    await db.execute(
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
    await assertBlockParentDoesNotCycle(blockId, body.parentBlockId, existing.page_id);

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

    if (fields.length) {
      const versionWhere = body.expectedVersion === undefined ? "id = ?" : "id = ? AND edit_version = ?";
      const versionValues = body.expectedVersion === undefined ? [blockId] : [blockId, body.expectedVersion];
      const result = await db.execute<{ affectedRows: number }>(
        `UPDATE blocks SET ${[...fields, "edit_version = edit_version + 1"].join(", ")} WHERE ${versionWhere}`,
        [...values, ...versionValues]
      );
      if (body.expectedVersion !== undefined && Number(result.affectedRows) === 0) {
        throw new ApiError(
          409,
          "BLOCK_EDIT_CONFLICT",
          "This block was changed in another session. Your local edits were not overwritten."
        );
      }
    }

    const block = await db.queryOne<BlockRow>("SELECT * FROM blocks WHERE id = ?", [blockId]);
    if (!block) throw notFound("Block");

    res.json({ block: toBlock(block) });
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
    const attachmentIds = await transaction(async (client) => {
      const block = await assertOwnedBlock(blockId, user.id, client);
      const subtreeRows = await getBlockSubtreeRows(blockId, block.page_id, client, true);
      assertBlockVersionSnapshot(subtreeRows, body.expectedVersions);
      await client.execute("DELETE FROM blocks WHERE id = ?", [blockId]);
      return subtreeRows.filter((row) => row.type === "ATTACHMENT").map((row) => row.id);
    });
    await removeAttachmentFiles(user.id, attachmentIds);
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
      const hierarchyRows = await db.query<{ id: string; parent_block_id: string | null }>(
        "SELECT id, parent_block_id FROM blocks WHERE page_id = ?",
        [pageId]
      );
      assertReorderDoesNotCreateCycle(hierarchyRows, items);

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
