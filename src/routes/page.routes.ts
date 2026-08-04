import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db, transaction, type DbClient, type DbValue } from "../lib/db.js";
import { createId } from "../lib/id.js";
import { removeDeletedAttachmentFiles } from "../lib/attachments.js";
import { renderBlockHtml } from "../lib/markdown.js";
import { createMutationRequestHash, isMatchingMutationReplay } from "../lib/mutation.js";
import { toBlock, toPage, toTag } from "../lib/mappers.js";
import { getOwnedPage, getPageAccess, toAccessPayload, toCollaborationPayload } from "../lib/page-access.js";
import { disconnectPageCollaborators } from "../lib/collaboration-server.js";
import { needsCollaborationMaterialization } from "../lib/collaboration-protocol.js";
import { ApiError, notFound } from "../lib/http.js";
import { iconValueSchema, normalizeIconValue } from "../lib/icon-value.js";
import {
  diffPageVersionBlocks,
  diffPageVersionPage,
  mapPageVersionDetailRow,
  mapPageVersionListRow,
  recordPageVersion,
  resetPageVersionHistory as resetPageVersionHistoryRecords,
  toPageVersionActor,
  type PageVersionRow
} from "../lib/page-version-history.js";
import { requireAuth } from "../middleware/auth.js";
import { getValidatedQuery, validate } from "../middleware/validate.js";
import { buildBlockTree } from "../utils/blockTree.js";
import { httpUrlSchema, idParamSchema, requireUser, routeIdSchema } from "../utils/schemas.js";
import type { BlockRow, PageRow, TagRow } from "../types/domain.js";

export const pageRouter = Router();

pageRouter.use(requireAuth);

const pageListCursorSchema = z.object({
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/),
  id: z.string().min(1).max(64)
});

const listPagesQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  archived: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value ? value === "true" : false)),
  tag: z.string().trim().min(1).max(50).optional(),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

function decodePageListCursor(value: string) {
  try {
    return pageListCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new ApiError(400, "INVALID_PAGE_CURSOR", "The page cursor is invalid");
  }
}

function encodePageListCursor(row: { id: string; cursor_created_at: string }) {
  return Buffer.from(JSON.stringify({ createdAt: row.cursor_created_at, id: row.id }), "utf8").toString("base64url");
}

const createPageSchema = z.object({
  title: z.string().trim().min(1).max(160),
  icon: iconValueSchema.optional(),
  coverUrl: httpUrlSchema(500).optional(),
  parentPageId: z.string().min(1).optional(),
  isCollection: z.boolean().optional().default(false),
  initialMarkdown: z.string().max(20_000).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional()
});

const updatePageSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  icon: iconValueSchema.nullable().optional(),
  coverUrl: httpUrlSchema(500).nullable().optional(),
  isArchived: z.boolean().optional(),
  parentPageId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  expectedVersion: z.number().int().min(1),
  mutationId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional()
});

const tagSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(50)).max(20),
  expectedVersion: z.number().int().min(1)
});

const deletePageQuerySchema = z.object({
  permanent: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true")
});

const deletePageBodySchema = z
  .object({
    expectedSnapshot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    expectedVersion: z.number().int().min(1).optional()
  })
  .default({});

