import type { DbClient } from "./db.js";

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
  await client.execute(
    `DELETE pcm FROM page_collection_memberships pcm
     INNER JOIN pages p ON p.id = pcm.page_id
     WHERE p.owner_id = ?`,
    [ownerId]
  );

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
  const resolved = new Map<string, string | null>();
  const resolveCollection = (pageId: string, trail = new Set<string>()): string | null => {
    if (resolved.has(pageId)) return resolved.get(pageId) ?? null;
    const row = rowById.get(pageId);
    if (!row) return null;
    if (row.is_collection) {
      resolved.set(pageId, pageId);
      return pageId;
    }
    if (!row.parent_page_id || trail.has(pageId)) {
      resolved.set(pageId, null);
      return null;
    }
    trail.add(pageId);
    const collectionId = resolveCollection(row.parent_page_id, trail);
    trail.delete(pageId);
    resolved.set(pageId, collectionId);
    return collectionId;
  };

  for (const row of rows) {
    const collectionId = resolveCollection(row.id);
    if (!collectionId) continue;
    await client.execute(
      "INSERT INTO page_collection_memberships (page_id, collection_id) VALUES (?, ?)",
      [row.id, collectionId]
    );
  }
}
