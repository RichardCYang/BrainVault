import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import { env } from "../config/env.js";
import { db, transaction, type DbClient } from "../lib/db.js";
import { disconnectUserCollaborators } from "../lib/collaboration-server.js";
import { normalizeAuthVersion, signAuthToken, verifyPassword } from "../lib/auth.js";
import { ApiError } from "../lib/http.js";
import { clearMfaCeremonyBinding, readMfaCeremonyBinding } from "../lib/mfa-ceremony-cookie.js";
import { enforceCountryLoginPolicy } from "../lib/country-login-policy.js";
import { enforceVpnAccessPolicy, getClientTimeZone, getClientWebRtcSignal } from "../lib/vpn-access-policy.js";
import { getClientIpAddress, recordLoginAttempt, type LoginAttemptOutcome } from "../lib/login-history.js";
import { clearTotpIpFailures, recordTotpIpFailure } from "../lib/totp-ip-block.js";
import { createId } from "../lib/id.js";
import {
  buildTotpUri,
  createOpaqueToken,
  decryptMfaSecret,
  encryptMfaSecret,
  findMatchingTotpStep,
  generateTotpSecret,
  hashOpaqueToken,
  toBase64Url,
  webAuthnConfig
} from "../lib/mfa.js";
import { toPublicUser } from "../lib/mappers.js";
import { setAuthSessionCookie } from "../lib/session-cookie.js";
import {
  requireAuth,
  requireJsonRequestBody,
  requireSameOriginBrowserRequest
} from "../middleware/auth.js";
import {
  accountReauthenticationRateLimit,
  mfaLoginAccountRateLimit,
  mfaLoginIpRateLimit,
  mfaLoginOptionsAccountRateLimit,
  mfaLoginOptionsIpRateLimit,
  mfaSetupRateLimit
} from "../middleware/auth-rate-limit.js";
import { validate } from "../middleware/validate.js";
import type { UserRow } from "../types/domain.js";
import { passwordInputSchema, requireUser } from "../utils/schemas.js";

export const mfaRouter = Router();

mfaRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

const mfaSessionLifetimeMs = 5 * 60_000;
const challengeLifetimeMs = 5 * 60_000;
// Cross-device passkey registration includes QR scanning, nearby-device
// verification, provider selection, and device unlock. SimpleWebAuthn's
// default is 60 seconds, which is unnecessarily tight for that ceremony.
// Leave one minute of the server-side challenge lifetime for the verification
// request to return after the authenticator finishes.
const passkeyRegistrationTimeoutMs = challengeLifetimeMs - 60_000;
const totpSetupLifetimeMs = 10 * 60_000;
const maxMfaAttempts = 8;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const maxCredentialIdBytes = 1023;
const maxUserHandleBytes = 64;
const maxClientExtensionResultsBytes = 8 * 1024;
const maxClientExtensionNodes = 256;
const maxClientExtensionDepth = 8;
const opaqueTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const canonicalBase64Url = (maxLength: number) =>
  z.string().min(1).max(maxLength).regex(base64UrlPattern);
const mfaFailureCarryWindowMs = env.AUTH_MFA_ACCOUNT_WINDOW_MS;

function isBoundedJsonValue(value: unknown) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visitedNodes = 0;

  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    visitedNodes += 1;
    if (visitedNodes > maxClientExtensionNodes || current.depth > maxClientExtensionDepth) return false;

    const candidate = current.value;
    if (
      candidate === null
      || typeof candidate === "boolean"
      || (typeof candidate === "number" && Number.isFinite(candidate))
      || (typeof candidate === "string" && candidate.length <= 2_048)
    ) continue;

    if (Array.isArray(candidate)) {
      if (candidate.length > 64) return false;
      for (const item of candidate) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }

    if (typeof candidate !== "object" || Object.getPrototypeOf(candidate) !== Object.prototype) return false;
    const entries = Object.entries(candidate as Record<string, unknown>);
    if (entries.length > 32) return false;
    for (const [key, item] of entries) {
      if (
        !key
        || key.length > 128
        || key === "__proto__"
        || key === "prototype"
        || key === "constructor"
      ) return false;
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }

  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxClientExtensionResultsBytes;
  } catch {
    return false;
  }
}

const clientExtensionResultsSchema = z.custom<Record<string, unknown>>(
  (value) => (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && isBoundedJsonValue(value)
  )
);

const currentPasswordSchema = z.object({
  currentPassword: passwordInputSchema(1)
});

const totpVerifySchema = z.object({
  setupToken: z.string().min(20).max(256),
  code: z.string().trim().regex(/^\d{6}$/)
});

const mfaLoginTotpSchema = z.object({
  mfaToken: z.string().min(20).max(256),
  code: z.string().trim().regex(/^\d{6}$/)
});

const mfaTokenSchema = z.object({
  mfaToken: z.string().min(20).max(256)
});

const passkeyNameSchema = z.string().trim().min(1).max(80);

const passkeyOptionsSchema = z.object({
  currentPassword: passwordInputSchema(1),
  name: passkeyNameSchema,
  registrationTarget: z.enum(["automatic", "remote"]).default("automatic")
});

