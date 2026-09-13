import type { DbClient } from "./db.js";
import { ApiError } from "./http.js";
import { maxCollaborationDocumentBytes } from "./collaboration-protocol.js";
import { assessCollaborationHistoryReplay } from "./collaboration-update-policy.js";
import {
  CollaborationHistoryTimeoutError,
  CollaborationValidationCapacityError,
  CollaborationValidationPool,
  CollaborationValidationResourceLimitError
} from "./collaboration-update-worker-pool.js";
import { InvalidYjsUpdateError } from "./yjs-validation.js";
import {
  grantYjsPageRecovery,
  storeRecoveryCandidate,
  yjsRecoveryLineageKey
} from "./recovery-candidates.js";

const collaborationRecoveryPool = new CollaborationValidationPool(1);

type CollaborationHistoryStatsRow = {
  history_entries: number | bigint | string | null;
  history_bytes: number | bigint | string | null;
};

type CollaborationUpdateRow = {
  id: number | bigint | string;
  update_data: Buffer;
};

function toSafeHistoryMetric(value: number | bigint | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Copies the current durable Yjs document into the owner's existing recovery
 * vault before a security-sensitive collaboration lineage is retired.
 *
 * A failed quarantine must never keep a revoked collaborator authorized. The
 * caller can keep the old Yjs rows/state in place when this returns false; with
 * all grants removed those rows are inert, while the owner can free recovery
 * capacity and retry a later lifecycle transition without data loss.
 */
export async function quarantineCollaborationHistoryForOwner(
  client: DbClient,
  input: {
    pageId: string;
    ownerId: string;
    documentEpoch: string;
    reason: "SHARE_STARTED" | "SHARE_REMOVED";
  }
): Promise<boolean> {
  const stats = await client.queryOne<CollaborationHistoryStatsRow>(
    `SELECT COUNT(*) AS history_entries,
            COALESCE(SUM(OCTET_LENGTH(update_data)), 0) AS history_bytes
     FROM page_yjs_updates
     WHERE page_id = ?`,
    [input.pageId]
  );
  const historyEntries = toSafeHistoryMetric(stats?.history_entries);
  const historyBytes = toSafeHistoryMetric(stats?.history_bytes);
  if (historyEntries === null || historyBytes === null) return false;
  if (historyEntries === 0) return true;

  const replayAssessment = assessCollaborationHistoryReplay({ historyEntries, historyBytes });
  if (!replayAssessment.accepted) return false;

  const rows = await client.query<CollaborationUpdateRow>(
    `SELECT id, update_data
     FROM page_yjs_updates
     WHERE page_id = ?
     ORDER BY id ASC
     FOR UPDATE`,
    [input.pageId]
  );
  const actualHistoryBytes = rows.reduce(
    (total, row) => total + Buffer.from(row.update_data).length,
    0
  );
  if (rows.length !== historyEntries || actualHistoryBytes !== historyBytes) return false;

  let stateUpdate: Buffer;
  try {
    stateUpdate = (await collaborationRecoveryPool.replayHistory({
      principalKey: input.ownerId,
      updates: rows.map((row) => Buffer.from(row.update_data)),
      maxStateBytes: maxCollaborationDocumentBytes
    })).stateUpdate;
  } catch (error) {
    if (
      error instanceof InvalidYjsUpdateError
      || error instanceof CollaborationValidationCapacityError
      || error instanceof CollaborationValidationResourceLimitError
      || error instanceof CollaborationHistoryTimeoutError
    ) {
      return false;
    }
    // Worker startup/termination faults are also independent of authorization.
    // Retain the durable history rather than rolling back the revocation.
    if (error instanceof Error) return false;
    throw error;
  }

  await grantYjsPageRecovery(client, {
    pageId: input.pageId,
    principalId: input.ownerId,
    ownerId: input.ownerId,
    documentEpoch: input.documentEpoch,
    reason: input.reason
  });

  const latestUpdateId = String(rows.at(-1)?.id ?? "0");
  try {
    await storeRecoveryCandidate({
      pageId: input.pageId,
      principalId: input.ownerId,
      lineageKey: yjsRecoveryLineageKey(input.documentEpoch),
      kind: "YJS_UPDATE",
      sourceId: `server-collaboration-${latestUpdateId}`,
      generation: input.documentEpoch,
      payload: stateUpdate
    }, client);
  } catch (error) {
    if (
      error instanceof ApiError
      && (error.code === "RECOVERY_VAULT_QUOTA_EXCEEDED" || error.code === "RECOVERY_CANDIDATE_TOO_LARGE")
    ) {
      return false;
    }
    throw error;
  }
  return true;
}
