import { db, transaction, type DbClient } from "./db.js";
import { assertPageCanEdit, getPageAccess } from "./page-access.js";
import { assertCollaborationDocumentEpoch, getCollaborationState } from "./collaboration-lineage.js";
import { ApiError } from "./http.js";
import { createId } from "./id.js";

// The validation queue is bounded to 64 tasks and each worker task is bounded to
// five seconds. Ten minutes leaves substantial safety margin for queueing and DB
// lock contention while ensuring a crashed process cannot block deletion forever.
const collaborationWriteLeaseTtlMinutes = 10;
const collaborationWriteLeaseBatchSize = 250;

export async function reserveCollaborationWriteLease(
  pageId: string,
  userId: string,
  documentEpoch: string
) {
  const leaseId = createId("cwl");
  await transaction(async (client) => {
    // Destructive transitions lock the same page row before inspecting leases.
    // Whichever transaction acquires this row first establishes the ordering.
    const access = await getPageAccess(pageId, userId, client, { lockPage: true });
    assertPageCanEdit(access, "This collaboration session is read-only");
    if (access.page.is_collection || access.page.is_archived || access.shareCount < 1) {
      throw new ApiError(403, "COLLABORATION_DISABLED", "Collaboration is not enabled for this page");
    }
    const state = await getCollaborationState(pageId, client, { lock: true });
    assertCollaborationDocumentEpoch(state, documentEpoch);

    await client.execute(
      `DELETE FROM page_collaboration_write_leases
       WHERE page_id = ? AND expires_at <= CURRENT_TIMESTAMP(6)`,
      [pageId]
    );
    await client.execute(
      `INSERT INTO page_collaboration_write_leases
         (lease_id, page_id, user_id, document_epoch, expires_at)
       VALUES (
         ?, ?, ?, ?,
         DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ${collaborationWriteLeaseTtlMinutes} MINUTE)
       )`,
      [leaseId, pageId, userId, documentEpoch]
    );
  });
  return leaseId;
}

export async function releaseCollaborationWriteLease(leaseId: string) {
  await db.execute("DELETE FROM page_collaboration_write_leases WHERE lease_id = ?", [leaseId]);
}

export async function assertNoActiveCollaborationWriteLeases(
  client: DbClient,
  pageIds: readonly string[]
) {
  const uniquePageIds = [...new Set(pageIds.filter(Boolean))];
  if (!uniquePageIds.length) return;

  for (let offset = 0; offset < uniquePageIds.length; offset += collaborationWriteLeaseBatchSize) {
    const group = uniquePageIds.slice(offset, offset + collaborationWriteLeaseBatchSize);
    const placeholders = group.map(() => "?").join(", ");
    await client.execute(
      `DELETE FROM page_collaboration_write_leases
       WHERE page_id IN (${placeholders})
         AND expires_at <= CURRENT_TIMESTAMP(6)`,
      group
    );
    const active = await client.queryOne<{ page_id: string }>(
      `SELECT page_id
       FROM page_collaboration_write_leases
       WHERE page_id IN (${placeholders})
         AND expires_at > CURRENT_TIMESTAMP(6)
       LIMIT 1`,
      group
    );
    if (active) {
      throw new ApiError(
        409,
        "COLLABORATION_WRITES_PENDING",
        "A collaboration edit is currently being saved. Retry the operation after synchronization completes.",
        { pageId: active.page_id }
      );
    }
  }
}
