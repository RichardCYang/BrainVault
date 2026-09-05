import { db, type DbClient } from "./db.js";
import { ApiError, notFound } from "./http.js";
import { toPublicUser } from "./mappers.js";
import { storedCustomPageCoverSentinel } from "./page-cover.js";
import type { BlockRow, PageRow, UserRow } from "../types/domain.js";

export type CollectionSharePermission = "READ" | "WRITE" | "ADMIN";
export type PageAccessRole = "OWNER" | "ADMIN" | "EDITOR" | "READER";
export type PageAccessScope = "OWNER" | "COLLECTION" | "PAGE";

export type PageAccess = {
  page: PageRow;
  role: PageAccessRole;
  scope: PageAccessScope;
  shareGeneration: string | null;
  collectionId: string | null;
  collectionPermission: CollectionSharePermission | null;
  owner: ReturnType<typeof toPublicUser>;
  shareCount: number;
};

export function assertPageNotArchived(
  page: Pick<PageRow, "is_archived">,
  message = "Restore the page before editing it"
): void {
  if (page.is_archived) {
    throw new ApiError(409, "PAGE_ARCHIVED", message);
  }
}

export function canEditPageAccess(access: Pick<PageAccess, "role">): boolean {
  return access.role === "OWNER" || access.role === "ADMIN" || access.role === "EDITOR";
}

export function canAdministerPageAccess(access: Pick<PageAccess, "role">): boolean {
  return access.role === "OWNER" || access.role === "ADMIN";
}

export function assertPageCanEdit(
  access: Pick<PageAccess, "role">,
  message = "This page is read-only for your account"
): void {
  if (!canEditPageAccess(access)) {
    throw new ApiError(403, "PAGE_READ_ONLY", message);
  }
}

export function assertPageCanAdminister(
  access: Pick<PageAccess, "role">,
  message = "Administrator permission is required for this operation"
): void {
  if (!canAdministerPageAccess(access)) {
    throw new ApiError(403, "PAGE_ADMIN_REQUIRED", message);
  }
}

export function assertPageOwner(access: Pick<PageAccess, "role" | "scope">): void {
  if (access.role !== "OWNER" || access.scope !== "OWNER") {
    throw notFound("Page");
  }
}

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

type CollectionGrantRow = {
  permission: CollectionSharePermission;
  generation: string;
};

export async function getPageCollectionId(
  pageId: string,
  client: DbClient = db
): Promise<string | null> {
  const row = await client.queryOne<{ collection_id: string }>(
    "SELECT collection_id FROM page_collection_memberships WHERE page_id = ?",
    [pageId]
  );
  return row?.collection_id ?? null;
}

export async function getEffectivePageShareCount(
  pageId: string,
  client: DbClient = db,
  collectionId?: string | null,
  { lock = false }: { lock?: boolean } = {}
): Promise<number> {
  const resolvedCollectionId = collectionId === undefined
    ? await getPageCollectionId(pageId, client)
    : collectionId;

  if (lock) {
    // REPEATABLE READ snapshots may predate a grant transaction that committed
    // while this mutation waited for the page lock. Locking reads make the
    // authorization/share-mode decision against the current grant generation.
    const directRows = await client.query<{ user_id: string }>(
      `SELECT user_id FROM page_shares
       WHERE page_id = ? AND permission = 'EDIT'
       ORDER BY user_id ASC
       FOR UPDATE`,
      [pageId]
    );
    if (!resolvedCollectionId) return new Set(directRows.map((row) => row.user_id)).size;
    const collectionRows = await client.query<{ user_id: string }>(
      `SELECT user_id FROM collection_shares
       WHERE collection_id = ?
       ORDER BY user_id ASC
       FOR UPDATE`,
      [resolvedCollectionId]
    );
    return new Set([
      ...directRows.map((row) => row.user_id),
      ...collectionRows.map((row) => row.user_id)
    ]).size;
  }

  if (!resolvedCollectionId) {
    const count = await client.queryOne<{ share_count: number }>(
      "SELECT COUNT(*) AS share_count FROM page_shares WHERE page_id = ? AND permission = 'EDIT'",
      [pageId]
    );
    return Number(count?.share_count ?? 0);
  }

  const count = await client.queryOne<{ share_count: number }>(
    `SELECT COUNT(*) AS share_count
     FROM (
       SELECT cs.user_id
       FROM collection_shares cs
       WHERE cs.collection_id = ?
       UNION
       SELECT ps.user_id
       FROM page_shares ps
       WHERE ps.page_id = ? AND ps.permission = 'EDIT'
     ) effective_shares`,
    [resolvedCollectionId, pageId]
  );
  return Number(count?.share_count ?? 0);
}

