import type { BlockRow, PageRow, TagRow, UserRow } from "../types/domain.js";

export function toPublicUser(row: Pick<UserRow, "id" | "username" | "name" | "created_at" | "updated_at">) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function toPage(row: PageRow) {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    coverUrl: row.cover_url,
    isArchived: Boolean(row.is_archived),
    ownerId: row.owner_id,
    parentPageId: row.parent_page_id,
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
