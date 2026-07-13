import { Router } from "express";
import { z } from "zod";
import { db, transaction, type DbClient, type DbValue } from "../lib/db.js";
import { createId } from "../lib/id.js";
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

blockRouter.post("/pages/:pageId/blocks", validate({ params: idParamSchema, body: createBlockSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const pageId = String(req.params.pageId);
    const body = req.body as z.infer<typeof createBlockSchema>;

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
    await assertOwnedBlock(blockId, user.id);
    await db.execute("DELETE FROM blocks WHERE id = ?", [blockId]);
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
