import { getHeapStatistics } from "node:v8";
import type { env as environment } from "../config/env.js";
import type { DbClient } from "./db.js";
import { computeBackupDataBudgetBytes } from "./data-transfer-limits.js";
import { ApiError } from "./http.js";

export function workspaceDataBudgetBytes(env: typeof environment) {
  return computeBackupDataBudgetBytes({
    configuredBytes: env.DATA_TRANSFER_MAX_DATA_SIZE_MB * 1024 * 1024,
    heapLimitBytes: getHeapStatistics().heap_size_limit,
    // At least one slot per transfer type, plus the owner safety snapshot slot.
    concurrentOperations: Math.max(2, env.DATA_EXPORT_MAX_CONCURRENT) + Math.max(2, env.DATA_IMPORT_MAX_CONCURRENT) + 1,
    minimumBytes: env.DATA_TRANSFER_MAX_MANIFEST_SIZE_MB * 1024 * 1024
  });
}

// Mirrors migration 091. Charge serialized content and row overhead. History
// has a separate allowance because the exporter can trim it to fit.
const measureUsage = `INSERT INTO page_storage_usage (page_id, owner_id, content_bytes, history_bytes)
SELECT p.id, p.owner_id,
       768 + OCTET_LENGTH(p.title) + COALESCE(OCTET_LENGTH(p.icon), 0) + COALESCE(OCTET_LENGTH(p.cover_url), 0)
       + COALESCE((SELECT SUM(384 + OCTET_LENGTH(JSON_QUOTE(b.markdown)) + COALESCE(OCTET_LENGTH(JSON_QUOTE(b.metadata)), 0)) FROM blocks b WHERE b.page_id = p.id), 0)
       + COALESCE((SELECT SUM(384 + OCTET_LENGTH(JSON_QUOTE(c.body))) FROM page_comments c WHERE c.page_id = p.id), 0)
       + (SELECT COUNT(*) * 256 FROM page_tags pt WHERE pt.page_id = p.id) AS content_bytes,
       COALESCE((SELECT SUM(256 + OCTET_LENGTH(v.actors) + OCTET_LENGTH(v.change_summary) + OCTET_LENGTH(v.changes)) FROM page_versions v WHERE v.page_id = p.id), 0) AS history_bytes
FROM pages p`;
const updateUsage = " ON DUPLICATE KEY UPDATE content_bytes = VALUES(content_bytes), history_bytes = VALUES(history_bytes)";

const usageWithPendingChanges = "page_storage_usage LEFT JOIN page_collaboration_state USING (page_id)";
const pendingContent = "COALESCE(SUM(GREATEST(0, pending_content_growth)), 0)";

export async function readWorkspaceUsage(client: DbClient, ownerId: string) {
  const row = await client.queryOne<{ content: number; history: number }>(
    `SELECT COALESCE(SUM(content_bytes), 0) + ${pendingContent} AS content, COALESCE(SUM(history_bytes), 0) AS history
     FROM ${usageWithPendingChanges} WHERE owner_id = ? FOR UPDATE`, [ownerId]
  );
  if (!row) throw new Error("Workspace storage usage unavailable");
  return { content: Number(row.content), history: Number(row.history) };
}

export async function rebuildWorkspaceUsage(client: DbClient, ownerId: string) {
  await client.execute(measureUsage + " WHERE p.owner_id = ?" + updateUsage, [ownerId]);
}

export async function reserveCollaborationStorage(client: DbClient, pageId: string, ownerId: string, delta: number) {
  await client.queryOne("SELECT id FROM users WHERE id = ? FOR UPDATE", [ownerId]);
  if (delta) {
    await client.execute("UPDATE page_collaboration_state SET pending_content_growth = pending_content_growth + ? WHERE page_id = ?", [delta, pageId]);
  }
  if (delta < 0) return;
  const usage = await readWorkspaceUsage(client, ownerId);
  const { env } = await import("../config/env.js");
  const limit = workspaceDataBudgetBytes(env);
  if ((delta > 0 && usage.content > limit) || usage.history >= limit) {
    throw new ApiError(413, "WORKSPACE_STORAGE_LIMIT", "The workspace content or version history exceeds its storage budget");
  }
}

export async function checkPageStorageGrowth(client: DbClient, pageId: string, alreadyAdmitted = false) {
  // Serialize independent editors before changing the per-page contributions.
  const owner = await client.queryOne<{ id: string }>(
    "SELECT u.id FROM users u JOIN pages p ON p.owner_id = u.id WHERE p.id = ? FOR UPDATE", [pageId]
  );
  if (!owner) throw new ApiError(404, "PAGE_NOT_FOUND", "Page not found");
  const previous = await client.queryOne<{ content_bytes: number; history_bytes: number }>(
    "SELECT content_bytes, history_bytes FROM page_storage_usage WHERE page_id = ? FOR UPDATE", [pageId]
  );
  await client.execute(measureUsage + " WHERE p.id = ?" + updateUsage, [pageId]);
  // Acknowledged Yjs updates must reach SQL even when the final history row
  // crosses the limit. The next live edit sees the reconciled usage.
  if (alreadyAdmitted) return;
  const usage = await client.queryOne<{
    content: number; history: number; page_content: number; page_history: number;
  }>(
    `SELECT SUM(content_bytes) + ${pendingContent} AS content, SUM(history_bytes) AS history,
            MAX(IF(page_id = ?, content_bytes, 0)) AS page_content,
            MAX(IF(page_id = ?, history_bytes, 0)) AS page_history
       FROM ${usageWithPendingChanges} WHERE owner_id = ? FOR UPDATE`, [pageId, pageId, owner.id]
  );
  if (!usage) throw new Error("Workspace storage usage unavailable");
  const { env } = await import("../config/env.js");
  const limit = workspaceDataBudgetBytes(env);
  if ((Number(usage.content) > limit && Number(usage.page_content) > Number(previous?.content_bytes ?? 0))
    || (Number(usage.history) > limit && Number(usage.page_history) > Number(previous?.history_bytes ?? 0))) {
    throw new ApiError(413, "WORKSPACE_STORAGE_LIMIT", "The workspace content or version history exceeds its storage budget");
  }
}