const pageVersionListQuerySchema = z.object({
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const pageVersionParamsSchema = z.object({
  pageId: routeIdSchema,
  versionId: z.string().regex(/^\d+$/)
});

async function assertOwnedPage(pageId: string, ownerId: string, client: DbClient = db) {
  return getOwnedPage(pageId, ownerId, client);
}

type PageDeletionPageRow = {
  id: string;
  parent_page_id: string | null;
  edit_version: number;
  content_version: number;
};

type PageDeletionBlockRow = {
  id: string;
  page_id: string;
  type: string;
  edit_version: number;
};

async function getOwnedPageTreeRows(ownerId: string, client: DbClient = db, lock = false) {
  return client.query<PageDeletionPageRow>(
    `SELECT id, parent_page_id, edit_version, content_version
     FROM pages
     WHERE owner_id = ?
     ORDER BY id ASC${lock ? " FOR UPDATE" : ""}`,
    [ownerId]
  );
}

function getPageSubtreeRows(pageId: string, rows: PageDeletionPageRow[]) {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  if (!rowById.has(pageId)) throw notFound("Page");

  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parent_page_id) continue;
    const group = children.get(row.parent_page_id) ?? [];
    group.push(row.id);
    children.set(row.parent_page_id, group);
  }

  const ordered: PageDeletionPageRow[] = [];
  const pending = [pageId];
  const visited = new Set<string>();
  while (pending.length) {
    const currentId = pending.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    const current = rowById.get(currentId);
    if (!current) continue;
    ordered.push(current);
    const childIds = children.get(currentId) ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) pending.push(childIds[index]);
  }
  return ordered;
}

function assertPageParentFromLockedRows(
  pageId: string,
  parentPageId: string | null | undefined,
  rows: PageDeletionPageRow[]
) {
  if (!parentPageId) return;
  const rowById = new Map(rows.map((row) => [row.id, row]));
  if (!rowById.has(parentPageId)) {
    throw new ApiError(400, "INVALID_PARENT_PAGE", "Parent page does not exist");
  }

  let currentId: string | null = parentPageId;
  const visited = new Set<string>();
  while (currentId) {
    if (currentId === pageId || visited.has(currentId)) {
      throw new ApiError(400, "INVALID_PARENT_PAGE", "Page hierarchy cannot contain a cycle");
    }
    visited.add(currentId);
    currentId = rowById.get(currentId)?.parent_page_id ?? null;
  }
}

async function getPageDeletionBlocks(
  client: DbClient,
  subtreeRows: PageDeletionPageRow[],
  lock = false
) {
  const blocks: PageDeletionBlockRow[] = [];
  for (const page of subtreeRows) {
    const rows = await client.query<PageDeletionBlockRow>(
      `SELECT id, page_id, type, edit_version
       FROM blocks
       WHERE page_id = ?
       ORDER BY id ASC${lock ? " FOR UPDATE" : ""}`,
      [page.id]
    );
    blocks.push(...rows);
  }
  return blocks;
}

function createPageDeletionSnapshot(
  pages: PageDeletionPageRow[],
  blocks: PageDeletionBlockRow[]
) {
  const hash = createHash("sha256");
  for (const page of [...pages].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(
      `page\0${page.id}\0${page.parent_page_id ?? ""}\0${Number(page.edit_version ?? 1)}\0${Number(page.content_version ?? 1)}\n`
    );
  }
  for (const block of [...blocks].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(`block\0${block.id}\0${block.page_id}\0${Number(block.edit_version ?? 1)}\n`);
  }
  return hash.digest("hex");
}

function assertPageDeletionSnapshot(
  expectedSnapshot: string,
  pages: PageDeletionPageRow[],
  blocks: PageDeletionBlockRow[]
) {
  if (createPageDeletionSnapshot(pages, blocks) === expectedSnapshot) return;
  throw new ApiError(
    409,
    "PAGE_EDIT_CONFLICT",
    "This page subtree changed in another session. It was not deleted."
  );
}

async function assertCollaborationMaterialized(client: DbClient, pageIds: string[]) {
  for (const pageId of pageIds) {
    const state = await client.queryOne<{
      latest_update_id: number | bigint | null;
      materialized_update_id: number | bigint | null;
      materialization_version: number | bigint | null;
    }>(
      `SELECT
         (SELECT MAX(id) FROM page_yjs_updates WHERE page_id = ?) AS latest_update_id,
         (SELECT materialized_update_id FROM page_collaboration_state WHERE page_id = ?) AS materialized_update_id,
         (SELECT materialization_version FROM page_collaboration_state WHERE page_id = ?) AS materialization_version`,
      [pageId, pageId, pageId]
    );
    const latestUpdateId = Number(state?.latest_update_id ?? 0);
    const materializedUpdateId = Number(state?.materialized_update_id ?? 0);
    const materializationVersion = Number(state?.materialization_version ?? 0);
    if (
      !Number.isSafeInteger(latestUpdateId)
      || latestUpdateId < 0
      || !Number.isSafeInteger(materializedUpdateId)
      || materializedUpdateId < 0
      || !Number.isSafeInteger(materializationVersion)
      || materializationVersion < 0
    ) {
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
        "Synchronize the latest collaborative edits before archiving or deleting this page",
        { pageId, latestUpdateId, materializedUpdateId, materializationVersion }
      );
    }
  }
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

