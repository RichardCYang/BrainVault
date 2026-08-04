import { db, type DbClient } from "./db.js";
import { ApiError, notFound } from "./http.js";
import { toPublicUser } from "./mappers.js";
import { storedCustomPageCoverSentinel } from "./page-cover.js";
import type { BlockRow, PageRow, UserRow } from "../types/domain.js";

export type PageAccessRole = "OWNER" | "EDITOR";

export type PageAccess = {
  page: PageRow;
  role: PageAccessRole;
  owner: ReturnType<typeof toPublicUser>;
  shareCount: number;
};

function pageRowProjection(alias = "") {
  const column = (name: string) => alias ? `${alias}.${name}` : name;
  return [
    "id", "title", "icon",
    `CASE WHEN ${column("cover_url")} LIKE 'data:image/%;base64,%' THEN '${storedCustomPageCoverSentinel}' ELSE ${column("cover_url")} END AS cover_url`,
    "cover_position_x", "cover_position_y", "is_archived", "is_collection", "owner_id",
    "parent_page_id", "edit_version", "content_version", "last_mutation_id", "last_mutation_hash",
    "created_at", "updated_at"
  ].map((name) => name.includes(" ") || name.includes("(") ? name : column(name)).join(", ");
}

export function pageSummaryProjection(alias = "") {
  return pageRowProjection(alias);
}

type OwnerProfileRow = Pick<
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

export async function getPageAccess(
  pageId: string,
  userId: string,
  client: DbClient = db,
  { lockPage = false }: { lockPage?: boolean } = {}
): Promise<PageAccess> {
  let page = await client.queryOne<PageRow>(
    `SELECT ${pageRowProjection()} FROM pages WHERE id = ? AND owner_id = ?${lockPage ? " FOR UPDATE" : ""}`,
    [pageId, userId]
  );
  let role: PageAccessRole = "OWNER";
  if (!page) {
    page = await client.queryOne<PageRow>(
      `SELECT ${pageRowProjection("p")}
       FROM pages p
       INNER JOIN page_shares ps ON ps.page_id = p.id AND ps.user_id = ? AND ps.permission = 'EDIT'
       WHERE p.id = ?${lockPage ? " FOR UPDATE" : ""}`,
      [userId, pageId]
    );
    role = "EDITOR";
  }
  if (!page) throw notFound("Page");

  const owner = await client.queryOne<OwnerProfileRow>(
    `SELECT id, username, name, avatar_data, preferred_language, default_collection_icon, theme, created_at, updated_at
     FROM users WHERE id = ?`,
    [page.owner_id]
  );
  const shareCountRow = await client.queryOne<{ share_count: number }>(
    "SELECT COUNT(*) AS share_count FROM page_shares WHERE page_id = ? AND permission = 'EDIT'",
    [pageId]
  );

  if (!owner) throw notFound("Page owner");
  return {
    page,
    role,
    owner: toPublicUser(owner),
    shareCount: Number(shareCountRow?.share_count ?? 0)
  };
}

export async function getOwnedPage(pageId: string, ownerId: string, client: DbClient = db) {
  const page = await client.queryOne<PageRow>(
    `SELECT ${pageRowProjection()} FROM pages WHERE id = ? AND owner_id = ?`,
    [pageId, ownerId]
  );
  if (!page) throw notFound("Page");
  return page;
}

export async function getBlockAccess(blockId: string, userId: string, client: DbClient = db) {
  const block = await client.queryOne<BlockRow>("SELECT * FROM blocks WHERE id = ?", [blockId]);
  if (!block) throw notFound("Block");
  try {
    const access = await getPageAccess(block.page_id, userId, client);
    return { block, access };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) throw notFound("Block");
    throw error;
  }
}

export function toAccessPayload(access: Pick<PageAccess, "role" | "shareCount">) {
  return {
    role: access.role,
    canEdit: true,
    canManageSharing: access.role === "OWNER",
    isOwner: access.role === "OWNER"
  };
}

export function toCollaborationPayload(access: Pick<PageAccess, "shareCount">) {
  return {
    enabled: access.shareCount > 0,
    participantCount: access.shareCount + 1
  };
}
