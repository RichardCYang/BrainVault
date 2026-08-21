import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db, transaction, type DbClient, type DbValue } from "../lib/db.js";
import { assertCurrentAuthSessionBoundary } from "../lib/auth-sessions.js";
import { createId } from "../lib/id.js";
import { lockUserAttachmentGeneration, removeDeletedAttachmentFiles } from "../lib/attachments.js";
import { renderBlockHtml, sanitizeRenderedHtml } from "../lib/markdown.js";
import { createMutationRequestHash, isMatchingMutationReplay } from "../lib/mutation.js";
import { assessPageCreateMutationReceipt, type PageCreateMutationReceipt } from "../lib/page-create-mutation.js";
import { assessPageDeleteMutationReceipt, type PageDeleteMutationReceipt } from "../lib/page-delete-mutation.js";
import {
  assessPageVersionResetMutationReceipt,
  type PageVersionResetMutationReceipt
} from "../lib/page-version-reset-mutation.js";
import { toBlock, toPage, toTag } from "../lib/mappers.js";
import {
  assertPageNotArchived,
  getOwnedPage,
  getPageAccess,
  pageSummaryProjection,
  toAccessPayload,
  toCollaborationPayload
} from "../lib/page-access.js";
import {
  disconnectPageCollaborators,
  disconnectPageCollaboratorsForDocumentEpoch
} from "../lib/collaboration-server.js";
import { needsCollaborationMaterialization } from "../lib/collaboration-protocol.js";
import { ApiError, notFound } from "../lib/http.js";
import { iconMutationValueSchema, normalizeIconValue } from "../lib/icon-value.js";
import { inspectCustomCoverDataUrl, pageCoverPositionSchema, pageCoverUrlSchema } from "../lib/page-cover.js";
import { toSqlLikeContainsPattern } from "../lib/sql-like.js";
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
import { requireAuth, requireRequestAuthScope } from "../middleware/auth.js";
import { getValidatedQuery, validate } from "../middleware/validate.js";
import { buildBlockTree } from "../utils/blockTree.js";
import { idParamSchema, requireUser, routeIdSchema, safeVersionSchema } from "../utils/schemas.js";
import type { BlockRow, PageRow, TagRow } from "../types/domain.js";
import { assertNoActiveCollaborationWriteLeases } from "../lib/collaboration-write-lease.js";
import { preserveRecoveryGrantsForPages } from "../lib/recovery-candidates.js";

export const pageRouter = Router();

pageRouter.use(requireAuth);

const mutationIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);

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
  icon: iconMutationValueSchema.optional(),
  coverUrl: pageCoverUrlSchema.optional(),
  coverPositionX: pageCoverPositionSchema.optional(),
  coverPositionY: pageCoverPositionSchema.optional(),
  parentPageId: z.string().min(1).optional(),
  isCollection: z.boolean().optional().default(false),
  initialMarkdown: z.string().max(20_000).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  mutationId: mutationIdSchema.optional()
});

const updatePageSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  icon: iconMutationValueSchema.nullable().optional(),
  coverUrl: pageCoverUrlSchema.nullable().optional(),
  coverPositionX: pageCoverPositionSchema.optional(),
  coverPositionY: pageCoverPositionSchema.optional(),
  isArchived: z.boolean().optional(),
  parentPageId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  expectedVersion: safeVersionSchema,
  mutationId: mutationIdSchema.optional()
});

const tagSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(50)).max(20),
  expectedVersion: safeVersionSchema
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
    expectedVersion: safeVersionSchema.optional(),
    mutationId: mutationIdSchema.optional()
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

const pageVersionResetSchema = z.object({
  mutationId: mutationIdSchema,
  expectedVersion: safeVersionSchema,
  expectedContentVersion: safeVersionSchema,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
});

function isDuplicateEntryError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";
}

async function assertOwnedPage(pageId: string, ownerId: string, client: DbClient = db) {
  return getOwnedPage(pageId, ownerId, client);
}

type PageDeletionPageRow = {
  id: string;
  parent_page_id: string | null;
  edit_version: number;
  content_version: number;
  is_archived: 0 | 1;
  is_collection: 0 | 1;
};

type PageDeletionBlockRow = {
  id: string;
  page_id: string;
  type: string;
  edit_version: number;
};

