import { createHash } from "node:crypto";
import { db, transaction, type DbClient } from "./db.js";
import { ApiError, notFound } from "./http.js";
import { createId } from "./id.js";

export const maxRecoveryCandidateBytes = 20 * 1024 * 1024;
// Bound the durable vault per authenticated principal. If the quota is full,
// uploads fail closed and the browser intentionally retains its local copy.
export const maxRecoveryVaultBytesPerPrincipal = 256 * 1024 * 1024;
export const maxRecoveryVaultCandidatesPerPrincipal = 256;
const recoveryGrantBatchSize = 200;

export type RecoveryGrantReason =
  | "SHARE_STARTED"
  | "SHARE_REMOVED"
  | "PAGE_DELETED"
  | "WORKSPACE_RESTORED";
export type RecoveryCandidateKind = "DIRECT_DRAFT" | "YJS_UPDATE" | "YJS_LEGACY_UPDATE";

export function directRecoveryLineageKey() {
  return "direct";
}

export function yjsRecoveryLineageKey(documentEpoch: string) {
  return `yjs:${documentEpoch}`;
}

export function legacyYjsRecoveryLineageKey() {
  return "yjs:legacy";
}

async function upsertRecoveryGrant(
  client: DbClient,
  input: {
    pageId: string;
    principalId: string;
    ownerId: string;
    lineageKey: string;
    reason: RecoveryGrantReason;
  }
) {
  await client.execute(
    `INSERT INTO page_recovery_grants
       (page_id, principal_id, owner_id, lineage_key, reason, purged_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE
       owner_id = VALUES(owner_id),
       reason = VALUES(reason),
       purged_at = NULL,
       updated_at = CURRENT_TIMESTAMP(6)`,
    [input.pageId, input.principalId, input.ownerId, input.lineageKey, input.reason]
  );
}

export async function grantDirectPageRecovery(
  client: DbClient,
  input: { pageId: string; principalId: string; ownerId: string; reason: RecoveryGrantReason }
) {
  await upsertRecoveryGrant(client, { ...input, lineageKey: directRecoveryLineageKey() });
}

export async function grantYjsPageRecovery(
  client: DbClient,
  input: {
    pageId: string;
    principalId: string;
    ownerId: string;
    documentEpoch: string;
    reason: RecoveryGrantReason;
  }
) {
  await upsertRecoveryGrant(client, {
    pageId: input.pageId,
    principalId: input.principalId,
    ownerId: input.ownerId,
    lineageKey: yjsRecoveryLineageKey(input.documentEpoch),
    reason: input.reason
  });
}

export async function grantLegacyYjsPageRecovery(
  client: DbClient,
  input: { pageId: string; principalId: string; ownerId: string; reason: RecoveryGrantReason }
) {
  await upsertRecoveryGrant(client, {
    ...input,
    lineageKey: legacyYjsRecoveryLineageKey()
  });
}

export async function preserveRecoveryGrantsForPages(
  client: DbClient,
  ownerId: string,
  pageIds: readonly string[],
  reason: RecoveryGrantReason
) {
  const uniquePageIds = [...new Set(pageIds.filter(Boolean))];
  if (!uniquePageIds.length) return;

  // The owner can have direct-edit recovery from another device even if the
  // current browser is clean, so every destructive transition preserves that
  // lineage before changing/removing the page.
  for (const pageId of uniquePageIds) {
    await grantDirectPageRecovery(client, { pageId, principalId: ownerId, ownerId, reason });
    await grantLegacyYjsPageRecovery(client, { pageId, principalId: ownerId, ownerId, reason });
  }

  for (let offset = 0; offset < uniquePageIds.length; offset += recoveryGrantBatchSize) {
    const group = uniquePageIds.slice(offset, offset + recoveryGrantBatchSize);
    const placeholders = group.map(() => "?").join(", ");
    const states = await client.query<{ page_id: string; document_epoch: string }>(
      `SELECT page_id, document_epoch
       FROM page_collaboration_state
       WHERE page_id IN (${placeholders})`,
      group
    );
    const epochByPage = new Map(states.map((row) => [row.page_id, row.document_epoch]));
    const shares = await client.query<{ page_id: string; user_id: string }>(
      `SELECT effective.page_id, effective.user_id
       FROM (
         SELECT ps.page_id, ps.user_id
         FROM page_shares ps
         WHERE ps.page_id IN (${placeholders}) AND ps.permission = 'EDIT'
         UNION
         SELECT pcm.page_id, cs.user_id
         FROM page_collection_memberships pcm
         INNER JOIN collection_shares cs ON cs.collection_id = pcm.collection_id
         WHERE pcm.page_id IN (${placeholders})
       ) effective`,
      [...group, ...group]
    );

    for (const state of states) {
      await grantYjsPageRecovery(client, {
        pageId: state.page_id,
        principalId: ownerId,
        ownerId,
        documentEpoch: state.document_epoch,
        reason
      });
    }
    for (const share of shares) {
      await grantDirectPageRecovery(client, {
        pageId: share.page_id,
        principalId: share.user_id,
        ownerId,
        reason
      });
      await grantLegacyYjsPageRecovery(client, {
        pageId: share.page_id,
        principalId: share.user_id,
        ownerId,
        reason
      });
      const documentEpoch = epochByPage.get(share.page_id);
      if (documentEpoch) {
        await grantYjsPageRecovery(client, {
          pageId: share.page_id,
          principalId: share.user_id,
          ownerId,
          documentEpoch,
          reason
        });
      }
    }
  }
}

