import { Router } from "express";
import { z } from "zod";
import { db, transaction, type DbClient, type DbValue } from "../lib/db.js";
import { createId } from "../lib/id.js";
import { renderBlockHtml } from "../lib/markdown.js";
import { toBlock, toPage, toTag } from "../lib/mappers.js";
import { ApiError, notFound } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { getValidatedQuery, validate } from "../middleware/validate.js";
import { buildBlockTree } from "../utils/blockTree.js";
import { idParamSchema, requireUser } from "../utils/schemas.js";
import type { BlockRow, PageRow, TagRow } from "../types/domain.js";

export const pageRouter = Router();

pageRouter.use(requireAuth);

const listPagesQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  archived: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value ? value === "true" : false)),
  tag: z.string().trim().min(1).max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const createPageSchema = z.object({
  title: z.string().trim().min(1).max(160),
  icon: z.string().trim().max(32).optional(),
  coverUrl: z.string().url().max(500).optional(),
  parentPageId: z.string().min(1).optional(),
  initialMarkdown: z.string().max(20_000).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional()
});

const updatePageSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  icon: z.string().trim().max(32).nullable().optional(),
  coverUrl: z.string().url().max(500).nullable().optional(),
  isArchived: z.boolean().optional(),
  parentPageId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional()
});

const tagSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(50)).max(20)
});

const deletePageQuerySchema = z.object({
  permanent: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true")
});

async function assertOwnedPage(pageId: string, ownerId: string, client: DbClient = db) {
  const page = await client.queryOne<PageRow>("SELECT * FROM pages WHERE id = ? AND owner_id = ?", [pageId, ownerId]);
  if (!page) throw notFound("Page");
  return page;
}

async function assertOwnedParentPage(parentPageId: string | null | undefined, ownerId: string, client: DbClient = db) {
  if (!parentPageId) return;
  const parent = await client.queryOne("SELECT id FROM pages WHERE id = ? AND owner_id = ?", [parentPageId, ownerId]);
  if (!parent) throw new ApiError(400, "INVALID_PARENT_PAGE", "Parent page does not exist");
}

async function getPageTags(pageId: string, client: DbClient = db) {
  const rows = await client.query<TagRow>(
    `SELECT t.* FROM tags t
     INNER JOIN page_tags pt ON pt.tag_id = t.id
     WHERE pt.page_id = ?
     ORDER BY t.name ASC`,
    [pageId]
  );
  return rows.map(toTag);
}

