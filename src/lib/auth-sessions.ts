import { createHash } from "node:crypto";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import type { AuthTokenPayload } from "./auth.js";
import { db, type DbClient } from "./db.js";
import { ApiError } from "./http.js";
import { getClientIpAddress } from "./login-history.js";
import { parseUserAgent } from "./user-agent.js";

const sessionIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
type AuthSessionRow = {
  id: string;
  ip_address: string;
  browser_name: string;
  browser_version: string | null;
  os_name: string;
  device_type: string;
  created_at: string | Date;
  last_seen_at: string | Date;
  expires_at: string | Date;
};

export function normalizeAuthSessionId(value: unknown) {
  const sessionId = typeof value === "string" ? value : "";
  if (!sessionIdPattern.test(sessionId)) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid authentication token");
  }
  return sessionId;
}

export function resolveAuthSessionId(token: string, payload: AuthTokenPayload) {
  if (payload.sessionId) return normalizeAuthSessionId(payload.sessionId);
  // Tokens issued before device-session tracking did not contain a session id.
  // A deterministic digest makes those existing cookies individually revocable
  // without changing or exposing the token itself.
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function getTokenTimestamps(token: string) {
  const decoded = jwt.decode(token);
  if (typeof decoded !== "object" || !decoded || typeof decoded.exp !== "number") {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid authentication token");
  }
  const expiresAt = new Date(decoded.exp * 1000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired authentication token");
  }
  const issuedAt = typeof decoded.iat === "number" ? new Date(decoded.iat * 1000) : new Date();
  return {
    issuedAt: Number.isFinite(issuedAt.getTime()) ? issuedAt : new Date(),
    expiresAt
  };
}

function publicSession(row: AuthSessionRow, currentSessionId: string | null) {
  return {
    id: row.id,
    ipAddress: row.ip_address,
    browserName: row.browser_name,
    browserVersion: row.browser_version,
    browserLabel: row.browser_version ? `${row.browser_name} ${row.browser_version}` : row.browser_name,
    osName: row.os_name,
    deviceType: ["desktop", "mobile", "tablet"].includes(row.device_type) ? row.device_type : "other",
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    isCurrent: Boolean(currentSessionId && row.id === currentSessionId)
  };
}

export async function ensureAuthSessionForRequest(
  token: string,
  payload: AuthTokenPayload,
  req: Request,
  client: DbClient = db
) {
  const sessionId = resolveAuthSessionId(token, payload);
  const { issuedAt, expiresAt } = getTokenTimestamps(token);
  const ipAddress = getClientIpAddress(req);
  const parsed = parseUserAgent(req.header("user-agent"));

  await client.execute(
    `INSERT IGNORE INTO user_auth_sessions
       (id, user_id, auth_version, ip_address, browser_name, browser_version, os_name, device_type, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      payload.sub,
      payload.authVersion,
      ipAddress,
      parsed.browserName,
      parsed.browserVersion,
      parsed.osName,
      parsed.deviceType,
      issuedAt,
      expiresAt
    ]
  );

  const active = await client.queryOne<{ id: string }>(
    `SELECT id
     FROM user_auth_sessions
     WHERE id = ?
       AND user_id = ?
       AND auth_version = ?
       AND revoked_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP(3)`,
    [sessionId, payload.sub, payload.authVersion]
  );
  if (!active) {
    throw new ApiError(401, "SESSION_REVOKED", "This authentication session is no longer valid");
  }

  // Avoid a write on every request while keeping the device list reasonably fresh.
  await client.execute(
    `UPDATE user_auth_sessions
     SET last_seen_at = CURRENT_TIMESTAMP(3),
         ip_address = ?,
         browser_name = ?,
         browser_version = ?,
         os_name = ?,
         device_type = ?
     WHERE id = ?
       AND user_id = ?
       AND last_seen_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 5 MINUTE)`,
    [
      ipAddress,
      parsed.browserName,
      parsed.browserVersion,
      parsed.osName,
      parsed.deviceType,
      sessionId,
      payload.sub
    ]
  );

  return sessionId;
}

export async function listActiveAuthSessions(
  userId: string,
  authVersion: number,
  currentSessionId: string | null,
  client: DbClient = db
) {
  const rows = await client.query<AuthSessionRow>(
    `SELECT id, ip_address, browser_name, browser_version, os_name, device_type,
            created_at, last_seen_at, expires_at
     FROM user_auth_sessions
     WHERE user_id = ?
       AND auth_version = ?
       AND revoked_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP(3)
     ORDER BY last_seen_at DESC, created_at DESC, id DESC`,
    [userId, authVersion]
  );
  const sessions = rows.map((row) => publicSession(row, currentSessionId));
  sessions.sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent));
  return { sessions };
}

export async function revokeAuthSession(
  userId: string,
  sessionIdValue: unknown,
  authVersion: number,
  client: DbClient = db
) {
  const sessionId = typeof sessionIdValue === "string" && sessionIdPattern.test(sessionIdValue)
    ? sessionIdValue
    : null;
  if (!sessionId) {
    throw new ApiError(404, "SESSION_NOT_FOUND", "That active session was not found");
  }
  const result = await client.execute<{ affectedRows: number }>(
    `UPDATE user_auth_sessions
     SET revoked_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?
       AND user_id = ?
       AND auth_version = ?
       AND revoked_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP(3)`,
    [sessionId, userId, authVersion]
  );
  if (Number(result.affectedRows ?? 0) !== 1) {
    throw new ApiError(404, "SESSION_NOT_FOUND", "That active session was not found");
  }
  return sessionId;
}

export async function isAuthSessionActive(
  userId: string,
  sessionIdValue: unknown,
  authVersion: number,
  client: DbClient = db,
  { lock = false }: { lock?: boolean } = {}
) {
  let sessionId: string;
  try {
    sessionId = normalizeAuthSessionId(sessionIdValue);
  } catch {
    return false;
  }
  const row = await client.queryOne<{ id: string }>(
    `SELECT id
     FROM user_auth_sessions
     WHERE id = ?
       AND user_id = ?
       AND auth_version = ?
       AND revoked_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP(3)
     ${lock ? "FOR UPDATE" : ""}`,
    [sessionId, userId, authVersion]
  );
  return Boolean(row);
}

export type AuthSessionBoundaryScope = Readonly<{
  authVersion: number;
  workspaceGeneration: number;
  sessionId: string;
}>;

export async function assertCurrentAuthSessionBoundary(
  userId: string,
  scope: AuthSessionBoundaryScope,
  client: DbClient = db
) {
  const authVersion = Number(scope.authVersion);
  const workspaceGeneration = Number(scope.workspaceGeneration);
  if (
    !Number.isSafeInteger(authVersion)
    || authVersion < 1
    || !Number.isSafeInteger(workspaceGeneration)
    || workspaceGeneration < 1
  ) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication context is invalid");
  }

  const sessionId = normalizeAuthSessionId(scope.sessionId);
  const account = await client.queryOne<{ auth_version?: number; attachment_generation?: number }>(
    "SELECT auth_version, attachment_generation FROM users WHERE id = ? FOR UPDATE",
    [userId]
  );
  if (!account || Number(account.auth_version ?? 1) !== authVersion) {
    throw new ApiError(401, "SESSION_REVOKED", "This authentication session is no longer valid");
  }
  const currentWorkspaceGeneration = Number(account.attachment_generation ?? 1);
  if (!Number.isSafeInteger(currentWorkspaceGeneration) || currentWorkspaceGeneration < 1) {
    throw new Error(`Invalid workspace generation for user: ${userId}`);
  }

  const active = await isAuthSessionActive(userId, sessionId, authVersion, client, { lock: true });
  if (!active) {
    throw new ApiError(401, "SESSION_REVOKED", "This authentication session is no longer valid");
  }
  if (currentWorkspaceGeneration !== workspaceGeneration) {
    throw new ApiError(
      409,
      "WORKSPACE_RESTORED",
      "The workspace was restored while this request was in progress. Refresh before retrying."
    );
  }
}
