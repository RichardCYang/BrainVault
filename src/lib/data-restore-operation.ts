import { z } from "zod";
import type { DbClient } from "./db.js";
import { ApiError } from "./http.js";

const operationIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const sharingSchema = z.object({ mode: z.enum(["backup", "legacy-preserved"]), count: z.number().int().nonnegative() });
const summarySchema = z.object({
  counts: z.record(z.string(), z.number().int().nonnegative()),
  sharing: sharingSchema,
  collectionSharing: sharingSchema
});
export type DataRestoreSummary = z.infer<typeof summarySchema>;
export type DataRestoreAdmission = Readonly<{
  userId: string;
  operationId: string;
  sourceKey: string;
  fingerprint: string | null;
}>;
export type DataRestoreReceipt = {
  source_key: string;
  archive_sha256: string;
  result_json: unknown;
};

export function requireRestoreOperationId(value: unknown) {
  const parsed = operationIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, "RESTORE_OPERATION_ID_REQUIRED", "Supply X-Restore-Operation-Id (1-64 letters, digits, underscores or hyphens). Reuse it when retrying this restore.");
  }
  return parsed.data;
}

export async function readDataRestoreReceipt(client: DbClient, userId: string, operationId: string) {
  // A locking read sees a receipt committed while this transaction waited for
  // the owner lock, even under REPEATABLE READ. The owner is always locked first.
  return client.queryOne<DataRestoreReceipt>(
    `SELECT source_key, archive_sha256, CAST(result_json AS CHAR CHARACTER SET utf8mb4) AS result_json FROM data_restore_receipts
     WHERE user_id = ? AND operation_id = ? FOR UPDATE`,
    [userId, operationId]
  );
}

export function replayDataRestoreReceipt(receipt: DataRestoreReceipt, sourceKey: string, archiveSha256: string) {
  if (receipt.source_key !== sourceKey || receipt.archive_sha256 !== archiveSha256) {
    throw new ApiError(409, "RESTORE_OPERATION_ID_REUSED", "This restore operation id was already used for a different backup.");
  }
  return summarySchema.parse(typeof receipt.result_json === "string" ? JSON.parse(receipt.result_json) : receipt.result_json);
}
