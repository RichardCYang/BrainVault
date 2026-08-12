import net from "node:net";
import { db, transaction, type DbClient } from "./db.js";
import { recordCountryLoginBlockStrict } from "./country-login-policy.js";

export const defaultTotpIpBlockThreshold = 3;
// The MFA login session itself permits at most eight verification attempts.
// Keep the configurable threshold within that same security boundary so every
// configured value can actually be reached before the MFA session expires.
export const maxTotpIpBlockThreshold = 8;
export const minTotpIpBlockThreshold = 1;

let permanentTotpIpEnforcementReady = false;

type TotpIpPolicyRow = {
  totp_ip_block_enabled: unknown;
  totp_ip_block_threshold: unknown;
};

type TotpIpFailureRow = {
  failed_attempts: unknown;
};

type TotpIpBlockRow = {
  ip_address: string;
  failed_attempts: unknown;
  blocked_at: string | Date;
};

export type TotpIpBlockPolicy = {
  enabled: boolean;
  maxAttempts: number;
};

export function normalizeTotpIpBlockEnabled(value: unknown) {
  return value === true || value === 1 || value === "1";
}

export function normalizeTotpIpBlockThreshold(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return defaultTotpIpBlockThreshold;
  return Math.min(maxTotpIpBlockThreshold, Math.max(minTotpIpBlockThreshold, parsed));
}

export function normalizeTotpBlockIpAddress(value: unknown) {
  const rawAddress = String(value ?? "").trim();
  const withoutZone = rawAddress.split("%")[0];
  const mappedIpv4 = withoutZone.startsWith("::ffff:") ? withoutZone.slice(7) : withoutZone;
  const normalized = net.isIPv4(mappedIpv4) ? mappedIpv4 : withoutZone;
  return net.isIP(normalized) ? normalized : "unknown";
}

export async function initializePermanentTotpIpEnforcement(client: DbClient = db) {
  // Verify the migration exists before the HTTP listener is opened. createApp()
  // stays test-friendly, while the normal server entry point always enables it.
  await client.queryOne<{ ok: number }>("SELECT 1 AS ok FROM user_totp_ip_blocks LIMIT 1");
  permanentTotpIpEnforcementReady = true;
}

export function isPermanentTotpIpEnforcementReady() {
  return permanentTotpIpEnforcementReady;
}

export function resetPermanentTotpIpEnforcementForTests() {
  permanentTotpIpEnforcementReady = false;
}

export async function isPermanentlyBlockedTotpIp(ipAddress: string, client: DbClient = db) {
  const normalizedIp = normalizeTotpBlockIpAddress(ipAddress);
  if (normalizedIp === "unknown") return false;
  const row = await client.queryOne<{ blocked: number }>(
    "SELECT 1 AS blocked FROM user_totp_ip_blocks WHERE ip_address = ? LIMIT 1",
    [normalizedIp]
  );
  return Boolean(row);
}

export async function getTotpIpBlockPolicy(userId: string, client: DbClient = db): Promise<TotpIpBlockPolicy> {
  const row = await client.queryOne<TotpIpPolicyRow>(
    "SELECT totp_ip_block_enabled, totp_ip_block_threshold FROM users WHERE id = ?",
    [userId]
  );
  if (!row) return { enabled: false, maxAttempts: defaultTotpIpBlockThreshold };
  return {
    enabled: normalizeTotpIpBlockEnabled(row.totp_ip_block_enabled),
    maxAttempts: normalizeTotpIpBlockThreshold(row.totp_ip_block_threshold)
  };
}

