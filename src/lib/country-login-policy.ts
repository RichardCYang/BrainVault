import { db, type DbClient } from "./db.js";
import { lookupCountryCodes, normalizeCountryLookupIp, isPublicCountryLookupIp } from "./geo-country.js";
import { normalizeIsoCountryCode, type IsoCountryCode } from "./country-codes.js";
import { createId } from "./id.js";
import { ApiError } from "./http.js";

export const countryLoginModes = ["OFF", "ALLOWLIST", "BLOCKLIST"] as const;
export type CountryLoginMode = (typeof countryLoginModes)[number];
export type CountryLoginBlockReason =
  | "NOT_ALLOWLISTED"
  | "BLOCKLISTED"
  | "COUNTRY_UNRESOLVED"
  | "POLICY_INVALID"
  | "VPN_DETECTED"
  | "VPN_GATE_DETECTED"
  | "PROXY_DETECTED"
  | "TOR_DETECTED";

export const defaultCountryBlockHistoryMonths = 3;
export const maxCountryBlockHistoryMonths = 12;
export const countryBlockHistoryResultLimit = 500;
const countryBlockHistoryRetentionMonths = maxCountryBlockHistoryMonths + 1;

const successfulCountryCacheMs = 10 * 60_000;
const unresolvedCountryCacheMs = 60_000;
const providerFailureCacheMs = 15_000;
const maxCountryCacheEntries = 4_096;

type CountryResolution = {
  ipAddress: string;
  countryCode: IsoCountryCode | null;
  resolved: boolean;
};

type CountryCacheEntry = {
  countryCode: IsoCountryCode | null;
  resolved: boolean;
  expiresAt: number;
};

type CountryPolicy = {
  mode: CountryLoginMode;
  countries: IsoCountryCode[];
};

type CountryBlockRow = {
  id: string;
  ip_address: string;
  country_code: string | null;
  reason: CountryLoginBlockReason;
  blocked_at: string | Date;
};

const countryCache = new Map<string, CountryCacheEntry>();

export function normalizeCountryLoginMode(value: unknown): CountryLoginMode {
  return countryLoginModes.includes(value as CountryLoginMode) ? value as CountryLoginMode : "OFF";
}

function parseStoredCountryLoginMode(value: unknown): CountryLoginMode {
  // `undefined`/`null` is tolerated only as a compatibility fallback for callers
  // that do not project the new column yet. Any concrete invalid database value
  // fails closed instead of silently degrading an enabled policy to OFF.
  if (value === undefined || value === null) return "OFF";
  if (countryLoginModes.includes(value as CountryLoginMode)) return value as CountryLoginMode;
  throw new ApiError(500, "COUNTRY_POLICY_INVALID", "Stored country login policy mode is invalid");
}

function rememberCountryResolution(ipAddress: string, entry: CountryCacheEntry) {
  countryCache.delete(ipAddress);
  countryCache.set(ipAddress, entry);
  while (countryCache.size > maxCountryCacheEntries) {
    const oldestKey = countryCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    countryCache.delete(oldestKey);
  }
}

export async function resolveCountryLoginLocation(ipAddress: string): Promise<CountryResolution> {
  const normalizedIp = normalizeCountryLookupIp(ipAddress);
  if (!normalizedIp || !isPublicCountryLookupIp(normalizedIp)) {
    return { ipAddress: normalizedIp ?? ipAddress, countryCode: null, resolved: false };
  }

  const now = Date.now();
  const cached = countryCache.get(normalizedIp);
  if (cached && cached.expiresAt > now) {
    return {
      ipAddress: normalizedIp,
      countryCode: cached.countryCode,
      resolved: cached.resolved
    };
  }

  const countries = await lookupCountryCodes([normalizedIp]);
  if (!countries.has(normalizedIp)) {
    rememberCountryResolution(normalizedIp, {
      countryCode: null,
      resolved: false,
      expiresAt: now + providerFailureCacheMs
    });
    return { ipAddress: normalizedIp, countryCode: null, resolved: false };
  }

  const countryCode = normalizeIsoCountryCode(countries.get(normalizedIp));
  const resolved = Boolean(countryCode);
  rememberCountryResolution(normalizedIp, {
    countryCode,
    resolved,
    expiresAt: now + (resolved ? successfulCountryCacheMs : unresolvedCountryCacheMs)
  });
  return { ipAddress: normalizedIp, countryCode, resolved };
}

export async function getCountryLoginPolicy(
  userId: string,
  modeHint: unknown = undefined,
  client: DbClient = db
): Promise<CountryPolicy> {
  const hintedMode = countryLoginModes.includes(modeHint as CountryLoginMode)
    ? modeHint as CountryLoginMode
    : null;
  if (modeHint !== undefined && modeHint !== null && !hintedMode) {
    throw new ApiError(500, "COUNTRY_POLICY_INVALID", "Stored country login policy mode is invalid");
  }
  const mode = hintedMode ?? parseStoredCountryLoginMode(
    (await client.queryOne<{ country_login_mode: unknown }>(
      "SELECT country_login_mode FROM users WHERE id = ?",
      [userId]
    ))?.country_login_mode
  );
  if (mode === "OFF") return { mode, countries: [] };

  const rows = await client.query<{ country_code: string }>(
    `SELECT country_code
     FROM user_country_login_countries
     WHERE user_id = ?
     ORDER BY country_code`,
    [userId]
  );
  const countries = rows
    .map((row) => normalizeIsoCountryCode(row.country_code))
    .filter((code): code is IsoCountryCode => Boolean(code));
  return { mode, countries };
}