const registrationResponseSchema = z.object({
  id: canonicalBase64Url(1366),
  rawId: canonicalBase64Url(1366),
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: clientExtensionResultsSchema,
  response: z.object({
    clientDataJSON: canonicalBase64Url(16_384),
    attestationObject: canonicalBase64Url(131_072),
    authenticatorData: canonicalBase64Url(16_384).optional(),
    transports: z.array(z.string().min(1).max(32)).max(8).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: canonicalBase64Url(16_384).optional()
  }).strict()
}).strict();

const passkeyRegistrationSchema = z.object({
  challengeToken: opaqueTokenSchema,
  response: registrationResponseSchema
}).strict();

const authenticationResponseSchema = z.object({
  id: canonicalBase64Url(1366),
  rawId: canonicalBase64Url(1366),
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: clientExtensionResultsSchema,
  response: z.object({
    clientDataJSON: canonicalBase64Url(16_384),
    authenticatorData: canonicalBase64Url(16_384),
    signature: canonicalBase64Url(4_096),
    userHandle: canonicalBase64Url(128).optional()
  }).strict()
}).strict();

const passkeyLoginVerifySchema = z.object({
  mfaToken: opaqueTokenSchema,
  challengeToken: opaqueTokenSchema,
  response: authenticationResponseSchema
}).strict();

const passkeyIdParamsSchema = z.object({
  id: z.string().min(1).max(64)
});

const passkeyRenameSchema = z.object({ name: passkeyNameSchema });

export type MfaMethods = {
  totp: boolean;
  passkey: boolean;
};

type TotpCredentialRow = {
  user_id: string;
  secret_ciphertext: string;
  secret_iv: string;
  secret_tag: string;
  last_used_step: number | null;
};

type TotpSetupRow = {
  token_hash: string;
  user_id: string;
  secret_ciphertext: string;
  secret_iv: string;
  secret_tag: string;
  expires_at: string;
};

type PasskeyRow = {
  id: string;
  user_id: string;
  credential_id: Buffer;
  webauthn_user_id: Buffer;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  device_type: string;
  backed_up: 0 | 1 | boolean;
  aaguid: string | null;
  name: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

type MfaSessionRow = {
  token_hash: string;
  user_id: string;
  source_ip: string;
  binding_hash: string;
  failed_attempts: number;
  expires_at: string;
  used_at: string | null;
};

type ChallengeRow = {
  token_hash: string;
  user_id: string;
  kind: "registration" | "authentication";
  challenge: string;
  context_hash: string | null;
  metadata: string | null;
  expires_at: string;
  used_at: string | null;
};

function expiresAt(msFromNow: number) {
  return new Date(Date.now() + msFromNow);
}

function parseTransports(value: string | null | undefined): AuthenticatorTransportFuture[] | undefined {
  if (!value) return undefined;
  const transports = value.split(",").map((item) => item.trim()).filter(Boolean);
  return transports.length ? transports as AuthenticatorTransportFuture[] : undefined;
}

function serializeTransports(value: readonly string[] | undefined) {
  return value?.length ? value.join(",") : null;
}

function getWebAuthnUserDisplayName(name: string | null | undefined, username: string) {
  // Chromium hybrid/QR registration has historically failed after the QR is
  // scanned when `user.displayName` is an empty string. BrainVault normally
  // stores an empty profile name as NULL, but legacy/restored data can still
  // contain an empty/whitespace-only value. Always send a non-empty display
  // name at the WebAuthn boundary so the QR path cannot hit that browser bug.
  return name?.trim() || username;
}

type WebAuthnBoundaryErrorFactory = () => ApiError;

function decodeBase64UrlStrict(
  value: string,
  maxBytes: number,
  createError: WebAuthnBoundaryErrorFactory
) {
  if (!base64UrlPattern.test(value)) throw createError();
  const decoded = Buffer.from(value, "base64url");
  if (!decoded.length || decoded.length > maxBytes || decoded.toString("base64url") !== value) {
    throw createError();
  }
  return decoded;
}

function equalBytes(left: Buffer | Uint8Array, right: Buffer | Uint8Array) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function assertMatchingCredentialIds(
  response: { id: string; rawId: string },
  createError: WebAuthnBoundaryErrorFactory
) {
  const id = decodeBase64UrlStrict(response.id, maxCredentialIdBytes, createError);
  const rawId = decodeBase64UrlStrict(response.rawId, maxCredentialIdBytes, createError);
  if (!equalBytes(id, rawId)) throw createError();
  return id;
}

function parseMetadata(value: string | null) {
  if (!value) return {} as Record<string, unknown>;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function toPublicPasskey(row: PasskeyRow) {
  return {
    id: row.id,
    name: row.name,
    deviceType: row.device_type,
    backedUp: Boolean(row.backed_up),
    transports: parseTransports(row.transports) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at
  };
}

function requireRequestAuthVersion(req: Request) {
  const authVersion = Number(req.auth?.authVersion);
  if (!Number.isSafeInteger(authVersion) || authVersion < 1) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication context is missing");
  }
  return authVersion;
}

async function getAuthenticationUserForUpdate(
  client: DbClient,
  userId: string,
  expectedAuthVersion: number
) {
  const user = await client.queryOne<UserRow>("SELECT * FROM users WHERE id = ? FOR UPDATE", [userId]);
  if (!user) throw new ApiError(401, "UNAUTHENTICATED", "User no longer exists");
  if (normalizeAuthVersion(user.auth_version) !== expectedAuthVersion) {
    throw new ApiError(401, "SESSION_REVOKED", "This authentication session is no longer valid");
  }
  return user;
}

async function requireCurrentPasswordForUpdate(
  client: DbClient,
  userId: string,
  expectedAuthVersion: number,
  currentPassword: string
) {
  const user = await getAuthenticationUserForUpdate(client, userId, expectedAuthVersion);
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw new ApiError(400, "CURRENT_PASSWORD_INCORRECT", "Current password is incorrect");
  }
  return user;
}