export async function getPageAccess(
  pageId: string,
  userId: string,
  client: DbClient = db,
  { lockPage = false, lockAccess = false }: { lockPage?: boolean; lockAccess?: boolean } = {}
): Promise<PageAccess> {
  const page = await client.queryOne<PageRow>(
    `SELECT ${pageRowProjection()} FROM pages WHERE id = ?${lockPage ? " FOR UPDATE" : ""}`,
    [pageId]
  );
  if (!page) throw notFound("Page");

  // A page-row locking read is current, but it does not refresh an InnoDB
  // REPEATABLE READ snapshot that an earlier plain SELECT established. Direct
  // mutation callers can therefore request locking reads for every mutable
  // authorization/scope row after the page lock is acquired.
  const membership = await client.queryOne<{ collection_id: string }>(
    `SELECT collection_id
     FROM page_collection_memberships
     WHERE page_id = ?${lockAccess ? " FOR UPDATE" : ""}`,
    [pageId]
  );
  const collectionId = membership?.collection_id ?? null;
  let role: PageAccessRole;
  let scope: PageAccessScope;
  let shareGeneration: string | null = null;
  let collectionPermission: CollectionSharePermission | null = null;

  if (page.owner_id === userId) {
    role = "OWNER";
    scope = "OWNER";
  } else {
    // A collection grant is authoritative for every page in that collection.
    // It intentionally takes precedence over a direct page share, including a
    // READ collection grant overriding a legacy EDIT page grant.
    const collectionGrant = collectionId
      ? await client.queryOne<CollectionGrantRow>(
          `SELECT permission, generation
           FROM collection_shares
           WHERE collection_id = ? AND user_id = ?${lockAccess ? " FOR UPDATE" : ""}`,
          [collectionId, userId]
        )
      : null;

    if (collectionGrant) {
      collectionPermission = collectionGrant.permission;
      shareGeneration = collectionGrant.generation;
      scope = "COLLECTION";
      role = collectionGrant.permission === "ADMIN"
        ? "ADMIN"
        : collectionGrant.permission === "WRITE"
          ? "EDITOR"
          : "READER";
    } else {
      const pageGrant = await client.queryOne<{ generation: string }>(
        `SELECT generation
         FROM page_shares
         WHERE page_id = ? AND user_id = ? AND permission = 'EDIT'${lockAccess ? " FOR UPDATE" : ""}`,
        [pageId, userId]
      );
      if (!pageGrant) throw notFound("Page");
      role = "EDITOR";
      scope = "PAGE";
      shareGeneration = pageGrant.generation;
    }
  }

  const owner = await client.queryOne<OwnerProfileRow>(
    `SELECT id, username, name, avatar_data, preferred_language, default_collection_icon, theme, created_at, updated_at
     FROM users WHERE id = ?`,
    [page.owner_id]
  );
  if (!owner) throw notFound("Page owner");

  return {
    page,
    role,
    scope,
    shareGeneration,
    collectionId,
    collectionPermission,
    owner: toPublicUser(owner),
    shareCount: await getEffectivePageShareCount(pageId, client, collectionId, { lock: lockAccess })
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

export function toAccessPayload(
  access: Pick<PageAccess, "role" | "scope" | "collectionId" | "collectionPermission">
) {
  const canEdit = canEditPageAccess(access);
  const canAdminister = canAdministerPageAccess(access);
  return {
    role: access.role,
    scope: access.scope,
    permission: access.scope === "COLLECTION"
      ? access.collectionPermission
      : access.role === "OWNER"
        ? "OWNER"
        : "EDIT",
    collectionId: access.collectionId,
    canEdit,
    canManageSharing: canAdminister,
    canManagePage: canAdminister,
    canCreatePages: canAdminister,
    canDeletePages: canAdminister,
    isAdmin: access.role === "ADMIN",
    isOwner: access.role === "OWNER"
  };
}

export function toCollaborationPayload(access: Pick<PageAccess, "shareCount">) {
  return {
    enabled: access.shareCount > 0,
    participantCount: access.shareCount + 1
  };
}
