import type { DbClient } from "./db.js";
import { ApiError } from "./http.js";

// Call in the same transaction as creating rows or restoring a backup.
// The unique key serializes competing workspaces, even for an ID
// whose live row is absent. Keep batch and lock order deterministic.
export async function reserveBackupResourceIds(
  client: DbClient, ownerId: string, kind: "page" | "block" | "comment", ids: readonly string[]
) {
  const ordered = [...new Set(ids)].sort();
  for (let offset = 0; offset < ordered.length; offset += 500) {
    const batch = ordered.slice(offset, offset + 500);
    await client.execute(
      `INSERT INTO backup_resource_owners (kind, resource_id, owner_id)
       VALUES ${batch.map(() => "(?, ?, ?)").join(", ")}
       ON DUPLICATE KEY UPDATE resource_id = resource_id`,
      batch.flatMap((id) => [kind, id, ownerId])
    );
    const conflict = await client.queryOne(
      `SELECT resource_id FROM backup_resource_owners
       WHERE kind = ? AND resource_id IN (${batch.map(() => "?").join(", ")}) AND owner_id <> ?
       LIMIT 1 FOR UPDATE`, [kind, ...batch, ownerId]
    );
    if (conflict) throw new ApiError(409, "BACKUP_ID_CONFLICT", "A resource identifier belongs to another workspace");
  }
}