async function rotateAuthenticationCredentials(client: DbClient, user: UserRow) {
  const authVersion = normalizeAuthVersion(user.auth_version) + 1;
  await client.execute("UPDATE users SET auth_version = ? WHERE id = ?", [authVersion, user.id]);
  await client.execute("DELETE FROM mfa_login_sessions WHERE user_id = ?", [user.id]);
  await client.execute("DELETE FROM webauthn_challenges WHERE user_id = ?", [user.id]);
  await client.execute("DELETE FROM mfa_totp_setups WHERE user_id = ?", [user.id]);
  return { ...user, auth_version: authVersion };
}

function issueRotatedAuthenticationSession(res: Response, user: UserRow) {
  disconnectUserCollaborators(user.id, "Authentication credentials changed");
  const token = signAuthToken({
    sub: user.id,
    username: user.username,
    authVersion: normalizeAuthVersion(user.auth_version)
  });
  setAuthSessionCookie(res, token);
}

export async function getMfaMethods(userId: string): Promise<MfaMethods> {
  const row = await db.queryOne<{ totp_enabled: number; passkey_count: number }>(
    `SELECT
       EXISTS(SELECT 1 FROM user_totp_credentials WHERE user_id = ?) AS totp_enabled,
       (SELECT COUNT(*) FROM user_passkeys WHERE user_id = ?) AS passkey_count`,
    [userId, userId]
  );
  return {
    totp: Boolean(Number(row?.totp_enabled ?? 0)),
    passkey: Number(row?.passkey_count ?? 0) > 0
  };
}