type PageDeletionShareRow = {
  page_id: string;
  user_id: string;
  permission: string;
  generation: string;
};

type PageDeletionCollaborationRow = {
  page_id: string;
  document_epoch: string;
};

async function getOwnedPageTreeRows(ownerId: string, client: DbClient = db, lock = false) {
  return client.query<PageDeletionPageRow>(
    `SELECT id, parent_page_id, edit_version, content_version, is_archived, is_collection
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
  const parent = rowById.get(parentPageId);
  if (!parent) {
    throw new ApiError(400, "INVALID_PARENT_PAGE", "Parent page does not exist");
  }
  if (parent.is_archived) {
    throw new ApiError(409, "PARENT_PAGE_ARCHIVED", "Restore the destination page before moving this page");
  }
  if (parent.is_collection) {
    throw new ApiError(400, "INVALID_PARENT_PAGE", "A collection cannot be used as a page-move destination");
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

async function getPageDeletionShares(
  client: DbClient,
  subtreeRows: PageDeletionPageRow[],
  lock = false
) {
  const shares: PageDeletionShareRow[] = [];
  for (const page of subtreeRows) {
    const rows = await client.query<PageDeletionShareRow>(
      `SELECT page_id, user_id, permission, generation
       FROM page_shares
       WHERE page_id = ?
       ORDER BY user_id ASC${lock ? " FOR UPDATE" : ""}`,
      [page.id]
    );
    shares.push(...rows);
  }
  return shares;
}

async function getPageDeletionCollaborationStates(
  client: DbClient,
  subtreeRows: PageDeletionPageRow[],
  lock = false
) {
  const pageIds = [...new Set(subtreeRows.map((page) => page.id).filter(Boolean))];
  const states: PageDeletionCollaborationRow[] = [];
  for (let offset = 0; offset < pageIds.length; offset += 500) {
    const group = pageIds.slice(offset, offset + 500);
    const rows = await client.query<PageDeletionCollaborationRow>(
      `SELECT page_id, document_epoch
       FROM page_collaboration_state
       WHERE page_id IN (${group.map(() => "?").join(", ")})
       ORDER BY page_id ASC${lock ? " FOR UPDATE" : ""}`,
      group
    );
    states.push(...rows);
  }
  return states;
}

function createPageDeletionSnapshot(
  pages: PageDeletionPageRow[],
  blocks: PageDeletionBlockRow[],
  shares: PageDeletionShareRow[],
  collaborationStates: PageDeletionCollaborationRow[]
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
  for (const share of [...shares].sort((left, right) =>
    left.page_id.localeCompare(right.page_id) || left.user_id.localeCompare(right.user_id)
  )) {
    hash.update(
      `share\0${share.page_id}\0${share.user_id}\0${share.permission}\0${share.generation}\n`
    );
  }
  for (const state of [...collaborationStates].sort((left, right) =>
    left.page_id.localeCompare(right.page_id)
  )) {
    hash.update(`collaboration\0${state.page_id}\0${state.document_epoch}\n`);
  }
  return hash.digest("hex");
}

function assertPageDeletionSnapshot(
  expectedSnapshot: string,
  pages: PageDeletionPageRow[],
  blocks: PageDeletionBlockRow[],
  shares: PageDeletionShareRow[],
  collaborationStates: PageDeletionCollaborationRow[]
) {
  if (createPageDeletionSnapshot(pages, blocks, shares, collaborationStates) === expectedSnapshot) return;
  throw new ApiError(
    409,
    "PAGE_EDIT_CONFLICT",
    "This page subtree changed in another session. It was not deleted."
  );
}

async function assertPageDeleteReplayNotSuperseded(client: DbClient, pageIds: readonly string[]) {
  const uniquePageIds = [...new Set(pageIds.filter(Boolean))];
  for (let offset = 0; offset < uniquePageIds.length; offset += 500) {
    const group = uniquePageIds.slice(offset, offset + 500);
    const rows = await client.query<{ id: string }>(
      `SELECT id FROM pages
       WHERE id IN (${group.map(() => "?").join(", ")})
       FOR UPDATE`,
      group
    );
    if (!rows.length) continue;
    throw new ApiError(
      409,
      "PAGE_DELETE_REPLAY_SUPERSEDED",
      "This deletion was already completed for an older page generation. A page with the same id now exists and was not deleted. Refresh before deleting again."
    );
  }
}

async function disconnectArchivedPageCollaboratorsIfCurrent(
  pageId: string,
  ownerId: string,
  archivedVersion: number
) {
  try {
    await transaction(async (client) => {
      // Keep the generation check and process-local room invalidation under the
      // same page-row lock. Without the lock, the SELECT can observe the
      // archived generation, a concurrent restore can commit, and this stale
      // handler can then disconnect collaborators from the restored page.
      const currentPage = await client.queryOne<Pick<PageRow, "is_archived" | "edit_version">>(
        `SELECT is_archived, edit_version
         FROM pages
         WHERE id = ? AND owner_id = ?
         FOR UPDATE`,
        [pageId, ownerId]
      );
      if (
        !currentPage
        || !currentPage.is_archived
        || Number(currentPage.edit_version ?? 1) !== archivedVersion
      ) {
        return;
      }

      // Restore and collaboration-session admission both need this page row.
      // They cannot cross this synchronous disconnect until the lock releases.
      disconnectPageCollaborators(pageId, "Page was archived");
    });
  } catch (error) {
    // A failed post-COMMIT verification must not guess that this page id still
    // denotes the archived generation; skipping the disconnect is safer than
    // evicting collaborators from a page that may already have been restored.
    console.error("Failed to verify archived page before disconnecting collaborators", { pageId, error });
  }
}

type PageCollaborationDocumentEpoch = {
  pageId: string;
  documentEpoch: string;
};

async function getPageCollaborationDocumentEpochs(
  client: DbClient,
  pageIds: readonly string[]
): Promise<PageCollaborationDocumentEpoch[]> {
  const uniquePageIds = [...new Set(pageIds.filter(Boolean))];
  const lineages: PageCollaborationDocumentEpoch[] = [];
  for (let offset = 0; offset < uniquePageIds.length; offset += 500) {
    const group = uniquePageIds.slice(offset, offset + 500);
    const rows = await client.query<{ page_id: string; document_epoch: string }>(
      `SELECT page_id, document_epoch
       FROM page_collaboration_state
       WHERE page_id IN (${group.map(() => "?").join(", ")})`,
      group
    );
    lineages.push(...rows.map((row) => ({
      pageId: row.page_id,
      documentEpoch: row.document_epoch
    })));
  }
  return lineages;
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

async function assertOwnedParentPage(
  parentPageId: string | null | undefined,
  ownerId: string,
  client: DbClient = db,
  lock = false
) {
  if (!parentPageId) return;
  const parent = await client.queryOne<Pick<PageDeletionPageRow, "id" | "is_archived" | "is_collection">>(
    `SELECT id, is_archived, is_collection FROM pages WHERE id = ? AND owner_id = ?${lock ? " FOR UPDATE" : ""}`,
    [parentPageId, ownerId]
  );
  if (!parent) throw new ApiError(400, "INVALID_PARENT_PAGE", "Parent page does not exist");
  if (parent.is_archived) {
    throw new ApiError(409, "PARENT_PAGE_ARCHIVED", "Restore the destination page before creating a subpage");
  }
  if (parent.is_collection) {
    throw new ApiError(400, "INVALID_PARENT_PAGE", "A collection cannot be used as a page-create destination");
  }
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
    `SELECT ${pageSummaryProjection("c")} FROM pages c
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
        `(p.title LIKE ? ESCAPE '!' OR EXISTS (
          SELECT 1 FROM blocks b WHERE b.page_id = p.id AND b.markdown LIKE ? ESCAPE '!'
        ))`
      );
      const search = toSqlLikeContainsPattern(query.q);
      whereParams.push(search, search);
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
      `SELECT ${pageSummaryProjection("p")},
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
    const authScope = requireRequestAuthScope(req);
    const body = req.body as z.infer<typeof createPageSchema>;
    const { mutationId, ...creation } = body;
    const mutationHash = mutationId ? createMutationRequestHash(creation) : undefined;
    if (creation.isCollection && creation.parentPageId) {
      throw new ApiError(400, "INVALID_COLLECTION_PARENT", "A collection cannot have a parent page");
    }

    const pageId = await transaction(async (client) => {
      await assertCurrentAuthSessionBoundary(user.id, authScope, client);
      const id = createId("pag");
      if (mutationId && mutationHash) {
        let reserved = true;
        try {
          await client.execute(
            `INSERT INTO page_create_mutations (owner_id, mutation_id, page_id, request_hash)
             VALUES (?, ?, ?, ?)`,
            [user.id, mutationId, id, mutationHash]
          );
        } catch (error) {
          if (!isDuplicateEntryError(error)) throw error;
          reserved = false;
        }
        if (!reserved) {
          const receipt = await client.queryOne<PageCreateMutationReceipt>(
            `SELECT page_id, request_hash
             FROM page_create_mutations
             WHERE owner_id = ? AND mutation_id = ?
             FOR UPDATE`,
            [user.id, mutationId]
          );
          const assessment = assessPageCreateMutationReceipt(receipt, mutationHash);
          if (assessment.kind === "collision") {
            throw new ApiError(
              409,
              "MUTATION_ID_REUSED",
              "This mutation id was already used for a different page creation request. No additional page was created."
            );
          }
          if (assessment.kind !== "replay") {
            throw new ApiError(500, "PAGE_CREATE_RECEIPT_MISSING", "The page creation receipt is unavailable");
          }
          const replayPage = await client.queryOne<{ id: string }>(
            "SELECT id FROM pages WHERE id = ? AND owner_id = ?",
            [assessment.pageId, user.id]
          );
          if (!replayPage) {
            throw new ApiError(
              409,
              "PAGE_CREATE_REPLAY_UNAVAILABLE",
              "This page creation was already completed, but the created page is no longer available. No additional page was created."
            );
          }
          return assessment.pageId;
        }
      }

      // Exact idempotent replays must be resolved before validating mutable
      // hierarchy state. For a fresh create, lock and revalidate the parent
      // in this transaction so deletion/reparenting races cannot make the
      // insert depend on a stale pre-transaction existence check.
      await assertOwnedParentPage(creation.parentPageId, user.id, client, true);

      await client.execute(
        `INSERT INTO pages
           (id, title, icon, cover_url, cover_position_x, cover_position_y, is_collection, owner_id, parent_page_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          creation.title,
          normalizeIconValue(creation.icon ?? null),
          creation.coverUrl ?? null,
          creation.coverPositionX ?? 50,
          creation.coverPositionY ?? 50,
          creation.isCollection ? 1 : 0,
          user.id,
          creation.parentPageId ?? null
        ]
      );

      if (creation.initialMarkdown) {
        await client.execute(
          `INSERT INTO blocks (id, page_id, type, markdown, html_cache, sort_order)
           VALUES (?, ?, 'MARKDOWN', ?, ?, 0)`,
          [createId("blk"), id, creation.initialMarkdown, renderBlockHtml("MARKDOWN", creation.initialMarkdown)]
        );
      }

      if (creation.tags?.length) await replaceTags(client, id, creation.tags);
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