export function evaluateResolvedCountryPolicy(
  policy: CountryPolicy,
  resolution: CountryResolution
): { allowed: boolean; reason: CountryLoginBlockReason | null } {
  if (policy.mode === "OFF") return { allowed: true, reason: null };
  if (!policy.countries.length) return { allowed: false, reason: "POLICY_INVALID" };
  if (!resolution.resolved || !resolution.countryCode) {
    return { allowed: false, reason: "COUNTRY_UNRESOLVED" };
  }

  const listed = policy.countries.includes(resolution.countryCode);
  if (policy.mode === "ALLOWLIST") {
    return listed
      ? { allowed: true, reason: null }
      : { allowed: false, reason: "NOT_ALLOWLISTED" };
  }
  return listed
    ? { allowed: false, reason: "BLOCKLISTED" }
    : { allowed: true, reason: null };
}

export async function checkCountryLoginAccess(
  userId: string,
  modeHint: unknown,
  ipAddress: string,
  client: DbClient = db
) {
  const policy = await getCountryLoginPolicy(userId, modeHint, client);
  if (policy.mode === "OFF") {
    return {
      allowed: true,
      policy,
      resolution: { ipAddress, countryCode: null, resolved: false } satisfies CountryResolution,
      reason: null as CountryLoginBlockReason | null
    };
  }

  const resolution = await resolveCountryLoginLocation(ipAddress);
  const decision = evaluateResolvedCountryPolicy(policy, resolution);
  return { ...decision, policy, resolution };
}

export async function recordCountryLoginBlock(
  userId: string,
  ipAddress: string,
  countryCode: string | null,
  reason: CountryLoginBlockReason,
  client: DbClient = db
) {
  try {
    await client.execute(
      `DELETE FROM user_country_login_blocks
       WHERE user_id = ? AND blocked_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ${countryBlockHistoryRetentionMonths} MONTH)`,
      [userId]
    );
    await client.execute(
      `INSERT INTO user_country_login_blocks
         (id, user_id, ip_address, country_code, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [createId("cgb"), userId, ipAddress || "unknown", normalizeIsoCountryCode(countryCode), reason]
    );
  } catch (error) {
    console.error("Failed to record a country-login block", {
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: typeof error === "object" && error !== null && "code" in error ? String(error.code) : null
    });
  }
}

export async function enforceCountryLoginPolicy(
  userId: string,
  modeHint: unknown,
  ipAddress: string,
  client: DbClient = db
) {
  let result: Awaited<ReturnType<typeof checkCountryLoginAccess>>;
  try {
    result = await checkCountryLoginAccess(userId, modeHint, ipAddress, client);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "COUNTRY_POLICY_INVALID") throw error;
    await recordCountryLoginBlock(userId, ipAddress || "unknown", null, "POLICY_INVALID", client);
    throw new ApiError(
      403,
      "COUNTRY_LOGIN_BLOCKED",
      "Access is blocked because the account country-login policy is invalid",
      { countryCode: null, reason: "POLICY_INVALID" }
    );
  }
  if (result.allowed) return result;

  await recordCountryLoginBlock(
    userId,
    result.resolution.ipAddress || ipAddress || "unknown",
    result.resolution.countryCode,
    result.reason ?? "POLICY_INVALID",
    client
  );
  throw new ApiError(
    403,
    "COUNTRY_LOGIN_BLOCKED",
    "Access from this IP country is blocked by the account security policy",
    {
      countryCode: result.resolution.countryCode,
      reason: result.reason
    }
  );
}

export async function assertPolicyAllowsCurrentLocation(
  mode: CountryLoginMode,
  countries: readonly IsoCountryCode[],
  ipAddress: string
) {
  if (mode === "OFF") return resolveCountryLoginLocation(ipAddress);
  const resolution = await resolveCountryLoginLocation(ipAddress);
  const decision = evaluateResolvedCountryPolicy({ mode, countries: [...countries] }, resolution);
  if (!decision.allowed) {
    throw new ApiError(
      400,
      "COUNTRY_POLICY_WOULD_BLOCK_CURRENT_IP",
      "The proposed country policy would block the IP address currently changing the setting",
      {
        countryCode: resolution.countryCode,
        reason: decision.reason
      }
    );
  }
  return resolution;
}

export async function listCountryLoginBlocks(
  userId: string,
  months: number,
  client: DbClient = db
) {
  const normalizedMonths = Number.isFinite(months)
    ? Math.min(maxCountryBlockHistoryMonths, Math.max(1, Math.trunc(months)))
    : defaultCountryBlockHistoryMonths;
  const rows = await client.query<CountryBlockRow>(
    `SELECT id, ip_address, country_code, reason, blocked_at
     FROM user_country_login_blocks
     WHERE user_id = ?
       AND blocked_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ${normalizedMonths} MONTH)
     ORDER BY blocked_at DESC, id DESC
     LIMIT ${countryBlockHistoryResultLimit + 1}`,
    [userId]
  );
  const truncated = rows.length > countryBlockHistoryResultLimit;
  return {
    months: normalizedMonths,
    truncated,
    blocks: rows.slice(0, countryBlockHistoryResultLimit).map((row) => ({
      id: row.id,
      ipAddress: row.ip_address,
      countryCode: normalizeIsoCountryCode(row.country_code),
      reason: row.reason,
      blockedAt: row.blocked_at
    }))
  };
}

export function resetCountryLoginLocationCacheForTests() {
  countryCache.clear();
}