export async function storeRecoveryCandidate(input: {
  pageId: string;
  principalId: string;
  lineageKey: string;
  kind: RecoveryCandidateKind;
  sourceId: string;
  generation: string;
  payload: Buffer;
}, client?: DbClient) {
  if (!input.payload.length || input.payload.length > maxRecoveryCandidateBytes) {
    throw new ApiError(413, "RECOVERY_CANDIDATE_TOO_LARGE", "The recovery candidate exceeds the supported size");
  }
  const payloadSha256 = createHash("sha256").update(input.payload).digest("hex");

  const persist = async (client: DbClient) => {
    // Serialize quota accounting for this principal without coupling recovery
    // records to page foreign keys that disappear during hard deletion.
    const principal = await client.queryOne<{ id: string }>(
      "SELECT id FROM users WHERE id = ? FOR UPDATE",
      [input.principalId]
    );
    if (!principal) throw new ApiError(401, "UNAUTHENTICATED", "The recovery account no longer exists");

    const grant = await client.queryOne<{ owner_id: string }>(
      `SELECT owner_id
       FROM page_recovery_grants
       WHERE page_id = ? AND principal_id = ? AND lineage_key = ? AND purged_at IS NULL
       FOR UPDATE`,
      [input.pageId, input.principalId, input.lineageKey]
    );
    if (!grant) {
      throw new ApiError(
        404,
        "RECOVERY_GRANT_NOT_FOUND",
        "This recovery lineage is not registered for durable server recovery"
      );
    }

    const existing = await client.queryOne<{ id: string }>(
      `SELECT id
       FROM page_recovery_candidates
       WHERE page_id = ? AND principal_id = ? AND lineage_key = ? AND kind = ? AND payload_sha256 = ?`,
      [input.pageId, input.principalId, input.lineageKey, input.kind, payloadSha256]
    );
    if (existing) return { id: existing.id, created: false, payloadSha256 };

    const usage = await client.queryOne<{ candidate_count: number | bigint; payload_bytes: number | bigint }>(
      `SELECT COUNT(*) AS candidate_count, COALESCE(SUM(OCTET_LENGTH(payload)), 0) AS payload_bytes
       FROM page_recovery_candidates
       WHERE principal_id = ?`,
      [input.principalId]
    );
    const candidateCount = Number(usage?.candidate_count ?? 0);
    const payloadBytes = Number(usage?.payload_bytes ?? 0);
    if (
      !Number.isSafeInteger(candidateCount)
      || !Number.isSafeInteger(payloadBytes)
      || candidateCount < 0
      || payloadBytes < 0
    ) {
      throw new ApiError(500, "INVALID_RECOVERY_VAULT_STATE", "Stored recovery vault usage is invalid");
    }
    if (
      candidateCount >= maxRecoveryVaultCandidatesPerPrincipal
      || payloadBytes + input.payload.length > maxRecoveryVaultBytesPerPrincipal
    ) {
      throw new ApiError(409, "RECOVERY_VAULT_QUOTA_EXCEEDED",
        "The server recovery vault is full. The browser recovery copy was not removed.", {
          candidateCount,
          payloadBytes,
          maxCandidates: maxRecoveryVaultCandidatesPerPrincipal,
          maxBytes: maxRecoveryVaultBytesPerPrincipal
        });
    }

    const id = createId("rcv");
    await client.execute(
      `INSERT INTO page_recovery_candidates
         (id, page_id, principal_id, owner_id, lineage_key, kind, source_id, generation, payload, payload_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.pageId,
        input.principalId,
        grant.owner_id,
        input.lineageKey,
        input.kind,
        input.sourceId,
        input.generation,
        input.payload,
        payloadSha256
      ]
    );
    return { id, created: true, payloadSha256 };
  };

  return client ? persist(client) : transaction(persist);
}

export async function listRecoveryCandidates(userId: string) {
  return db.query<{
    id: string;
    page_id: string;
    principal_id: string;
    owner_id: string;
    lineage_key: string;
    kind: RecoveryCandidateKind;
    source_id: string;
    generation: string;
    payload_sha256: string;
    payload_bytes: number | bigint;
    created_at: string;
  }>(
    `SELECT id, page_id, principal_id, owner_id, lineage_key, kind, source_id, generation,
            payload_sha256, OCTET_LENGTH(payload) AS payload_bytes, created_at
     FROM page_recovery_candidates
     WHERE principal_id = ? OR owner_id = ?
     ORDER BY created_at DESC, id DESC`,
    [userId, userId]
  );
}

export async function getRecoveryCandidate(candidateId: string, userId: string) {
  const row = await db.queryOne<{
    id: string;
    page_id: string;
    principal_id: string;
    owner_id: string;
    lineage_key: string;
    kind: RecoveryCandidateKind;
    source_id: string;
    generation: string;
    payload_sha256: string;
    payload: Buffer;
    created_at: string;
  }>(
    `SELECT id, page_id, principal_id, owner_id, lineage_key, kind, source_id, generation,
            payload_sha256, payload, created_at
     FROM page_recovery_candidates
     WHERE id = ? AND (principal_id = ? OR owner_id = ?)`,
    [candidateId, userId, userId]
  );
  if (!row) throw notFound("Recovery candidate");

  const expectedSha256 = row.payload_sha256.trim().toLowerCase();
  const actualSha256 = createHash("sha256").update(row.payload).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || actualSha256 !== expectedSha256) {
    throw new ApiError(
      500,
      "RECOVERY_CANDIDATE_INTEGRITY_FAILED",
      "Stored recovery candidate failed integrity verification"
    );
  }

  return row;
}

export async function deleteRecoveryCandidate(
  candidateId: string,
  principalId: string,
  client: DbClient = db
) {
  const result = await client.execute<{ affectedRows: number }>(
    `DELETE FROM page_recovery_candidates
     WHERE id = ? AND principal_id = ?`,
    [candidateId, principalId]
  );
  if (Number(result.affectedRows) === 0) throw notFound("Recovery candidate");
}