async function replaceTags(client: DbClient, pageId: string, tagNames: string[]) {
  const uniqueNames = [...new Set(tagNames.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  await client.execute("DELETE FROM page_tags WHERE page_id = ?", [pageId]);

  for (const name of uniqueNames) {
    await client.execute("INSERT IGNORE INTO tags (id, name) VALUES (?, ?)", [createId("tag"), name]);
    const tag = await client.queryOne<TagRow>("SELECT * FROM tags WHERE name = ?", [name]);
    if (tag) {
      await client.execute("INSERT IGNORE INTO page_tags (page_id, tag_id) VALUES (?, ?)", [pageId, tag.id]);
    }
  }
}

async function replaceTagsTx(pageId: string, tagNames: string[]) {
  await transaction((client) => replaceTags(client, pageId, tagNames));
}

async function getBlocks(pageId: string, client: DbClient = db) {
  const rows = await client.query<BlockRow>(
    "SELECT * FROM blocks WHERE page_id = ? ORDER BY COALESCE(parent_block_id, ''), sort_order ASC, id ASC",
    [pageId]
  );
  return rows.map(toBlock);
}

async function getPageResponse(pageId: string, ownerId: string, client: DbClient = db) {
  const page = await assertOwnedPage(pageId, ownerId, client);
  const childRows = await client.query<PageRow>(
    "SELECT * FROM pages WHERE parent_page_id = ? AND owner_id = ? ORDER BY updated_at DESC",
    [pageId, ownerId]
  );

  return {
    ...toPage(page),
    tags: await getPageTags(pageId, client),
    blocks: buildBlockTree(await getBlocks(pageId, client)),
    children: childRows.map(toPage)
  };
}

pageRouter.get("/", validate({ query: listPagesQuerySchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const query = getValidatedQuery<z.infer<typeof listPagesQuerySchema>>(req);
    const where = ["p.owner_id = ?", "p.is_archived = ?"];
    const params: DbValue[] = [user.id, query.archived ? 1 : 0];

    if (query.q) {
      where.push(
        `(p.title LIKE ? OR EXISTS (
          SELECT 1 FROM blocks b WHERE b.page_id = p.id AND b.markdown LIKE ?
        ))`
      );
      params.push(`%${query.q}%`, `%${query.q}%`);
    }

    if (query.tag) {
      where.push(
        `EXISTS (
          SELECT 1 FROM page_tags pt
          INNER JOIN tags t ON t.id = pt.tag_id
          WHERE pt.page_id = p.id AND t.name = ?
        )`
      );
      params.push(query.tag.toLowerCase());
    }

    params.push(query.limit);
    const rows = await db.query<PageRow & { block_count: number; child_count: number }>(
      `SELECT p.*,
        (SELECT COUNT(*) FROM blocks b WHERE b.page_id = p.id) AS block_count,
        (SELECT COUNT(*) FROM pages c WHERE c.parent_page_id = p.id) AS child_count
       FROM pages p
       WHERE ${where.join(" AND ")}
       ORDER BY p.updated_at DESC
       LIMIT ?`,
      params
    );

    const pages = await Promise.all(
      rows.map(async (row) => ({
        ...toPage(row),
        tags: await getPageTags(row.id),
        counts: { blocks: row.block_count, children: row.child_count }
      }))
    );

    res.json({ pages });
  } catch (error) {
    next(error);
  }
});

pageRouter.post("/", validate({ body: createPageSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const body = req.body as z.infer<typeof createPageSchema>;
    await assertOwnedParentPage(body.parentPageId, user.id);

    const pageId = await transaction(async (client) => {
      const id = createId("pag");
      await client.execute(
        `INSERT INTO pages (id, title, icon, cover_url, owner_id, parent_page_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, body.title, body.icon ?? null, body.coverUrl ?? null, user.id, body.parentPageId ?? null]
      );

      if (body.initialMarkdown) {
        await client.execute(
          `INSERT INTO blocks (id, page_id, type, markdown, html_cache, sort_order)
           VALUES (?, ?, 'MARKDOWN', ?, ?, 0)`,
          [createId("blk"), id, body.initialMarkdown, renderBlockHtml("MARKDOWN", body.initialMarkdown)]
        );
      }

      if (body.tags?.length) await replaceTags(client, id, body.tags);
      return id;
    });

    res.status(201).json({ page: await getPageResponse(pageId, user.id) });
  } catch (error) {
    next(error);
  }
});

pageRouter.get("/:pageId", validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const pageId = String(req.params.pageId);
    res.json({ page: await getPageResponse(pageId, user.id) });
  } catch (error) {
    next(error);
  }
});

pageRouter.patch("/:pageId", validate({ params: idParamSchema, body: updatePageSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const pageId = String(req.params.pageId);
    const body = req.body as z.infer<typeof updatePageSchema>;
    await assertOwnedPage(pageId, user.id);
    await assertOwnedParentPage(body.parentPageId, user.id);

    if (body.parentPageId === pageId) {
      throw new ApiError(400, "INVALID_PARENT_PAGE", "A page cannot be its own parent");
    }

    const { tags, ...updates } = body;
    const fields: string[] = [];
    const values: DbValue[] = [];

    if (updates.title !== undefined) {
      fields.push("title = ?");
      values.push(updates.title);
    }
    if (updates.icon !== undefined) {
      fields.push("icon = ?");
      values.push(updates.icon);
    }
    if (updates.coverUrl !== undefined) {
      fields.push("cover_url = ?");
      values.push(updates.coverUrl);
    }
    if (updates.isArchived !== undefined) {
      fields.push("is_archived = ?");
      values.push(updates.isArchived ? 1 : 0);
    }
    if (updates.parentPageId !== undefined) {
      fields.push("parent_page_id = ?");
      values.push(updates.parentPageId);
    }

    await transaction(async (client) => {
      if (fields.length) {
        await client.execute(`UPDATE pages SET ${fields.join(", ")} WHERE id = ?`, [...values, pageId]);
      }
      if (tags) await replaceTags(client, pageId, tags);
    });

    res.json({ page: await getPageResponse(pageId, user.id) });
  } catch (error) {
    next(error);
  }
});

pageRouter.delete(
  "/:pageId",
  validate({ params: idParamSchema, query: deletePageQuerySchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const query = getValidatedQuery<z.infer<typeof deletePageQuerySchema>>(req);
      await assertOwnedPage(pageId, user.id);

      if (query.permanent) {
        await db.execute("DELETE FROM pages WHERE id = ?", [pageId]);
        res.status(204).send();
        return;
      }

      await db.execute("UPDATE pages SET is_archived = 1 WHERE id = ?", [pageId]);
      const page = await assertOwnedPage(pageId, user.id);
      res.json({ page: toPage(page) });
    } catch (error) {
      next(error);
    }
  }
);

pageRouter.put("/:pageId/tags", validate({ params: idParamSchema, body: tagSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const pageId = String(req.params.pageId);
    await assertOwnedPage(pageId, user.id);
    const { tags } = req.body as z.infer<typeof tagSchema>;
    await replaceTagsTx(pageId, tags);
    res.json({ tags: await getPageTags(pageId) });
  } catch (error) {
    next(error);
  }
});

pageRouter.get("/:pageId/render", validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const pageId = String(req.params.pageId);
    await assertOwnedPage(pageId, user.id);
    const rows = await db.query<BlockRow>(
      "SELECT * FROM blocks WHERE page_id = ? ORDER BY COALESCE(parent_block_id, ''), sort_order ASC, id ASC",
      [pageId]
    );

    const html = rows
      .map((block) => {
        const blockHtml =
          block.type === "CALLOUT"
            ? renderBlockHtml(block.type, block.markdown, Boolean(block.checked), block.metadata)
            : block.html_cache ?? renderBlockHtml(block.type, block.markdown, Boolean(block.checked), block.metadata);
        return `<section data-block-id="${block.id}" data-block-type="${block.type}">${blockHtml}</section>`;
      })
      .join("\n");

    res.json({ html });
  } catch (error) {
    next(error);
  }
});
