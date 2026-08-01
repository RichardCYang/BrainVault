import net from "node:net";
import type { Request } from "express";
import { db, type DbClient } from "./db.js";
import { createId } from "./id.js";

export const defaultLoginHistoryMonths = 3;
export const maxLoginHistoryMonths = 12;
export const loginHistoryResultLimit = 500;
const loginHistoryRetentionMonths = maxLoginHistoryMonths + 1;

export type LoginAttemptOutcome = "SUCCESS" | "FAILURE";

type LoginAttemptRow = {
  id: string;
  ip_address: string;
  outcome: LoginAttemptOutcome;
  attempted_at: string | Date;
};

export function getClientIpAddress(req: Request) {
  const rawAddress = String(req.ip || req.socket.remoteAddress || "").trim();
  const withoutZone = rawAddress.split("%")[0];
  const mappedIpv4 = withoutZone.startsWith("::ffff:") ? withoutZone.slice(7) : withoutZone;
  const normalized = net.isIPv4(mappedIpv4) ? mappedIpv4 : withoutZone;
  return net.isIP(normalized) ? normalized : "unknown";
}

export async function recordLoginAttempt(
  userId: string,
  ipAddress: string,
  outcome: LoginAttemptOutcome,
  client: DbClient = db
) {
  try {
    await client.execute(
      `DELETE FROM user_login_attempts
       WHERE user_id = ? AND attempted_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ${loginHistoryRetentionMonths} MONTH)`,
      [userId]
    );
    await client.execute(
      `INSERT INTO user_login_attempts (id, user_id, ip_address, outcome)
       VALUES (?, ?, ?, ?)`,
      [createId("lga"), userId, ipAddress, outcome]
    );
  } catch (error) {
    // Authentication must remain available even when the history table is temporarily unavailable.
    console.error("Failed to record a login attempt", {
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: typeof error === "object" && error !== null && "code" in error ? String(error.code) : null
    });
  }
}

export async function listLoginAttempts(userId: string, months: number, client: DbClient = db) {
  const normalizedMonths = Number.isFinite(months)
    ? Math.min(maxLoginHistoryMonths, Math.max(1, Math.trunc(months)))
    : defaultLoginHistoryMonths;
  const rows = await client.query<LoginAttemptRow>(
    `SELECT id, ip_address, outcome, attempted_at
     FROM user_login_attempts
     WHERE user_id = ?
       AND attempted_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ${normalizedMonths} MONTH)
     ORDER BY attempted_at DESC, id DESC
     LIMIT ${loginHistoryResultLimit + 1}`,
    [userId]
  );
  const truncated = rows.length > loginHistoryResultLimit;
  return {
    months: normalizedMonths,
    truncated,
    attempts: rows.slice(0, loginHistoryResultLimit).map((row) => ({
      id: row.id,
      ipAddress: row.ip_address,
      outcome: row.outcome,
      attemptedAt: row.attempted_at
    }))
  };
}