export async function recordTotpIpFailure(userId: string, ipAddress: string) {
  const normalizedIp = normalizeTotpBlockIpAddress(ipAddress);
  if (normalizedIp === "unknown") {
    return {
      enabled: false,
      blocked: false,
      newlyBlocked: false,
      attempts: 0,
      maxAttempts: defaultTotpIpBlockThreshold
    };
  }

  return transaction(async (client) => {
    const user = await client.queryOne<TotpIpPolicyRow & { id: string }>(
      `SELECT id, totp_ip_block_enabled, totp_ip_block_threshold
       FROM users WHERE id = ? FOR UPDATE`,
      [userId]
    );
    const maxAttempts = normalizeTotpIpBlockThreshold(user?.totp_ip_block_threshold);
    const enabled = Boolean(user && normalizeTotpIpBlockEnabled(user.totp_ip_block_enabled));
    if (!enabled) {
      await client.execute(
        "DELETE FROM user_totp_ip_failures WHERE user_id = ? AND ip_address = ?",
        [userId, normalizedIp]
      );
      return { enabled: false, blocked: false, newlyBlocked: false, attempts: 0, maxAttempts };
    }

    const existingBlock = await client.queryOne<{ failed_attempts: unknown }>(
      `SELECT failed_attempts FROM user_totp_ip_blocks
       WHERE user_id = ? AND ip_address = ? FOR UPDATE`,
      [userId, normalizedIp]
    );
    if (existingBlock) {
      return {
        enabled: true,
        blocked: true,
        newlyBlocked: false,
        attempts: Number(existingBlock.failed_attempts ?? maxAttempts),
        maxAttempts
      };
    }

    const previous = await client.queryOne<TotpIpFailureRow>(
      `SELECT failed_attempts FROM user_totp_ip_failures
       WHERE user_id = ? AND ip_address = ? FOR UPDATE`,
      [userId, normalizedIp]
    );
    // A configured permanent-block limit is cumulative for this account/IP
    // until TOTP succeeds or the owner changes the policy. This makes a
    // threshold of 3 mean the third invalid TOTP is always the blocking one,
    // rather than silently expiring failures after a rate-limit window.
    const previousAttempts = previous ? Math.max(0, Number(previous.failed_attempts ?? 0)) : 0;
    const attempts = previousAttempts + 1;

    if (attempts >= maxAttempts) {
      const inserted = await client.execute<{ affectedRows: number }>(
        `INSERT IGNORE INTO user_totp_ip_blocks (user_id, ip_address, failed_attempts)
         VALUES (?, ?, ?)`,
        [userId, normalizedIp, attempts]
      );
      const newlyBlocked = Number(inserted.affectedRows) === 1;
      await client.execute(
        "DELETE FROM user_totp_ip_failures WHERE user_id = ? AND ip_address = ?",
        [userId, normalizedIp]
      );
      await client.execute(
        "DELETE FROM mfa_login_sessions WHERE user_id = ? AND source_ip = ?",
        [userId, normalizedIp]
      );
      if (newlyBlocked) {
        await recordCountryLoginBlockStrict(
          userId,
          normalizedIp,
          null,
          "TOTP_ATTEMPTS_EXCEEDED",
          client
        );
      }
      return { enabled: true, blocked: true, newlyBlocked, attempts, maxAttempts };
    }

    await client.execute(
      `INSERT INTO user_totp_ip_failures (user_id, ip_address, failed_attempts, last_failed_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE failed_attempts = VALUES(failed_attempts), last_failed_at = CURRENT_TIMESTAMP(3)`,
      [userId, normalizedIp, attempts]
    );
    return { enabled: true, blocked: false, newlyBlocked: false, attempts, maxAttempts };
  });
}

export async function clearTotpIpFailures(
  userId: string,
  ipAddress: string,
  client: DbClient = db
) {
  const normalizedIp = normalizeTotpBlockIpAddress(ipAddress);
  if (normalizedIp === "unknown") return;
  await client.execute(
    "DELETE FROM user_totp_ip_failures WHERE user_id = ? AND ip_address = ?",
    [userId, normalizedIp]
  );
}

export async function listPermanentTotpIpBlocks(userId: string, client: DbClient = db) {
  const rows = await client.query<TotpIpBlockRow>(
    `SELECT ip_address, failed_attempts, blocked_at
     FROM user_totp_ip_blocks
     WHERE user_id = ?
     ORDER BY blocked_at DESC, ip_address ASC
     LIMIT 500`,
    [userId]
  );
  return {
    blocks: rows.map((row) => ({
      ipAddress: row.ip_address,
      failedAttempts: Math.max(0, Number(row.failed_attempts ?? 0)),
      blockedAt: row.blocked_at
    }))
  };
}
