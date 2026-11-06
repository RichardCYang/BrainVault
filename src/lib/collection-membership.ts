import type { DbClient } from "./db.js";
import { assertHierarchyDepth, maxPageHierarchyDepth } from "../utils/hierarchy.js";

const membershipBatchSize = 250;

export async function setPageCollectionMembershipForCreate(
  client: DbClient,
  input: { pageId: string; isCollection: boolean; parentPageId?: string | null }
) {
  let collectionId: string | null = null;
  if (input.isCollection) {
    collectionId = input.pageId;
  } else if (input.parentPageId) {
    const parent = await client.queryOne<{ collection_id: string }>(
      "SELECT collection_id FROM page_collection_memberships WHERE page_id = ?",
      [input.parentPageId]
    );
    collectionId = parent?.collection_id ?? null;
  }

  if (!collectionId) return null;
  await client.execute(
    `INSERT INTO page_collection_memberships (page_id, collection_id)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE collection_id = VALUES(collection_id)`,
    [input.pageId, collectionId]
  );
  return collectionId;
}

export async function replacePageSubtreeCollectionMembership(
  client: DbClient,
  pageIds: readonly string[],
  collectionId: string | null
) {
  const uniqueIds = [...new Set(pageIds.filter(Boolean))];
  for (let offset = 0; offset < uniqueIds.length; offset += membershipBatchSize) {
    const group = uniqueIds.slice(offset, offset + membershipBatchSize);
    const placeholders = group.map(() => "?").join(", ");
    await client.execute(
      `DELETE FROM page_collection_memberships WHERE page_id IN (${placeholders})`,
      group
    );
    if (!collectionId) continue;
    for (const pageId of group) {
      await client.execute(
        "INSERT INTO page_collection_memberships (page_id, collection_id) VALUES (?, ?)",
        [pageId, collectionId]
      );
    }
  }
}

export async function rebuildOwnerPageCollectionMemberships(client: DbClient, ownerId: string) {
  const rows = await client.query<{
    id: string;
    parent_page_id: string | null;
    is_collection: number | boolean;
  }>(
    `SELECT id, parent_page_id, is_collection
     FROM pages
     WHERE owner_id = ?
     ORDER BY created_at ASC, id ASC`,
    [ownerId]
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));
  assertHierarchyDepth(new Map(rows.map((row) => [row.id, row.parent_page_id])), maxPageHierarchyDepth, "PAGE");
  await client.execute(
    `DELETE pcm FROM page_collection_memberships pcm
     INNER JOIN pages p ON p.id = pcm.page_id
     WHERE p.owner_id = ?`,
    [ownerId]
  );
  const resolved = new Map<string, string | null>();
  for (const row of rows) {
    const path: string[] = [];
    let current = rowById.get(row.id);
    let collectionId: string | null = null;
    while (current) {
      if (resolved.has(current.id)) {
        collectionId = resolved.get(current.id) ?? null;
        break;
      }
      path.push(current.id);
      if (current.is_collection) {
        collectionId = current.id;
        break;
      }
      current = current.parent_page_id ? rowById.get(current.parent_page_id) : undefined;
    }
    for (const id of path) resolved.set(id, collectionId);
    if (!collectionId) continue;
    await client.execute(
      "INSERT INTO page_collection_memberships (page_id, collection_id) VALUES (?, ?)",
      [row.id, collectionId]
    );
  }
}