pageRouter.get("/:pageId/cover", validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const pageId = String(req.params.pageId);
    const row = await db.queryOne<{ cover_url: string | null }>(
      `SELECT p.cover_url
       FROM pages p
       WHERE p.id = ?
         AND (p.owner_id = ? OR EXISTS (
           SELECT 1 FROM page_shares ps
           WHERE ps.page_id = p.id AND ps.user_id = ? AND ps.permission = 'EDIT'
         ))`,
      [pageId, user.id, user.id]
    );
    if (!row?.cover_url?.startsWith("data:")) throw notFound("Page cover");

    const { mimeType, bytes } = inspectCustomCoverDataUrl(row.cover_url);
    const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    res.setHeader("ETag", etag);
    res.setHeader("Vary", "Cookie, Authorization");
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Content-Disposition", "inline");
    res.end(bytes);
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
  validate({ params: idParamSchema, body: pageVersionResetSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const pageId = String(req.params.pageId);
      const { mutationId, expectedVersion, expectedContentVersion, expectedRevision } =
        req.body as z.infer<typeof pageVersionResetSchema>;
      const requestHash = createMutationRequestHash({
        pageId,
        expectedVersion,
        expectedContentVersion,
        expectedRevision
      });
      const reset = await transaction(async (client) => {
        // Workspace export/restore and attachment cleanup lock the owner before pages.
        // Keep the same order before inserting the owner-referencing receipt.
        const lockedOwner = await client.queryOne<{ id: string }>(
          "SELECT id FROM users WHERE id = ? FOR UPDATE",
          [user.id]
        );
        if (!lockedOwner) throw notFound("User");
        await assertCurrentAuthSessionBoundary(user.id, authScope, client);

        const page = await client.queryOne<PageRow>(
          "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
          [pageId, user.id]
        );
        if (!page) throw notFound("Page");

        let reserved = true;
        try {
          await client.execute(
            `INSERT INTO page_version_reset_mutations
               (owner_id, mutation_id, page_id, request_hash)
             VALUES (?, ?, ?, ?)`,
            [user.id, mutationId, pageId, requestHash]
          );
        } catch (error) {
          if (!isDuplicateEntryError(error)) throw error;
          reserved = false;
        }

        if (!reserved) {
          const receipt = await client.queryOne<PageVersionResetMutationReceipt>(
            `SELECT page_id, request_hash, revision, deleted_count
             FROM page_version_reset_mutations
             WHERE owner_id = ? AND mutation_id = ?
             FOR UPDATE`,
            [user.id, mutationId]
          );
          const assessment = assessPageVersionResetMutationReceipt(receipt, { pageId, requestHash });
          if (assessment.kind === "collision") {
            throw new ApiError(
              409,
              "MUTATION_ID_REUSED",
              "This mutation id was already used for a different page-version reset request. The history was not reset again."
            );
          }
          if (assessment.kind === "incomplete") {
            throw new ApiError(
              500,
              "PAGE_VERSION_RESET_RECEIPT_INCOMPLETE",
              "The page-version reset receipt is incomplete. The history was not reset again."
            );
          }
          if (assessment.kind !== "replay") {
            throw new ApiError(
              500,
              "PAGE_VERSION_RESET_RECEIPT_MISSING",
              "The page-version reset receipt is unavailable"
            );
          }
          return {
            revision: assessment.revision,
            deletedCount: assessment.deletedCount,
            replayed: true
          };
        }

        const latestVersion = await client.queryOne<{ revision: number | bigint | null }>(
          "SELECT MAX(revision) AS revision FROM page_versions WHERE page_id = ?",
          [pageId]
        );
        const currentRevision = Number(latestVersion?.revision ?? 0);
        if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
          throw new ApiError(
            500,
            "PAGE_VERSION_REVISION_INVALID",
            "The current page-version revision is invalid"
          );
        }
        if (
          Number(page.edit_version ?? 1) !== expectedVersion
          || Number(page.content_version ?? 1) !== expectedContentVersion
          || currentRevision !== expectedRevision
        ) {
          throw new ApiError(
            409,
            "PAGE_VERSION_RESET_CONFLICT",
            "This page or its version history changed in another session. The newer history was not reset."
          );
        }

        const resetHistory = await resetPageVersionHistoryRecords(client, {
          page,
          actor: toPageVersionActor(user)
        });
        if (!resetHistory.version || resetHistory.version.revision !== 1) {
          throw new ApiError(500, "PAGE_VERSION_RESET_FAILED", "Page version history was not reset");
        }
        const receiptUpdate = await client.execute<{ affectedRows: number }>(
          `UPDATE page_version_reset_mutations
           SET revision = ?, deleted_count = ?
           WHERE owner_id = ? AND mutation_id = ?`,
          [resetHistory.version.revision, resetHistory.deletedCount, user.id, mutationId]
        );
        if (Number(receiptUpdate.affectedRows ?? 0) !== 1) {
          throw new ApiError(
            500,
            "PAGE_VERSION_RESET_RECEIPT_UPDATE_FAILED",
            "The page-version reset receipt could not be completed"
          );
        }
        return {
          revision: resetHistory.version.revision,
          deletedCount: resetHistory.deletedCount,
          replayed: false
        };
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
        const shareRows = await getPageDeletionShares(client, subtreeRows);
        const collaborationRows = await getPageDeletionCollaborationStates(client, subtreeRows);
        return {
          snapshot: createPageDeletionSnapshot(subtreeRows, blockRows, shareRows, collaborationRows),
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
    const authScope = requireRequestAuthScope(req);
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
    if (updates.coverPositionX !== undefined) {
      fields.push("cover_position_x = ?");
      values.push(updates.coverPositionX);
    }
    if (updates.coverPositionY !== undefined) {
      fields.push("cover_position_y = ?");
      values.push(updates.coverPositionY);
    }
    if (updates.isArchived !== undefined) {
      fields.push("is_archived = ?");
      values.push(updates.isArchived ? 1 : 0);
    }
    if (updates.parentPageId !== undefined) {
      fields.push("parent_page_id = ?");
      values.push(updates.parentPageId);
    }

    const page = await transaction(async (client) => {
      await assertCurrentAuthSessionBoundary(user.id, authScope, client);
      let existingPage: PageRow;
      let lockedRows: PageDeletionPageRow[] | undefined;
      if (updates.parentPageId !== undefined) {
        lockedRows = await getOwnedPageTreeRows(user.id, client, true);
        const lockedPage = await client.queryOne<PageRow>(
          "SELECT * FROM pages WHERE id = ? AND owner_id = ?",
          [pageId, user.id]
        );
        if (!lockedPage) throw notFound("Page");
        existingPage = lockedPage;
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
      ) {
        return getPageResponse(pageId, user.id, client);
      }

      // Exact response-loss replays must be resolved before validating the
      // destination's current mutable state. The original move may have
      // committed before the destination was archived or otherwise changed.
      if (updates.parentPageId !== undefined) {
        if (!lockedRows) {
          throw new ApiError(500, "PAGE_HIERARCHY_LOCK_MISSING", "Page hierarchy validation is unavailable");
        }
        assertPageParentFromLockedRows(pageId, updates.parentPageId, lockedRows);
      }

      const isArchivedRestoreOnly =
        updates.isArchived === false && tags === undefined && Object.keys(updates).length === 1;
      if (existingPage.is_archived && !isArchivedRestoreOnly) {
        assertPageNotArchived(existingPage);
      }

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
        await assertNoActiveCollaborationWriteLeases(client, [pageId]);
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
        } else {
          // Any later edit that does not carry a mutation id must invalidate the
          // previous replay marker. Otherwise a delayed retry can be mistaken
          // for the latest page mutation and inherit an unrelated edit version.
          updateFields.push("last_mutation_id = NULL", "last_mutation_hash = NULL");
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

      // Materialize the response while the page row is still locked. Returning
      // a post-COMMIT read would let an intervening writer donate its newer
      // edit_version to this mutation's acknowledgement.
      return getPageResponse(pageId, user.id, client);
    });

    if (updates.isArchived === true) {
      await disconnectArchivedPageCollaboratorsIfCurrent(pageId, user.id, Number(page.version ?? 1));
    }
    res.json({ page });
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
      const authScope = requireRequestAuthScope(req);
      const pageId = String(req.params.pageId);
      const query = getValidatedQuery<z.infer<typeof deletePageQuerySchema>>(req);
      const body = req.body as z.infer<typeof deletePageBodySchema>;

      if (query.permanent) {
        if (!body.expectedSnapshot) {
          throw new ApiError(
            400,
            "PAGE_DELETE_SNAPSHOT_REQUIRED",
            "Refresh the page deletion snapshot before permanently deleting this page."
          );
        }
        const mutationId = body.mutationId;
        if (!mutationId) {
          throw new ApiError(
            400,
            "MUTATION_ID_REQUIRED",
            "A mutation id is required for permanent page deletion."
          );
        }

        const expectedSnapshot = body.expectedSnapshot;
        const mutationHash = createMutationRequestHash({
          kind: "PAGE_DELETE",
          pageId,
          expectedSnapshot
        });
        const deletion = await transaction(async (client) => {
          // Serialize receipt creation for this actor before taking page locks.
          // The receipt deliberately has no FK to pages so it survives deletion
          // and can reconcile an unknown COMMIT outcome.
          const attachmentGeneration = await lockUserAttachmentGeneration(client, user.id);
          if (attachmentGeneration === undefined) {
            throw new ApiError(401, "UNAUTHENTICATED", "Authentication is required");
          }
          await assertCurrentAuthSessionBoundary(user.id, authScope, client);

          const receipt = await client.queryOne<PageDeleteMutationReceipt>(
            `SELECT page_id, request_hash, page_ids, attachment_ids, attachment_generation
             FROM page_delete_mutations
             WHERE actor_id = ? AND mutation_id = ?
             FOR UPDATE`,
            [user.id, mutationId]
          );
          if (receipt) {
            const assessment = assessPageDeleteMutationReceipt(receipt, {
              pageId,
              requestHash: mutationHash
            });
            if (assessment.kind === "collision") {
              throw new ApiError(
                409,
                "MUTATION_ID_REUSED",
                "This mutation id was already used for a different page deletion request. No additional page was deleted."
              );
            }
            if (assessment.kind === "incomplete") {
              throw new ApiError(
                500,
                "PAGE_DELETE_RECEIPT_INCOMPLETE",
                "The page deletion receipt is incomplete. The deletion was not repeated."
              );
            }
            // Receipts deliberately survive page deletion. A restore can later
            // recreate the same IDs, so an old response-loss retry must not be
            // acknowledged as deleting the new generation.
            await assertPageDeleteReplayNotSuperseded(client, assessment.pageIds);
            return {
              attachmentIds: assessment.attachmentIds,
              pageIds: assessment.pageIds,
              attachmentGeneration: assessment.attachmentGeneration,
              replayed: true as const
            };
          }

          const treeRows = await getOwnedPageTreeRows(user.id, client, true);
          const subtreeRows = getPageSubtreeRows(pageId, treeRows);
          await assertCollaborationMaterialized(client, subtreeRows.map((page) => page.id));
          const blockRows = await getPageDeletionBlocks(client, subtreeRows, true);
          // Share creation/removal also serializes on the owned page row. Hash
          // the exact grant generations while those page locks are held so a
          // stale delete cannot erase a page whose sharing lineage changed.
          const shareRows = await getPageDeletionShares(client, subtreeRows, true);
          // A restored shared page can legitimately have no collaboration-state
          // row until its first post-restore session is opened. Session admission
          // creates a fresh document epoch without changing page/block/share
          // versions, so bind permanent deletion to that lineage as well.
          const collaborationRows = await getPageDeletionCollaborationStates(client, subtreeRows, true);
          assertPageDeletionSnapshot(
            expectedSnapshot,
            subtreeRows,
            blockRows,
            shareRows,
            collaborationRows
          );

          const pageIds = subtreeRows.map((row) => row.id);
          // Capture the durable collaboration lineage while the owned page rows
          // are still locked. Post-COMMIT cleanup can then invalidate only the
          // room belonging to this deleted generation, even if restore has
          // already recreated the same page id with a new document epoch.
          const collaborationDocumentEpochs = await getPageCollaborationDocumentEpochs(client, pageIds);

          // Page rows are already locked by getOwnedPageTreeRows(..., true).
          // Reject deletion while a server-admitted collaboration write is
          // validating, and preserve late-upload grants for offline browsers.
          await assertNoActiveCollaborationWriteLeases(client, pageIds);
          await preserveRecoveryGrantsForPages(client, user.id, pageIds, "PAGE_DELETED");

          for (const page of [...subtreeRows].reverse()) {
            await client.execute("DELETE FROM pages WHERE id = ? AND owner_id = ?", [page.id, user.id]);
          }

          const attachmentIds = blockRows
            .filter((row) => row.type === "ATTACHMENT")
            .map((row) => row.id);
          await client.execute(
            `INSERT INTO page_delete_mutations
               (actor_id, mutation_id, page_id, request_hash, page_ids, attachment_ids, attachment_generation)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              user.id,
              mutationId,
              pageId,
              mutationHash,
              JSON.stringify(pageIds),
              JSON.stringify(attachmentIds),
              attachmentGeneration
            ]
          );
          return {
            attachmentIds,
            pageIds,
            attachmentGeneration,
            collaborationDocumentEpochs,
            replayed: false as const
          };
        });

        // A receipt replay never owns a fresh collaboration cleanup. For a new
        // delete, invalidate only the exact document lineage captured before
        // the rows were removed. A restore reusing the same page id gets a new
        // epoch and its room is therefore preserved.
        if (!deletion.replayed) {
          for (const lineage of deletion.collaborationDocumentEpochs) {
            disconnectPageCollaboratorsForDocumentEpoch(
              lineage.pageId,
              lineage.documentEpoch,
              "Page was deleted"
            );
          }
        }
        // Filesystem cleanup is idempotent and may repeat on receipt replay,
        // but only with the generation captured by the original destructive
        // transaction. Legacy receipts intentionally skip filesystem cleanup.
        if (deletion.attachmentGeneration !== undefined) {
          await removeDeletedAttachmentFiles(
            user.id,
            deletion.attachmentIds,
            deletion.attachmentGeneration
          );
        }
        res.status(204).send();
        return;
      }

      await assertOwnedPage(pageId, user.id);
      if (!body.expectedVersion) {
        throw new ApiError(
          400,
          "PAGE_EDIT_VERSION_REQUIRED",
          "The last observed page version is required before archiving this page."
        );
      }
      const expectedVersion = body.expectedVersion;
      const archivedPage = await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(user.id, authScope, client);
        const page = await client.queryOne<PageRow>(
          "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
          [pageId, user.id]
        );
        if (!page) throw notFound("Page");
        await assertCollaborationMaterialized(client, [pageId]);
        await assertNoActiveCollaborationWriteLeases(client, [pageId]);
        const updateResult = await client.execute<{ affectedRows: number }>(
          `UPDATE pages
           SET is_archived = 1,
               edit_version = edit_version + 1,
               last_mutation_id = NULL,
               last_mutation_hash = NULL
           WHERE id = ? AND owner_id = ? AND edit_version = ?`,
          [pageId, user.id, expectedVersion]
        );
        if (Number(updateResult.affectedRows) === 0) {
          throw new ApiError(
            409,
            "PAGE_EDIT_CONFLICT",
            "This page was changed in another session. It was not archived."
          );
        }
        const updatedPage = await client.queryOne<PageRow>("SELECT * FROM pages WHERE id = ?", [pageId]);
        if (!updatedPage) throw notFound("Page");
        await recordPageVersion(client, {
          pageId,
          actors: [toPageVersionActor(user)],
          source: "ARCHIVE",
          changes: diffPageVersionPage(page, updatedPage)
        });
        // Keep the acknowledgement causally bound to this archive transaction.
        // A post-COMMIT read could otherwise return a later restore or edit.
        return updatedPage;
      });
      await disconnectArchivedPageCollaboratorsIfCurrent(
        pageId,
        user.id,
        Number(archivedPage.edit_version ?? 1)
      );
      res.json({ page: toPage(archivedPage) });
    } catch (error) {
      next(error);
    }
  }
);

pageRouter.put("/:pageId/tags", validate({ params: idParamSchema, body: tagSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const authScope = requireRequestAuthScope(req);
    const pageId = String(req.params.pageId);
    await assertOwnedPage(pageId, user.id);
    const { tags, expectedVersion } = req.body as z.infer<typeof tagSchema>;
    const result = await transaction(async (client) => {
      await assertCurrentAuthSessionBoundary(user.id, authScope, client);
      const existingPage = await client.queryOne<PageRow>(
        "SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE",
        [pageId, user.id]
      );
      if (!existingPage) throw notFound("Page");
      assertPageNotArchived(existingPage);
      const beforeTags = (await getPageTags(pageId, client)).map((tag) => tag.name);
      const updateResult = await client.execute<{ affectedRows: number }>(
        `UPDATE pages
         SET edit_version = edit_version + 1,
             last_mutation_id = NULL,
             last_mutation_hash = NULL
         WHERE id = ? AND owner_id = ? AND edit_version = ?`,
        [pageId, user.id, expectedVersion]
      );
      if (Number(updateResult.affectedRows) === 0) {
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
      return { tags: afterTags, version: Number(updatedPage.edit_version ?? 1) };
    });
    res.json(result);
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
        const blockHtml = block.type === "CALLOUT" || block.html_cache === null
          ? renderBlockHtml(block.type, block.markdown, Boolean(block.checked), block.metadata)
          : sanitizeRenderedHtml(block.html_cache);
        return `<section data-block-id="${escapeHtmlAttribute(block.id)}" data-block-type="${escapeHtmlAttribute(block.type)}">${blockHtml}</section>`;
      })
      .join("\n");

    res.setHeader("Cache-Control", "private, no-store");
    res.json({ html });
  } catch (error) {
    next(error);
  }
});