async function getBlocks(pageId: string, client: DbClient = db) {
  const rows = await client.query<BlockRow>(
    "SELECT * FROM blocks WHERE page_id = ? ORDER BY COALESCE(parent_block_id, ''), sort_order ASC, id ASC",
    [pageId]
  );
  return rows.map(toBlock);
}

async function getPageResponse(pageId: string, userId: string, client: DbClient = db) {
  const access = await getPageAccess(pageId, userId, client);
  const childRows = await client.query<PageRow>(
    `SELECT c.* FROM pages c
     WHERE c.parent_page_id = ?
       AND (c.owner_id = ? OR EXISTS (
         SELECT 1 FROM page_shares child_share
         WHERE child_share.page_id = c.id AND child_share.user_id = ? AND child_share.permission = 'EDIT'
       ))
     ORDER BY c.updated_at DESC`,
    [pageId, userId, userId]
  );
  const page = toPage(access.page);
  if (access.role !== "OWNER") page.parentPageId = null;

  return {
    ...page,
    owner: access.owner,
    access: toAccessPayload(access),
    collaboration: toCollaborationPayload(access),
    tags: await getPageTags(pageId, client),
    blocks: buildBlockTree(await getBlocks(pageId, client)),
    children: childRows.map((row) => {
      const child = toPage(row);
      if (row.owner_id !== userId) child.parentPageId = null;
      return child;
    })
  };
}