export async function createMfaLoginSession(userId: string, sourceIp: string, binding: string) {
  const token = createOpaqueToken();
  const tokenHash = hashOpaqueToken(token);
  const carryCutoff = new Date(Date.now() - mfaFailureCarryWindowMs);

  await transaction(async (client) => {
    const user = await client.queryOne<{ id: string }>("SELECT id FROM users WHERE id = ? FOR UPDATE", [userId]);
    if (!user) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid ID or password");

    const previous = await client.queryOne<{ failed_attempts: number | null }>(
      `SELECT MAX(failed_attempts) AS failed_attempts
       FROM mfa_login_sessions
       WHERE user_id = ? AND created_at > ?`,
      [userId, carryCutoff]
    );
    const carriedAttempts = Number(previous?.failed_attempts ?? 0);
    if (carriedAttempts >= maxMfaAttempts) {
      throw new ApiError(429, "MFA_TEMPORARILY_LOCKED", "Too many two-step verification attempts. Try again later.");
    }

    await client.execute(
      `UPDATE mfa_login_sessions
       SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP(3))
       WHERE user_id = ? AND used_at IS NULL`,
      [userId]
    );
    await client.execute(
      "DELETE FROM mfa_login_sessions WHERE user_id = ? AND created_at <= ?",
      [userId, carryCutoff]
    );
    await client.execute(
      `INSERT INTO mfa_login_sessions
         (token_hash, user_id, source_ip, binding_hash, failed_attempts, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [tokenHash, userId, sourceIp, hashOpaqueToken(binding), carriedAttempts, expiresAt(mfaSessionLifetimeMs)]
    );
  });

  return token;
}

async function getActiveMfaSession(mfaToken: string, sourceIp: string, binding: string, client: DbClient = db) {
  const row = await client.queryOne<MfaSessionRow>(
    `SELECT token_hash, user_id, source_ip, binding_hash, failed_attempts, expires_at, used_at
     FROM mfa_login_sessions
     WHERE token_hash = ? AND source_ip = ? AND binding_hash = ?
       AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)`,
    [hashOpaqueToken(mfaToken), sourceIp, hashOpaqueToken(binding)]
  );
  if (!row || Number(row.failed_attempts) >= maxMfaAttempts) {
    throw new ApiError(401, "MFA_SESSION_EXPIRED", "The two-step verification session expired");
  }
  return row;
}

function requireMfaCeremonyBinding(req: Request) {
  const binding = readMfaCeremonyBinding(req);
  if (!binding) {
    throw new ApiError(401, "MFA_SESSION_EXPIRED", "The two-step verification session expired");
  }
  return binding;
}

async function enforceMfaLoginNetworkAccess(pendingSession: MfaSessionRow, req: Request) {
  await enforceCountryLoginPolicy(pendingSession.user_id, undefined, pendingSession.source_ip);
  await enforceVpnAccessPolicy(pendingSession.user_id, undefined, pendingSession.source_ip, getClientTimeZone(req), getClientWebRtcSignal(req));
}

async function reserveMfaAttempt(mfaToken: string, sourceIp: string, binding: string) {
  const tokenHash = hashOpaqueToken(mfaToken);
  return transaction(async (client) => {
    const row = await client.queryOne<MfaSessionRow>(
      `SELECT token_hash, user_id, source_ip, binding_hash, failed_attempts, expires_at, used_at
       FROM mfa_login_sessions
       WHERE token_hash = ? AND source_ip = ? AND binding_hash = ?
         AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
       FOR UPDATE`,
      [tokenHash, sourceIp, hashOpaqueToken(binding)]
    );
    const failedAttempts = Number(row?.failed_attempts ?? maxMfaAttempts);
    if (!row || failedAttempts >= maxMfaAttempts) {
      throw new ApiError(401, "MFA_SESSION_EXPIRED", "The two-step verification session expired");
    }

    const result = await client.execute<{ affectedRows: number }>(
      `UPDATE mfa_login_sessions
       SET failed_attempts = failed_attempts + 1
       WHERE token_hash = ? AND source_ip = ? AND binding_hash = ?
         AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
         AND failed_attempts = ?`,
      [tokenHash, sourceIp, hashOpaqueToken(binding), failedAttempts]
    );
    if (Number(result.affectedRows) !== 1) {
      throw new ApiError(401, "MFA_SESSION_EXPIRED", "The two-step verification session expired");
    }
    return { ...row, failed_attempts: failedAttempts + 1 };
  });
}

async function recordReservedMfaFailure(
  session: MfaSessionRow,
  outcome: LoginAttemptOutcome = "FAILURE"
) {
  await recordLoginAttempt(session.user_id, session.source_ip, outcome);
}

async function completeMfaSession(client: DbClient, mfaToken: string, userId: string, binding: string) {
  const result = await client.execute<{ affectedRows: number }>(
    `UPDATE mfa_login_sessions
     SET used_at = CURRENT_TIMESTAMP(3)
     WHERE token_hash = ? AND user_id = ? AND binding_hash = ? AND used_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP(3)`,
    [hashOpaqueToken(mfaToken), userId, hashOpaqueToken(binding)]
  );
  if (Number(result.affectedRows) !== 1) {
    throw new ApiError(401, "MFA_SESSION_EXPIRED", "The two-step verification session expired");
  }
  await client.execute("DELETE FROM mfa_login_sessions WHERE user_id = ?", [userId]);
}

async function createChallenge(
  client: DbClient,
  userId: string,
  kind: ChallengeRow["kind"],
  challenge: string,
  contextHash: string | null,
  metadata: Record<string, unknown> | null
) {
  const token = createOpaqueToken();
  await client.execute(
    `DELETE FROM webauthn_challenges
     WHERE user_id = ? AND (expires_at <= CURRENT_TIMESTAMP(3) OR used_at IS NOT NULL)`,
    [userId]
  );
  await client.execute(
    `INSERT INTO webauthn_challenges
       (token_hash, user_id, kind, challenge, context_hash, metadata, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      hashOpaqueToken(token),
      userId,
      kind,
      challenge,
      contextHash,
      metadata ? JSON.stringify(metadata) : null,
      expiresAt(challengeLifetimeMs)
    ]
  );
  return token;
}

async function consumeChallenge(
  challengeToken: string,
  userId: string,
  kind: ChallengeRow["kind"],
  contextHash: string | null
) {
  return transaction(async (client) => {
    const tokenHash = hashOpaqueToken(challengeToken);
    const row = await client.queryOne<ChallengeRow>(
      `SELECT token_hash, user_id, kind, challenge, context_hash, metadata, expires_at, used_at
       FROM webauthn_challenges
       WHERE token_hash = ? AND user_id = ? AND kind = ?
         AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
         AND ((context_hash IS NULL AND ? IS NULL) OR context_hash = ?)`,
      [tokenHash, userId, kind, contextHash, contextHash]
    );
    if (!row) throw new ApiError(400, "WEBAUTHN_CHALLENGE_EXPIRED", "The passkey challenge expired");

    const result = await client.execute<{ affectedRows: number }>(
      `UPDATE webauthn_challenges SET used_at = CURRENT_TIMESTAMP(3)
       WHERE token_hash = ? AND used_at IS NULL`,
      [tokenHash]
    );
    if (Number(result.affectedRows) !== 1) {
      throw new ApiError(400, "WEBAUTHN_CHALLENGE_EXPIRED", "The passkey challenge expired");
    }
    return row;
  });
}

async function getLoginUserForUpdate(client: DbClient, userId: string) {
  const user = await client.queryOne<UserRow>("SELECT * FROM users WHERE id = ? FOR UPDATE", [userId]);
  if (!user) throw new ApiError(401, "UNAUTHENTICATED", "User no longer exists");
  return user;
}

function createMfaLoginResult(user: UserRow) {
  return {
    user: toPublicUser(user),
    token: signAuthToken({ sub: user.id, username: user.username, authVersion: normalizeAuthVersion(user.auth_version) })
  };
}

mfaRouter.get("/status", requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const [methods, passkeys] = await Promise.all([
      getMfaMethods(user.id),
      db.query<PasskeyRow>(
        `SELECT id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
                device_type, backed_up, aaguid, name, created_at, updated_at, last_used_at
         FROM user_passkeys WHERE user_id = ? ORDER BY created_at DESC`,
        [user.id]
      )
    ]);
    res.json({
      totpEnabled: methods.totp,
      passkeys: passkeys.map(toPublicPasskey),
      webAuthnAvailable: true
    });
  } catch (error) {
    next(error);
  }
});

