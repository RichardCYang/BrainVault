import net from "node:net";
import type { Request } from "express";
import { db, type DbClient, type DbValue } from "./db.js";
import {
  getCountryDatasetUpdatedAt,
  isPublicCountryLookupIp,
  lookupCountryCodes,
  normalizeCountryCode,
  normalizeCountryLookupIp
} from "./geo-country.js";
import { createId } from "./id.js";

export const defaultLoginHistoryMonths = 3;
export const maxLoginHistoryMonths = 12;
export const loginHistoryResultLimit = 500;
const loginHistoryRetentionMonths = maxLoginHistoryMonths + 1;

export type LoginAttemptOutcome = "SUCCESS" | "FAILURE" | "LOCKED";

type LoginAttemptRow = {
  id: string;
  ip_address: string;
  country_code: string | null;
  country_dataset_updated_at: string | Date | null;
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
       SELECT ?, id, ?, ? FROM users WHERE id = ?`,
      [createId("lga"), ipAddress, outcome, userId]
    );
  } catch (error) {
    // Authentication must remain available even when the history table is temporarily unavailable.
    console.error("Failed to record a login attempt", {
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: typeof error === "object" && error !== null && "code" in error ? String(error.code) : null
    });
  }
}

function timestampMs(value: string | Date | null) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  const time = parsed.getTime();
  return Number.isNaN(time) ? null : time;
}

function needsCountryRefresh(row: LoginAttemptRow, datasetUpdatedAt: Date | null) {
  if (!isPublicCountryLookupIp(row.ip_address)) return false;
  const rowDatasetUpdatedAt = timestampMs(row.country_dataset_updated_at);
  if (rowDatasetUpdatedAt === null) return true;
  return datasetUpdatedAt ? rowDatasetUpdatedAt < datasetUpdatedAt.getTime() : false;
}

async function persistCountryRefreshes(
  userId: string,
  countryCodes: ReadonlyMap<string, string | null>,
  datasetUpdatedAt: Date | null,
  client: DbClient
) {
  if (countryCodes.size === 0) return;

  const entries = [...countryCodes.entries()];
  const caseSql = entries.map(() => "WHEN ? THEN ?").join(" ");
  const placeholders = entries.map(() => "?").join(", ");
  const params: DbValue[] = [];
  for (const [ipAddress, countryCode] of entries) params.push(ipAddress, countryCode);
  params.push(datasetUpdatedAt, userId, ...entries.map(([ipAddress]) => ipAddress));

  const stalePredicate = datasetUpdatedAt
    ? "(country_dataset_updated_at IS NULL OR country_dataset_updated_at < ?)"
    : "country_dataset_updated_at IS NULL";
  if (datasetUpdatedAt) params.push(datasetUpdatedAt);

  try {
    await client.execute(
      `UPDATE user_login_attempts
       SET country_code = CASE ip_address ${caseSql} ELSE country_code END,
           country_dataset_updated_at = COALESCE(?, country_dataset_updated_at)
       WHERE user_id = ?
         AND ip_address IN (${placeholders})
         AND ${stalePredicate}`,
      params
    );
  } catch (error) {
    // The response can still use the freshly resolved in-memory values even if this
    // best-effort cache write fails.
    console.error("Failed to persist login-history country metadata", {
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
    `SELECT id, ip_address, country_code, country_dataset_updated_at, outcome, attempted_at
     FROM user_login_attempts
     WHERE user_id = ?
       AND attempted_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ${normalizedMonths} MONTH)
     ORDER BY attempted_at DESC, id DESC
     LIMIT ${loginHistoryResultLimit + 1}`,
    [userId]
  );
  const truncated = rows.length > loginHistoryResultLimit;
  const visibleRows = rows.slice(0, loginHistoryResultLimit);

  const publicRows = visibleRows.filter((row) => isPublicCountryLookupIp(row.ip_address));
  const datasetUpdatedAt = publicRows.length > 0 ? await getCountryDatasetUpdatedAt() : null;
  const ipsToRefresh = publicRows
    .filter((row) => needsCountryRefresh(row, datasetUpdatedAt))
    .map((row) => normalizeCountryLookupIp(row.ip_address))
    .filter((ipAddress): ipAddress is string => Boolean(ipAddress));
  const refreshedCountryCodes = await lookupCountryCodes(ipsToRefresh);

  if (refreshedCountryCodes.size > 0) {
    await persistCountryRefreshes(userId, refreshedCountryCodes, datasetUpdatedAt, client);
  }

  return {
    months: normalizedMonths,
    truncated,
    attempts: visibleRows.map((row) => {
      const normalizedIp = normalizeCountryLookupIp(row.ip_address);
      const countryCode =
        normalizedIp && refreshedCountryCodes.has(normalizedIp)
          ? refreshedCountryCodes.get(normalizedIp) ?? null
          : normalizeCountryCode(row.country_code);
      return {
        id: row.id,
        ipAddress: row.ip_address,
        countryCode,
        outcome: row.outcome,
        attemptedAt: row.attempted_at
      };
    })
  };
}