pageRouter.get("/", validate({ query: listPagesQuerySchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const query = getValidatedQuery<z.infer<typeof listPagesQuerySchema>>(req);
    const where = [
      "(p.owner_id = ? OR EXISTS (SELECT 1 FROM page_shares current_share WHERE current_share.page_id = p.id AND current_share.user_id = ? AND current_share.permission = 'EDIT'))",
      "p.is_archived = ?"
    ];
    const whereParams: DbValue[] = [user.id, user.id, query.archived ? 1 : 0];

    if (query.q) {
      where.push(
        `(p.title LIKE ? OR EXISTS (
          SELECT 1 FROM blocks b WHERE b.page_id = p.id AND b.markdown LIKE ?
        ))`
      );
      whereParams.push(`%${query.q}%`, `%${query.q}%`);
    }

    if (query.tag) {
      where.push(
        `EXISTS (
          SELECT 1 FROM page_tags pt
          INNER JOIN tags t ON t.id = pt.tag_id
          WHERE pt.page_id = p.id AND t.name = ?
        )`
      );
      whereParams.push(query.tag.toLowerCase());
    }

    if (query.cursor) {
      const cursor = decodePageListCursor(query.cursor);
      where.push("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))");
      whereParams.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    const rows = await db.query<
      PageRow & { block_count: number; child_count: number; cursor_created_at: string }
    >(
      `SELECT p.*,
        DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s.%f') AS cursor_created_at,
        (SELECT COUNT(*) FROM blocks b WHERE b.page_id = p.id) AS block_count,
        (SELECT COUNT(*) FROM pages c
          WHERE c.parent_page_id = p.id
            AND (c.owner_id = ? OR EXISTS (
              SELECT 1 FROM page_shares child_share
              WHERE child_share.page_id = c.id AND child_share.user_id = ? AND child_share.permission = 'EDIT'
            ))) AS child_count
       FROM pages p
       WHERE ${where.join(" AND ")}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`,
      [user.id, user.id, ...whereParams, query.limit + 1]
    );

    const pageRows = rows.slice(0, query.limit);
    const pages = await Promise.all(
      pageRows.map(async (row) => {
        const access = await getPageAccess(row.id, user.id);
        const page = toPage(row);
        if (access.role !== "OWNER") page.parentPageId = null;
        return {
          ...page,
          owner: access.owner,
          access: toAccessPayload(access),
          collaboration: toCollaborationPayload(access),
          tags: await getPageTags(row.id),
          counts: { blocks: row.block_count, children: row.child_count }
        };
      })
    );
    const nextCursor = rows.length > query.limit
      ? encodePageListCursor(pageRows[pageRows.length - 1])
      : null;

    res.json({ pages, nextCursor });
  } catch (error) {
    next(error);
  }
});

pageRouter.post("/", validate({ body: createPageSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const body = req.body as z.infer<typeof createPageSchema>;
    await assertOwnedParentPage(body.parentPageId, user.id);

    if (body.isCollection && body.parentPageId) {
      throw new ApiError(400, "INVALID_COLLECTION_PARENT", "A collection cannot have a parent page");
    }

    const pageId = await transaction(async (client) => {
      const id = createId("pag");
      await client.execute(
        `INSERT INTO pages (id, title, icon, cover_url, is_collection, owner_id, parent_page_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          body.title,
          normalizeIconValue(body.icon ?? null),
          body.coverUrl ?? null,
          body.isCollection ? 1 : 0,
          user.id,
          body.parentPageId ?? null
        ]
      );

      if (body.initialMarkdown) {
        await client.execute(
          `INSERT INTO blocks (id, page_id, type, markdown, html_cache, sort_order)
           VALUES (?, ?, 'MARKDOWN', ?, ?, 0)`,
          [createId("blk"), id, body.initialMarkdown, renderBlockHtml("MARKDOWN", body.initialMarkdown)]
        );
      }

      if (body.tags?.length) await replaceTags(client, id, body.tags);
      const createdPage = await client.queryOne<PageRow>("SELECT * FROM pages WHERE id = ?", [id]);
      if (!createdPage) throw new ApiError(500, "PAGE_CREATE_FAILED", "Page was not created");
      const createdTags = (await getPageTags(id, client)).map((tag) => tag.name);
      const createdBlocks = await client.query<BlockRow>(
        "SELECT * FROM blocks WHERE page_id = ? ORDER BY id ASC",
        [id]
      );
      await recordPageVersion(client, {
        pageId: id,
        actors: [toPageVersionActor(user)],
        source: "CREATE",
        changes: [
          ...diffPageVersionPage(null, createdPage, [], createdTags),
          ...diffPageVersionBlocks([], createdBlocks)
        ]
      });
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
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ page: await getPageResponse(pageId, user.id) });
  } catch (error) {
    next(error);
  }
});

pageRouter.get(
  "/:pageId/versions",
  validate({ params: idParamSchema, query: pageVersionListQuerySchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const query = getValidatedQuery<z.infer<typeof pageVersionListQuerySchema>>(req);
      const page = await getOwnedPage(pageId, user.id);
      const rows = await db.query<PageVersionRow>(
        `SELECT id, page_id, revision, page_edit_version, page_content_version,
                actors, source, change_count, change_summary, created_at
         FROM page_versions
         WHERE page_id = ?${query.cursor ? " AND id < ?" : ""}
         ORDER BY id DESC
         LIMIT ?`,
        query.cursor ? [pageId, query.cursor, query.limit + 1] : [pageId, query.limit + 1]
      );
      const pageRows = rows.slice(0, query.limit);
      const latest = await db.queryOne<{ revision: number | bigint | null }>(
        "SELECT MAX(revision) AS revision FROM page_versions WHERE page_id = ?",
        [pageId]
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        current: {
          revision: Number(latest?.revision ?? 0),
          pageVersion: Number(page.edit_version ?? 1),
          contentVersion: Number(page.content_version ?? 1)
        },
        versions: pageRows.map(mapPageVersionListRow),
        nextCursor: rows.length > query.limit ? String(pageRows.at(-1)?.id ?? "") : null
      });
    } catch (error) {
      next(error);
    }
  }
);

pageRouter.delete(
  "/:pageId/versions",
  validate({ params: idParamSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const reset = await transaction(async (client) => {
        const page = await client.queryOne<PageRow>(
          "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
          [pageId, user.id]
        );
        if (!page) throw notFound("Page");

        const resetHistory = await resetPageVersionHistoryRecords(client, {
          page,
          actor: toPageVersionActor(user)
        });
        if (!resetHistory.version || resetHistory.version.revision !== 1) {
          throw new ApiError(500, "PAGE_VERSION_RESET_FAILED", "Page version history was not reset");
        }
        return { revision: resetHistory.version.revision, deletedCount: resetHistory.deletedCount };
      });

      res.setHeader("Cache-Control", "private, no-store");
      res.json(reset);
    } catch (error) {
      next(error);
    }
  }
);

pageRouter.get(
  "/:pageId/versions/:versionId",
  validate({ params: pageVersionParamsSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const versionId = String(req.params.versionId);
      await getOwnedPage(pageId, user.id);
      const row = await db.queryOne<PageVersionRow>(
        `SELECT id, page_id, revision, page_edit_version, page_content_version,
                actors, source, change_count, change_summary, changes, created_at
         FROM page_versions
         WHERE page_id = ? AND id = ?`,
        [pageId, versionId]
      );
      if (!row) throw notFound("Page version");
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ version: mapPageVersionDetailRow(row) });
    } catch (error) {
      next(error);
    }
  }
);

pageRouter.get(
  "/:pageId/deletion-snapshot",
  validate({ params: idParamSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const result = await transaction(async (client) => {
        const treeRows = await getOwnedPageTreeRows(user.id, client);
        const subtreeRows = getPageSubtreeRows(pageId, treeRows);
        const blockRows = await getPageDeletionBlocks(client, subtreeRows);
        return {
          snapshot: createPageDeletionSnapshot(subtreeRows, blockRows),
          pageIds: subtreeRows.map((page) => page.id).sort((left, right) => left.localeCompare(right)),
          pages: subtreeRows
            .map((page) => ({
              id: page.id,
              version: Number(page.edit_version ?? 1),
              contentVersion: Number(page.content_version ?? 1)
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          counts: { pages: subtreeRows.length, blocks: blockRows.length }
        };
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

pageRouter.patch("/:pageId", validate({ params: idParamSchema, body: updatePageSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const pageId = String(req.params.pageId);
    const body = req.body as z.infer<typeof updatePageSchema>;
    const { tags, expectedVersion, mutationId, ...updates } = body;
    const mutationHash = mutationId
      ? createMutationRequestHash({ expectedVersion, tags, updates })
      : undefined;
    const fields: string[] = [];
    const values: DbValue[] = [];

    if (updates.title !== undefined) {
      fields.push("title = ?");
      values.push(updates.title);
    }
    if (updates.icon !== undefined) {
      fields.push("icon = ?");
      values.push(normalizeIconValue(updates.icon));
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
      let existingPage: PageRow;
      if (updates.parentPageId !== undefined) {
        const lockedRows = await getOwnedPageTreeRows(user.id, client, true);
        const lockedPage = await client.queryOne<PageRow>(
          "SELECT * FROM pages WHERE id = ? AND owner_id = ?",
          [pageId, user.id]
        );
        if (!lockedPage) throw notFound("Page");
        existingPage = lockedPage;
        assertPageParentFromLockedRows(pageId, updates.parentPageId, lockedRows);
      } else {
        const lockedPage = await client.queryOne<PageRow>(
          "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
          [pageId, user.id]
        );
        if (!lockedPage) throw notFound("Page");
        existingPage = lockedPage;
      }

      if (
        isMatchingMutationReplay(
          existingPage.last_mutation_id,
          existingPage.last_mutation_hash,
          mutationId,
          mutationHash
        )
      ) return;

      const beforeTags = (await getPageTags(pageId, client)).map((tag) => tag.name);

      if (updates.title !== undefined) {
        const shareCountRow = await client.queryOne<{ share_count: number }>(
          "SELECT COUNT(*) AS share_count FROM page_shares WHERE page_id = ? AND permission = 'EDIT'",
          [pageId]
        );
        if (Number(shareCountRow?.share_count ?? 0) > 0) {
          throw new ApiError(
            409,
            "COLLABORATION_REQUIRED",
            "Shared page titles must be changed through the live collaboration session"
          );
        }
      }

      if (updates.isArchived === true) {
        await assertCollaborationMaterialized(client, [pageId]);
      }

      if (existingPage.is_collection && updates.parentPageId) {
        throw new ApiError(400, "INVALID_COLLECTION_PARENT", "A collection cannot have a parent page");
      }

      if (fields.length || tags !== undefined) {
        const updateFields = [...fields];
        const updateValues = [...values];
        if (mutationId && mutationHash) {
          updateFields.push("last_mutation_id = ?", "last_mutation_hash = ?");
          updateValues.push(mutationId, mutationHash);
        }
        const result = await client.execute<{ affectedRows: number }>(
          `UPDATE pages SET ${[...updateFields, "edit_version = edit_version + 1"].join(", ")} WHERE id = ? AND owner_id = ? AND edit_version = ?`,
          [...updateValues, pageId, user.id, expectedVersion]
        );
        if (Number(result.affectedRows) === 0) {
          throw new ApiError(
            409,
            "PAGE_EDIT_CONFLICT",
            "This page was changed in another session. Your local edits were not overwritten."
          );
        }
      }
      if (tags !== undefined) await replaceTags(client, pageId, tags);
      const updatedPage = await client.queryOne<PageRow>("SELECT * FROM pages WHERE id = ?", [pageId]);
      if (!updatedPage) throw notFound("Page");
      const afterTags = (await getPageTags(pageId, client)).map((tag) => tag.name);
      await recordPageVersion(client, {
        pageId,
        actors: [toPageVersionActor(user)],
        source: updates.isArchived === true ? "ARCHIVE" : "PAGE_UPDATE",
        changes: diffPageVersionPage(existingPage, updatedPage, beforeTags, afterTags)
      });
    });

    if (updates.isArchived === true) disconnectPageCollaborators(pageId, "Page was archived");
    res.json({ page: await getPageResponse(pageId, user.id) });
  } catch (error) {
    next(error);
  }
});

pageRouter.delete(
  "/:pageId",
  validate({ params: idParamSchema, query: deletePageQuerySchema, body: deletePageBodySchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const pageId = String(req.params.pageId);
      const query = getValidatedQuery<z.infer<typeof deletePageQuerySchema>>(req);
      const body = req.body as z.infer<typeof deletePageBodySchema>;
      await assertOwnedPage(pageId, user.id);

      if (query.permanent) {
        if (!body.expectedSnapshot) {
          throw new ApiError(
            400,
            "PAGE_DELETE_SNAPSHOT_REQUIRED",
            "Refresh the page deletion snapshot before permanently deleting this page."
          );
        }
        const expectedSnapshot = body.expectedSnapshot;
        const deletion = await transaction(async (client) => {
          const treeRows = await getOwnedPageTreeRows(user.id, client, true);
          const subtreeRows = getPageSubtreeRows(pageId, treeRows);
          await assertCollaborationMaterialized(client, subtreeRows.map((page) => page.id));
          const blockRows = await getPageDeletionBlocks(client, subtreeRows, true);
          assertPageDeletionSnapshot(expectedSnapshot, subtreeRows, blockRows);

          for (const page of [...subtreeRows].reverse()) {
            await client.execute("DELETE FROM pages WHERE id = ? AND owner_id = ?", [page.id, user.id]);
          }
          return {
            attachmentIds: blockRows.filter((row) => row.type === "ATTACHMENT").map((row) => row.id),
            pageIds: subtreeRows.map((row) => row.id)
          };
        });

        for (const deletedPageId of deletion.pageIds) disconnectPageCollaborators(deletedPageId, "Page was deleted");
        await removeDeletedAttachmentFiles(user.id, deletion.attachmentIds);
        res.status(204).send();
        return;
      }

      if (!body.expectedVersion) {
        throw new ApiError(
          400,
          "PAGE_EDIT_VERSION_REQUIRED",
          "The last observed page version is required before archiving this page."
        );
      }
      const expectedVersion = body.expectedVersion;
      const result = await transaction(async (client) => {
        const page = await client.queryOne<PageRow>(
          "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
          [pageId, user.id]
        );
        if (!page) throw notFound("Page");
        await assertCollaborationMaterialized(client, [pageId]);
        const updateResult = await client.execute<{ affectedRows: number }>(
          `UPDATE pages
           SET is_archived = 1, edit_version = edit_version + 1
           WHERE id = ? AND owner_id = ? AND edit_version = ?`,
          [pageId, user.id, expectedVersion]
        );
        if (Number(updateResult.affectedRows) === 1) {
          const updatedPage = await client.queryOne<PageRow>("SELECT * FROM pages WHERE id = ?", [pageId]);
          if (!updatedPage) throw notFound("Page");
          await recordPageVersion(client, {
            pageId,
            actors: [toPageVersionActor(user)],
            source: "ARCHIVE",
            changes: diffPageVersionPage(page, updatedPage)
          });
        }
        return updateResult;
      });
      if (Number(result.affectedRows) === 0) {
        throw new ApiError(
          409,
          "PAGE_EDIT_CONFLICT",
          "This page was changed in another session. It was not archived."
        );
      }
      disconnectPageCollaborators(pageId, "Page was archived");
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
    const { tags, expectedVersion } = req.body as z.infer<typeof tagSchema>;
    await transaction(async (client) => {
      const existingPage = await client.queryOne<PageRow>(
        "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
        [pageId, user.id]
      );
      if (!existingPage) throw notFound("Page");
      const beforeTags = (await getPageTags(pageId, client)).map((tag) => tag.name);
      const result = await client.execute<{ affectedRows: number }>(
        "UPDATE pages SET edit_version = edit_version + 1 WHERE id = ? AND owner_id = ? AND edit_version = ?",
        [pageId, user.id, expectedVersion]
      );
      if (Number(result.affectedRows) === 0) {
        throw new ApiError(
          409,
          "PAGE_EDIT_CONFLICT",
          "This page was changed in another session. Your local edits were not overwritten."
        );
      }
      await replaceTags(client, pageId, tags);
      const updatedPage = await client.queryOne<PageRow>("SELECT * FROM pages WHERE id = ?", [pageId]);
      if (!updatedPage) throw notFound("Page");
      const afterTags = (await getPageTags(pageId, client)).map((tag) => tag.name);
      await recordPageVersion(client, {
        pageId,
        actors: [toPageVersionActor(user)],
        source: "TAGS",
        changes: diffPageVersionPage(existingPage, updatedPage, beforeTags, afterTags)
      });
    });
    const page = await assertOwnedPage(pageId, user.id);
    res.json({ tags: await getPageTags(pageId), version: Number(page.edit_version ?? 1) });
  } catch (error) {
    next(error);
  }
});

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

pageRouter.get("/:pageId/render", validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const pageId = String(req.params.pageId);
    await getPageAccess(pageId, user.id);
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
        return `<section data-block-id="${escapeHtmlAttribute(block.id)}" data-block-type="${escapeHtmlAttribute(block.type)}">${blockHtml}</section>`;
      })
      .join("\n");

    res.setHeader("Cache-Control", "private, no-store");
    res.json({ html });
  } catch (error) {
    next(error);
  }
});
