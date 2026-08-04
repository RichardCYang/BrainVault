import type { BlockRow, PageRow, TagRow, UserRow } from "../types/domain.js";
import { toPublicPageCoverUrl } from "./page-cover.js";

export function toPublicUser(
  row: Pick<
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
  >
) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    avatarData: row.avatar_data ?? null,
    preferredLanguage: row.preferred_language ?? null,
    defaultCollectionIcon: row.default_collection_icon ?? null,
    theme: row.theme === "dark" ? "dark" : "light",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function toPage(row: PageRow) {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    coverUrl: toPublicPageCoverUrl(row.id, row.cover_url, Number(row.edit_version ?? 1)),
    coverPositionX: Math.min(100, Math.max(0, Number(row.cover_position_x ?? 50))),
    coverPositionY: Math.min(100, Math.max(0, Number(row.cover_position_y ?? 50))),
    isArchived: Boolean(row.is_archived),
    isCollection: Boolean(row.is_collection),
    ownerId: row.owner_id,
    parentPageId: row.parent_page_id,
    version: Number(row.edit_version ?? 1),
    contentVersion: Number(row.content_version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseMetadata(metadata: BlockRow["metadata"]) {
  if (!metadata) return null;
  if (typeof metadata !== "string") return metadata;

  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function toBlock(row: BlockRow) {
  return {
    id: row.id,
    pageId: row.page_id,
    parentBlockId: row.parent_block_id,
    type: row.type,
    markdown: row.markdown,
    htmlCache: row.html_cache,
    checked: Boolean(row.checked),
    sortOrder: row.sort_order,
    metadata: parseMetadata(row.metadata),
    version: Number(row.edit_version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function toTag(row: TagRow) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at
  };
}