mfaRouter.post(
  "/totp/setup",
  requireAuth,
  accountReauthenticationRateLimit,
  validate({ body: currentPasswordSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const expectedAuthVersion = requireRequestAuthVersion(req);
      const { currentPassword } = req.body as z.infer<typeof currentPasswordSchema>;
      const secret = generateTotpSecret();
      const encrypted = encryptMfaSecret(secret);
      const setupToken = createOpaqueToken();
      const uri = buildTotpUri(user.username, secret);
      const qrCodeDataUrl = await QRCode.toDataURL(uri, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 240
      });

      await transaction(async (client) => {
        const lockedUser = await requireCurrentPasswordForUpdate(
          client,
          user.id,
          expectedAuthVersion,
          currentPassword
        );
        await client.execute("DELETE FROM mfa_totp_setups WHERE user_id = ?", [lockedUser.id]);
        await client.execute(
          `INSERT INTO mfa_totp_setups
             (token_hash, user_id, secret_ciphertext, secret_iv, secret_tag, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            hashOpaqueToken(setupToken),
            lockedUser.id,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.tag,
            expiresAt(totpSetupLifetimeMs)
          ]
        );
      });

      res.json({ setupToken, secret, otpauthUri: uri, qrCodeDataUrl });
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.post(
  "/totp/verify",
  requireAuth,
  mfaSetupRateLimit,
  validate({ body: totpVerifySchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const expectedAuthVersion = requireRequestAuthVersion(req);
      const { setupToken, code } = req.body as z.infer<typeof totpVerifySchema>;
      const setupTokenHash = hashOpaqueToken(setupToken);

      const updatedUser = await transaction(async (client) => {
        const lockedUser = await getAuthenticationUserForUpdate(client, user.id, expectedAuthVersion);
        const setup = await client.queryOne<TotpSetupRow>(
          `SELECT token_hash, user_id, secret_ciphertext, secret_iv, secret_tag, expires_at
           FROM mfa_totp_setups
           WHERE token_hash = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP(3)
           FOR UPDATE`,
          [setupTokenHash, lockedUser.id]
        );
        if (!setup) throw new ApiError(400, "TOTP_SETUP_EXPIRED", "The authenticator setup expired");

        const secret = decryptMfaSecret({
          ciphertext: setup.secret_ciphertext,
          iv: setup.secret_iv,
          tag: setup.secret_tag
        });
        const matchedStep = findMatchingTotpStep(secret, code);
        if (matchedStep === null) {
          throw new ApiError(400, "INVALID_MFA_CODE", "The verification code is invalid");
        }

        await client.execute(
          `INSERT INTO user_totp_credentials
             (user_id, secret_ciphertext, secret_iv, secret_tag, last_used_step)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             secret_ciphertext = VALUES(secret_ciphertext),
             secret_iv = VALUES(secret_iv),
             secret_tag = VALUES(secret_tag),
             last_used_step = VALUES(last_used_step)`,
          [lockedUser.id, setup.secret_ciphertext, setup.secret_iv, setup.secret_tag, matchedStep]
        );
        await client.execute("DELETE FROM mfa_totp_setups WHERE token_hash = ?", [setupTokenHash]);
        return rotateAuthenticationCredentials(client, lockedUser);
      });

      issueRotatedAuthenticationSession(res, updatedUser);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.delete(
  "/totp",
  requireAuth,
  accountReauthenticationRateLimit,
  validate({ body: currentPasswordSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const expectedAuthVersion = requireRequestAuthVersion(req);
      const { currentPassword } = req.body as z.infer<typeof currentPasswordSchema>;
      const updatedUser = await transaction(async (client) => {
        const lockedUser = await requireCurrentPasswordForUpdate(
          client,
          user.id,
          expectedAuthVersion,
          currentPassword
        );
        await client.execute("DELETE FROM user_totp_credentials WHERE user_id = ?", [lockedUser.id]);
        await client.execute("DELETE FROM mfa_totp_setups WHERE user_id = ?", [lockedUser.id]);
        return rotateAuthenticationCredentials(client, lockedUser);
      });

      issueRotatedAuthenticationSession(res, updatedUser);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.post(
  "/passkeys/options",
  requireAuth,
  accountReauthenticationRateLimit,
  validate({ body: passkeyOptionsSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const expectedAuthVersion = requireRequestAuthVersion(req);
      const { currentPassword, name, registrationTarget } = req.body as z.infer<typeof passkeyOptionsSchema>;
      const result = await transaction(async (client) => {
        const lockedUser = await requireCurrentPasswordForUpdate(
          client,
          user.id,
          expectedAuthVersion,
          currentPassword
        );
        const existingPasskeys = await client.query<PasskeyRow>(
          `SELECT id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
                  device_type, backed_up, aaguid, name, created_at, updated_at, last_used_at
           FROM user_passkeys WHERE user_id = ?`,
          [lockedUser.id]
        );

        const options = await generateRegistrationOptions({
          rpName: webAuthnConfig.rpName,
          rpID: webAuthnConfig.rpID,
          userName: lockedUser.username,
          userDisplayName: getWebAuthnUserDisplayName(lockedUser.name, lockedUser.username),
          userID: Buffer.from(lockedUser.id, "utf8"),
          attestationType: "none",
          excludeCredentials: existingPasskeys.map((passkey) => ({
            id: toBase64Url(passkey.credential_id),
            transports: parseTransports(passkey.transports)
          })),
          // WebAuthn Level 3 defines the "hybrid" hint for a phone/tablet
          // authenticator reached from another client device. SimpleWebAuthn
          // maps remoteDevice to hints:["hybrid"] and also supplies the
          // cross-platform attachment fallback for older browsers.
          ...(registrationTarget === "remote"
            ? {
                preferredAuthenticatorType: "remoteDevice" as const,
                timeout: passkeyRegistrationTimeoutMs,
                // Keep the existing automatic/hardware-key path untouched,
                // but use the two most common algorithms for the QR/provider
                // interoperability path instead of leading with Ed25519.
                supportedAlgorithmIDs: [-7, -257]
              }
            : {}),
          authenticatorSelection: {
            residentKey: "required",
            userVerification: "required"
          }
        });

        const challengeToken = await createChallenge(
          client,
          lockedUser.id,
          "registration",
          options.challenge,
          null,
          {
            name,
            webauthnUserId: options.user.id,
            authVersion: expectedAuthVersion,
            registrationTarget
          }
        );
        return { options, challengeToken };
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.post(
  "/passkeys",
  requireAuth,
  mfaSetupRateLimit,
  validate({ body: passkeyRegistrationSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const expectedAuthVersion = requireRequestAuthVersion(req);
      const { challengeToken, response } = req.body as z.infer<typeof passkeyRegistrationSchema>;
      const challenge = await consumeChallenge(challengeToken, user.id, "registration", null);
      const metadata = parseMetadata(challenge.metadata);
      if (Number(metadata.authVersion) !== expectedAuthVersion) {
        throw new ApiError(400, "WEBAUTHN_CHALLENGE_EXPIRED", "The passkey challenge expired");
      }

      const registrationFailure = () =>
        new ApiError(400, "PASSKEY_REGISTRATION_FAILED", "The passkey could not be verified");
      assertMatchingCredentialIds(response, registrationFailure);

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: webAuthnConfig.origins,
          expectedRPID: webAuthnConfig.rpID,
          requireUserVerification: true
        });
      } catch {
        throw new ApiError(400, "PASSKEY_REGISTRATION_FAILED", "The passkey could not be verified");
      }

      if (!verification.verified) {
        throw new ApiError(400, "PASSKEY_REGISTRATION_FAILED", "The passkey could not be verified");
      }

      const { credential, credentialDeviceType, credentialBackedUp, aaguid } = verification.registrationInfo;
      const name = typeof metadata.name === "string" ? metadata.name : "Passkey";
      const webauthnUserId = typeof metadata.webauthnUserId === "string"
        ? decodeBase64UrlStrict(metadata.webauthnUserId, maxUserHandleBytes, registrationFailure)
        : Buffer.from(user.id, "utf8");
      const id = createId("pky");

      const result = await transaction(async (client) => {
        const lockedUser = await getAuthenticationUserForUpdate(client, user.id, expectedAuthVersion);
        await client.execute(
          `INSERT INTO user_passkeys
             (id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
              device_type, backed_up, aaguid, name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            lockedUser.id,
            decodeBase64UrlStrict(credential.id, maxCredentialIdBytes, registrationFailure),
            webauthnUserId,
            Buffer.from(credential.publicKey),
            credential.counter,
            serializeTransports(credential.transports),
            credentialDeviceType,
            credentialBackedUp,
            aaguid || null,
            name
          ]
        );

        const passkey = await client.queryOne<PasskeyRow>(
          `SELECT id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
                  device_type, backed_up, aaguid, name, created_at, updated_at, last_used_at
           FROM user_passkeys WHERE id = ? AND user_id = ?`,
          [id, lockedUser.id]
        );
        if (!passkey) throw new ApiError(500, "PASSKEY_CREATE_FAILED", "The passkey was not saved");
        const updatedUser = await rotateAuthenticationCredentials(client, lockedUser);
        return { passkey, updatedUser };
      });

      issueRotatedAuthenticationSession(res, result.updatedUser);
      res.status(201).json({ passkey: toPublicPasskey(result.passkey) });
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.patch(
  "/passkeys/:id",
  requireAuth,
  validate({ params: passkeyIdParamsSchema, body: passkeyRenameSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const { id } = req.params as z.infer<typeof passkeyIdParamsSchema>;
      const { name } = req.body as z.infer<typeof passkeyRenameSchema>;
      const result = await db.execute<{ affectedRows: number }>(
        "UPDATE user_passkeys SET name = ? WHERE id = ? AND user_id = ?",
        [name, id, user.id]
      );
      if (Number(result.affectedRows) !== 1) throw new ApiError(404, "PASSKEY_NOT_FOUND", "Passkey not found");
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.delete(
  "/passkeys/:id",
  requireAuth,
  accountReauthenticationRateLimit,
  validate({ params: passkeyIdParamsSchema, body: currentPasswordSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const expectedAuthVersion = requireRequestAuthVersion(req);
      const { id } = req.params as z.infer<typeof passkeyIdParamsSchema>;
      const { currentPassword } = req.body as z.infer<typeof currentPasswordSchema>;
      const updatedUser = await transaction(async (client) => {
        const lockedUser = await requireCurrentPasswordForUpdate(
          client,
          user.id,
          expectedAuthVersion,
          currentPassword
        );
        const result = await client.execute<{ affectedRows: number }>(
          "DELETE FROM user_passkeys WHERE id = ? AND user_id = ?",
          [id, lockedUser.id]
        );
        if (Number(result.affectedRows) !== 1) {
          throw new ApiError(404, "PASSKEY_NOT_FOUND", "Passkey not found");
        }
        return rotateAuthenticationCredentials(client, lockedUser);
      });

      issueRotatedAuthenticationSession(res, updatedUser);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.post(
  "/login/totp",
  requireSameOriginBrowserRequest,
  requireJsonRequestBody,
  mfaLoginIpRateLimit,
  mfaLoginAccountRateLimit,
  validate({ body: mfaLoginTotpSchema }),
  async (req, res, next) => {
    const { mfaToken, code } = req.body as z.infer<typeof mfaLoginTotpSchema>;
    let session: MfaSessionRow | undefined;
    try {
      const sourceIp = getClientIpAddress(req);
      const binding = requireMfaCeremonyBinding(req);
      const pendingSession = await getActiveMfaSession(mfaToken, sourceIp, binding);
      await enforceMfaLoginNetworkAccess(pendingSession, req);
      const activeSession = await reserveMfaAttempt(mfaToken, sourceIp, binding);
      session = activeSession;
      const result = await transaction(async (client) => {
        const loginUser = await getLoginUserForUpdate(client, activeSession.user_id);
        const credential = await client.queryOne<TotpCredentialRow>(
          `SELECT user_id, secret_ciphertext, secret_iv, secret_tag, last_used_step
           FROM user_totp_credentials WHERE user_id = ? FOR UPDATE`,
          [activeSession.user_id]
        );
        if (!credential) {
          throw new ApiError(400, "MFA_METHOD_UNAVAILABLE", "TOTP is not available for this account");
        }

        const secret = decryptMfaSecret({
          ciphertext: credential.secret_ciphertext,
          iv: credential.secret_iv,
          tag: credential.secret_tag
        });
        const matchedStep = findMatchingTotpStep(secret, code);
        if (matchedStep === null) {
          throw new ApiError(401, "INVALID_MFA_CODE", "The verification code is invalid");
        }
        if (credential.last_used_step !== null && Number(credential.last_used_step) >= matchedStep) {
          throw new ApiError(401, "MFA_CODE_REUSED", "The verification code was already used");
        }

        const updated = await client.execute<{ affectedRows: number }>(
          `UPDATE user_totp_credentials
           SET last_used_step = ?
           WHERE user_id = ? AND (last_used_step IS NULL OR last_used_step < ?)`,
          [matchedStep, activeSession.user_id, matchedStep]
        );
        if (Number(updated.affectedRows) !== 1) {
          throw new ApiError(401, "MFA_CODE_REUSED", "The verification code was already used");
        }
        await clearTotpIpFailures(activeSession.user_id, activeSession.source_ip, client);
        await recordLoginAttempt(activeSession.user_id, activeSession.source_ip, "SUCCESS", client);
        await completeMfaSession(client, mfaToken, activeSession.user_id, binding);
        return createMfaLoginResult(loginUser);
      });

      clearMfaCeremonyBinding(res);
      setAuthSessionCookie(res, result.token);
      res.json({ user: result.user });
    } catch (error) {
      if (session && error instanceof ApiError) {
        if (["INVALID_MFA_CODE", "MFA_CODE_REUSED"].includes(error.code)) {
          try {
            const attempt = await recordTotpIpFailure(session.user_id, session.source_ip);
            await recordReservedMfaFailure(session, attempt.blocked ? "LOCKED" : "FAILURE");
            if (attempt.blocked) {
              disconnectUserCollaborators(session.user_id, "Access from this IP is blocked for this account");
              next(new ApiError(403, "TOTP_IP_PERMANENTLY_BLOCKED", "This IP address is temporarily blocked after too many invalid TOTP codes", {
                attempts: attempt.attempts,
                maxAttempts: attempt.maxAttempts
              }));
              return;
            }
          } catch (securityError) {
            next(securityError);
            return;
          }
        } else if (error.code === "MFA_METHOD_UNAVAILABLE") {
          await recordReservedMfaFailure(session);
        }
      }
      next(error);
    }
  }
);

mfaRouter.post(
  "/login/passkey/options",
  requireSameOriginBrowserRequest,
  requireJsonRequestBody,
  mfaLoginOptionsIpRateLimit,
  mfaLoginOptionsAccountRateLimit,
  validate({ body: mfaTokenSchema }),
  async (req, res, next) => {
    try {
      const { mfaToken } = req.body as z.infer<typeof mfaTokenSchema>;
      const binding = requireMfaCeremonyBinding(req);
      const session = await getActiveMfaSession(mfaToken, getClientIpAddress(req), binding);
      await enforceCountryLoginPolicy(session.user_id, undefined, session.source_ip);
      await enforceVpnAccessPolicy(session.user_id, undefined, session.source_ip, getClientTimeZone(req), getClientWebRtcSignal(req));
      const passkeys = await db.query<PasskeyRow>(
        `SELECT id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
                device_type, backed_up, aaguid, name, created_at, updated_at, last_used_at
         FROM user_passkeys WHERE user_id = ?`,
        [session.user_id]
      );
      if (!passkeys.length) throw new ApiError(400, "MFA_METHOD_UNAVAILABLE", "No passkey is registered");

      const options = await generateAuthenticationOptions({
        rpID: webAuthnConfig.rpID,
        allowCredentials: passkeys.map((passkey) => ({
          id: toBase64Url(passkey.credential_id),
          transports: parseTransports(passkey.transports)
        })),
        userVerification: "required"
      });
      const contextHash = hashOpaqueToken(mfaToken);
      const challengeToken = await createChallenge(
        db,
        session.user_id,
        "authentication",
        options.challenge,
        contextHash,
        null
      );
      res.json({ options, challengeToken });
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.post(
  "/login/passkey/verify",
  requireSameOriginBrowserRequest,
  requireJsonRequestBody,
  mfaLoginIpRateLimit,
  mfaLoginAccountRateLimit,
  validate({ body: passkeyLoginVerifySchema }),
  async (req, res, next) => {
    const { mfaToken, challengeToken, response } = req.body as z.infer<typeof passkeyLoginVerifySchema>;
    let session: MfaSessionRow | undefined;
    try {
      const sourceIp = getClientIpAddress(req);
      const binding = requireMfaCeremonyBinding(req);
      const pendingSession = await getActiveMfaSession(mfaToken, sourceIp, binding);
      await enforceMfaLoginNetworkAccess(pendingSession, req);
      const activeSession = await reserveMfaAttempt(mfaToken, sourceIp, binding);
      session = activeSession;
      const contextHash = hashOpaqueToken(mfaToken);
      const challenge = await consumeChallenge(challengeToken, activeSession.user_id, "authentication", contextHash);
      const authenticationFailure = () =>
        new ApiError(401, "PASSKEY_AUTHENTICATION_FAILED", "The passkey could not be verified");
      const credentialId = assertMatchingCredentialIds(response, authenticationFailure);
      const passkey = await db.queryOne<PasskeyRow>(
        `SELECT id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
                device_type, backed_up, aaguid, name, created_at, updated_at, last_used_at
         FROM user_passkeys WHERE user_id = ? AND credential_id = ?`,
        [activeSession.user_id, credentialId]
      );
      if (!passkey) {
        throw new ApiError(401, "PASSKEY_NOT_FOUND", "The passkey is not registered for this account");
      }
      if (response.response.userHandle) {
        const userHandle = decodeBase64UrlStrict(
          response.response.userHandle,
          maxUserHandleBytes,
          authenticationFailure
        );
        if (!equalBytes(userHandle, passkey.webauthn_user_id)) throw authenticationFailure();
      }

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: response as AuthenticationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: webAuthnConfig.origins,
          expectedRPID: webAuthnConfig.rpID,
          credential: {
            id: toBase64Url(passkey.credential_id),
            publicKey: new Uint8Array(passkey.public_key),
            counter: Number(passkey.counter),
            transports: parseTransports(passkey.transports)
          },
          requireUserVerification: true
        });
      } catch {
        throw new ApiError(401, "PASSKEY_AUTHENTICATION_FAILED", "The passkey could not be verified");
      }
      if (!verification.verified) {
        throw new ApiError(401, "PASSKEY_AUTHENTICATION_FAILED", "The passkey could not be verified");
      }

      const previousCounter = Number(passkey.counter);
      const newCounter = Number(verification.authenticationInfo.newCounter);
      if (!Number.isSafeInteger(previousCounter) || previousCounter < 0) throw authenticationFailure();
      if (!Number.isSafeInteger(newCounter) || newCounter < 0) throw authenticationFailure();
      if (previousCounter > 0 && newCounter <= previousCounter) {
        throw new ApiError(401, "PASSKEY_COUNTER_REGRESSION", "The passkey counter did not advance");
      }

      const result = await transaction(async (client) => {
        const loginUser = await getLoginUserForUpdate(client, activeSession.user_id);
        const updated = await client.execute<{ affectedRows: number }>(
          `UPDATE user_passkeys
           SET counter = ?, device_type = ?, backed_up = ?, last_used_at = CURRENT_TIMESTAMP(3)
           WHERE id = ? AND user_id = ? AND counter = ?`,
          [
            newCounter,
            verification.authenticationInfo.credentialDeviceType,
            verification.authenticationInfo.credentialBackedUp,
            passkey.id,
            activeSession.user_id,
            previousCounter
          ]
        );
        if (Number(updated.affectedRows) !== 1) {
          throw new ApiError(401, "PASSKEY_AUTHENTICATION_FAILED", "The passkey state changed during verification");
        }
        await recordLoginAttempt(activeSession.user_id, activeSession.source_ip, "SUCCESS", client);
        await completeMfaSession(client, mfaToken, activeSession.user_id, binding);
        return createMfaLoginResult(loginUser);
      });

      clearMfaCeremonyBinding(res);
      setAuthSessionCookie(res, result.token);
      res.json({ user: result.user });
    } catch (error) {
      if (
        session
        && error instanceof ApiError
        && [
          "WEBAUTHN_CHALLENGE_EXPIRED",
          "PASSKEY_NOT_FOUND",
          "PASSKEY_AUTHENTICATION_FAILED",
          "PASSKEY_COUNTER_REGRESSION"
        ].includes(error.code)
      ) {
        await recordReservedMfaFailure(session);
      }
      next(error);
    }
  }
);
