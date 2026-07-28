import { db, type DbClient } from "./db.js";
import { ApiError } from "./http.js";
import { createId } from "./id.js";

export type CollaborationStateRow = {
  page_id: string;
  document_epoch: string;
  materialized_update_id: number;
  materialization_version: number;
};

export function createCollaborationDocumentEpoch() {
  return createId("epoch");
}

function validateCollaborationState(row: CollaborationStateRow | undefined) {
  if (!row) return null;
  if (
    typeof row.document_epoch !== "string"
    || !row.document_epoch
    || row.document_epoch.length > 64
  ) {
    throw new ApiError(
      500,
      "INVALID_COLLABORATION_STATE",
      "The collaboration document lineage is invalid"
    );
  }
  const materializedUpdateId = Number(row.materialized_update_id ?? 0);
  const materializationVersion = Number(row.materialization_version ?? 0);
  if (!Number.isSafeInteger(materializedUpdateId) || materializedUpdateId < 0) {
    throw new ApiError(
      500,
      "INVALID_COLLABORATION_STATE",
      "Collaboration update id exceeded the supported range"
    );
  }
  if (!Number.isSafeInteger(materializationVersion) || materializationVersion < 0) {
    throw new ApiError(
      500,
      "INVALID_COLLABORATION_STATE",
      "Collaboration materialization provenance is invalid"
    );
  }
  return {
    ...row,
    materialized_update_id: materializedUpdateId,
    materialization_version: materializationVersion
  };
}

export async function getCollaborationState(
  pageId: string,
  client: DbClient = db,
  { lock = false }: { lock?: boolean } = {}
) {
  const row = await client.queryOne<CollaborationStateRow>(
    `SELECT page_id, document_epoch, materialized_update_id, materialization_version
     FROM page_collaboration_state
     WHERE page_id = ?${lock ? " FOR UPDATE" : ""}`,
    [pageId]
  );
  return validateCollaborationState(row);
}

export async function ensureCollaborationState(pageId: string, client: DbClient) {
  const existing = await getCollaborationState(pageId, client, { lock: true });
  if (existing) return existing;

  const documentEpoch = createCollaborationDocumentEpoch();
  await client.execute(
    `INSERT IGNORE INTO page_collaboration_state
       (page_id, document_epoch, materialized_update_id, materialization_version)
     VALUES (?, ?, 0, 0)`,
    [pageId, documentEpoch]
  );
  const created = await getCollaborationState(pageId, client, { lock: true });
  if (!created) {
    throw new ApiError(
      500,
      "COLLABORATION_STATE_CREATE_FAILED",
      "The collaboration document lineage could not be initialized"
    );
  }
  return created;
}

export function assertCollaborationDocumentEpoch(
  state: CollaborationStateRow | null,
  documentEpoch: string
): asserts state is CollaborationStateRow {
  if (!state || state.document_epoch !== documentEpoch) {
    throw new ApiError(
      409,
      "COLLABORATION_LINEAGE_CHANGED",
      "The collaboration document was replaced. The browser recovery copy was preserved."
    );
  }
}
