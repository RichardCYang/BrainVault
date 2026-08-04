import { env } from "../config/env.js";
import type { DbClient } from "./db.js";

export type PasswordLoginDecision = "ALLOWED" | "DENIED" | "LOCKED";

type LoginLockState = {
  failed_login_attempts?: number | bigint | string | null;
  last_failed_login_at?: string | Date | null;
  login_locked_until?: string | Date | null;
};

function timestamp(value: string | Date | null | undefined) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function failedAttemptCount(value: LoginLockState["failed_login_attempts"]) {
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function calculateLockDurationMs(failedAttempts: number) {
  if (failedAttempts < env.AUTH_LOGIN_LOCK_THRESHOLD) return 0;
  const exponent = Math.min(20, failedAttempts - env.AUTH_LOGIN_LOCK_THRESHOLD);
  return Math.min(env.AUTH_LOGIN_LOCK_MAX_MS, env.AUTH_LOGIN_LOCK_BASE_MS * (2 ** exponent));
}

export async function evaluatePasswordLogin(
  client: DbClient,
  userId: string,
  passwordMatches: boolean,
  nowMs = Date.now()
): Promise<PasswordLoginDecision> {
  const state = await client.queryOne<LoginLockState>(
    `SELECT failed_login_attempts, last_failed_login_at, login_locked_until
     FROM users WHERE id = ? FOR UPDATE`,
    [userId]
  );
  if (!state) return "DENIED";

  if (passwordMatches) {
    await client.execute(
      `UPDATE users
       SET failed_login_attempts = 0, last_failed_login_at = NULL, login_locked_until = NULL
       WHERE id = ?`,
      [userId]
    );
    return "ALLOWED";
  }

  const lockedUntil = timestamp(state.login_locked_until);
  if (lockedUntil !== null && lockedUntil > nowMs) return "LOCKED";

  const lastFailure = timestamp(state.last_failed_login_at);
  const withinFailureWindow = lastFailure !== null && nowMs - lastFailure <= env.AUTH_LOGIN_FAILURE_RESET_MS;
  const failures = (withinFailureWindow ? failedAttemptCount(state.failed_login_attempts) : 0) + 1;
  const lockDurationMs = calculateLockDurationMs(failures);
  const lockedUntilDate = lockDurationMs > 0 ? new Date(nowMs + lockDurationMs) : null;

  await client.execute(
    `UPDATE users
     SET failed_login_attempts = ?, last_failed_login_at = ?, login_locked_until = ?
     WHERE id = ?`,
    [failures, new Date(nowMs), lockedUntilDate, userId]
  );
  return "DENIED";
}
