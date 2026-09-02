import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture
} from "@simplewebauthn/server";
import { db, transaction, type DbClient } from "../lib/db.js";
import { normalizeAuthVersion, signAuthToken } from "../lib/auth.js";
import { ApiError } from "../lib/http.js";
import { enforceCountryLoginPolicy } from "../lib/country-login-policy.js";
import { enforceVpnAccessPolicy, getClientTimeZone, getClientWebRtcSignal } from "../lib/vpn-access-policy.js";
import { getClientIpAddress, recordLoginAttempt } from "../lib/login-history.js";
import { isPermanentlyBlockedTotpIp } from "../lib/totp-ip-block.js";
import {
  createOpaqueToken,
  hashOpaqueToken,
  toBase64Url,
  webAuthnConfig
} from "../lib/mfa.js";
import { toPublicUser } from "../lib/mappers.js";
import {
  clearPasskeyCeremonyBinding,
  getOrCreatePasskeyCeremonyBinding,
  readPasskeyCeremonyBinding
} from "../lib/passkey-ceremony-cookie.js";
import { setAuthSessionCookie } from "../lib/session-cookie.js";
import {
  requireJsonRequestBody,
  requireSameOriginBrowserRequest
} from "../middleware/auth.js";
import {
  passkeyLoginOptionsIpRateLimit,
  passkeyLoginVerifyIpRateLimit
} from "../middleware/auth-rate-limit.js";
import { validate } from "../middleware/validate.js";
import type { UserRow } from "../types/domain.js";

const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const opaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const challengeLifetimeMs = 5 * 60_000;
const challengeCleanupIntervalMs = 60_000;
const maxCredentialIdBytes = 1023;
const maxUserHandleBytes = 64;
const maxClientExtensionResultsBytes = 8 * 1024;
const maxClientExtensionNodes = 256;
const maxClientExtensionDepth = 8;
const directEnvelopeKeys = new Set(["challengeToken", "response"]);
const directCredentialRequiredKeys = new Set([
  "id",
  "rawId",
  "type",
  "clientExtensionResults",
  "response"
]);
const directCredentialOptionalKeys = new Set(["authenticatorAttachment"]);
const directAuthenticatorResponseKeys = new Set([
  "clientDataJSON",
  "authenticatorData",
  "signature",
  "userHandle"
]);

const canonicalBase64Url = (maxLength: number) => z.string().min(1).max(maxLength).regex(base64UrlPattern);

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
const opaqueTokenSchema = z.string().regex(opaqueTokenPattern);

const directPasskeyResponseSchema = z.object({
  id: canonicalBase64Url(1366),
  rawId: canonicalBase64Url(1366),
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: clientExtensionResultsSchema,
  response: z.object({
    clientDataJSON: canonicalBase64Url(16_384),
    authenticatorData: canonicalBase64Url(16_384),
    signature: canonicalBase64Url(4_096),
    userHandle: canonicalBase64Url(128)
  }).strict()
}).strict();

const optionsSchema = z.object({}).strict();
const verifySchema = z.object({
  challengeToken: opaqueTokenSchema,
  response: directPasskeyResponseSchema
}).strict();
const verifyEnvelopeSchema = z.object({ challengeToken: opaqueTokenSchema }).passthrough();

type PasskeyLoginChallengeRow = {
  token_hash: string;
  binding_hash: string;
  challenge: string;
  source_ip: string;
  expires_at: string;
  used_at: string | null;
};

type PasskeyRow = {
  id: string;
  user_id: string;
  credential_id: Buffer;
  webauthn_user_id: Buffer;
  public_key: Buffer;
  counter: number | bigint | string;
  transports: string | null;
  device_type: string;
  backed_up: 0 | 1 | boolean;
};

export const passkeyLoginRouter = Router();

let passkeyChallengeCleanupInFlight: Promise<unknown> | null = null;
let nextPasskeyChallengeCleanupAt = 0;

passkeyLoginRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

function loginFailure() {
  return new ApiError(401, "PASSKEY_LOGIN_FAILED", "The passkey could not be verified");
}

function expiresAt(msFromNow: number) {
  return new Date(Date.now() + msFromNow);
}

function decodeBase64UrlStrict(value: string, maxBytes: number) {
  if (!base64UrlPattern.test(value)) throw loginFailure();
  const decoded = Buffer.from(value, "base64url");
  if (!decoded.length || decoded.length > maxBytes || decoded.toString("base64url") !== value) {
    throw loginFailure();
  }
  return decoded;
}

function equalBytes(left: Buffer | Uint8Array, right: Buffer | Uint8Array) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactOwnKeys(
  value: unknown,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string> = new Set()
) {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length < required.size || keys.length > required.size + optional.size) return false;
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
  }
  return keys.every((key) => required.has(key) || optional.has(key));
}

function hasStrictDirectPasskeyShape(value: unknown) {
  if (!hasExactOwnKeys(value, directEnvelopeKeys)) return false;
  const envelope = value as Record<string, unknown>;
  if (!hasExactOwnKeys(
    envelope.response,
    directCredentialRequiredKeys,
    directCredentialOptionalKeys
  )) return false;
  const credential = envelope.response as Record<string, unknown>;
  return hasExactOwnKeys(credential.response, directAuthenticatorResponseKeys);
}

function parseTransports(value: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!value) return undefined;
  const transports = value.split(",").map((item) => item.trim()).filter(Boolean);
  return transports.length ? transports as AuthenticatorTransportFuture[] : undefined;
}

async function createPasskeyLoginChallenge(binding: string, sourceIp: string) {
  const options = await generateAuthenticationOptions({
    rpID: webAuthnConfig.rpID,
    allowCredentials: [],
    userVerification: "required",
    timeout: 60_000
  });
  const challengeToken = createOpaqueToken();

  // This insert is the only database mutation required to make the freshly
  // issued challenge verifiable. Keeping unrelated garbage collection out of
  // this critical path avoids several extra DB protocol round trips before the
  // browser is even allowed to call navigator.credentials.get().
  await db.execute(
    `INSERT INTO passkey_login_challenges
       (token_hash, binding_hash, challenge, source_ip, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      hashOpaqueToken(challengeToken),
      hashOpaqueToken(binding),
      options.challenge,
      sourceIp,
      expiresAt(challengeLifetimeMs)
    ]
  );

  return { options, challengeToken };
}

function schedulePasskeyLoginChallengeCleanup() {
  const now = Date.now();
  if (passkeyChallengeCleanupInFlight || now < nextPasskeyChallengeCleanupAt) return;
  nextPasskeyChallengeCleanupAt = now + challengeCleanupIntervalMs;

  // All rows have a five-minute expires_at, so the old used_at>10m branch was
  // redundant. Using only the already-indexed expiry column also gives MariaDB
  // a straightforward range predicate. Cleanup is intentionally best-effort
  // and runs after the response has been queued so it cannot delay native UI.
  passkeyChallengeCleanupInFlight = db.execute(
    `DELETE FROM passkey_login_challenges
     WHERE expires_at <= CURRENT_TIMESTAMP(3)`
  ).catch((error) => {
    console.error("Failed to clean up expired passkey login challenges", error);
  }).finally(() => {
    passkeyChallengeCleanupInFlight = null;
  });
}

async function consumePasskeyLoginChallenge(challengeToken: string, binding: string, sourceIp: string) {
  return transaction(async (client) => {
    const tokenHash = hashOpaqueToken(challengeToken);
    const bindingHash = hashOpaqueToken(binding);
    const row = await client.queryOne<PasskeyLoginChallengeRow>(
      `SELECT token_hash, binding_hash, challenge, source_ip, expires_at, used_at
       FROM passkey_login_challenges
       WHERE token_hash = ? AND binding_hash = ? AND source_ip = ?
         AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
       FOR UPDATE`,
      [tokenHash, bindingHash, sourceIp]
    );
    if (!row) throw loginFailure();

    const consumed = await client.execute<{ affectedRows: number }>(
      `UPDATE passkey_login_challenges
       SET used_at = CURRENT_TIMESTAMP(3)
       WHERE token_hash = ? AND binding_hash = ? AND source_ip = ? AND used_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP(3)`,
      [tokenHash, bindingHash, sourceIp]
    );
    if (Number(consumed.affectedRows) !== 1) throw loginFailure();
    return row;
  });
}

async function findPasskeyByCredentialId(credentialId: Buffer, client: DbClient = db) {
  return client.queryOne<PasskeyRow>(
    `SELECT id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
            device_type, backed_up
     FROM user_passkeys
     WHERE credential_id = ?`,
    [credentialId]
  );
}

function assertStablePasskey(current: PasskeyRow | undefined, verified: PasskeyRow) {
  if (
    !current
    || current.id !== verified.id
    || current.user_id !== verified.user_id
    || Number(current.counter) !== Number(verified.counter)
    || !equalBytes(current.credential_id, verified.credential_id)
    || !equalBytes(current.webauthn_user_id, verified.webauthn_user_id)
    || !equalBytes(current.public_key, verified.public_key)
  ) {
    throw loginFailure();
  }
  return current;
}

passkeyLoginRouter.post(
  "/options",
  requireSameOriginBrowserRequest,
  requireJsonRequestBody,
  passkeyLoginOptionsIpRateLimit,
  validate({ body: optionsSchema }),
  async (req, res, next) => {
    try {
      const binding = getOrCreatePasskeyCeremonyBinding(req, res);
      const result = await createPasskeyLoginChallenge(binding, getClientIpAddress(req));
      res.once("finish", schedulePasskeyLoginChallengeCleanup);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

passkeyLoginRouter.post(
  "/verify",
  requireSameOriginBrowserRequest,
  requireJsonRequestBody,
  passkeyLoginVerifyIpRateLimit,
  async (req, res, next) => {
    const sourceIp = getClientIpAddress(req);
    let knownUserId: string | null = null;

    try {
      const binding = readPasskeyCeremonyBinding(req);
      if (!binding) throw loginFailure();

      const envelope = verifyEnvelopeSchema.safeParse(req.body);
      if (!envelope.success) throw loginFailure();
      const { challengeToken } = envelope.data;
      const challenge = await consumePasskeyLoginChallenge(challengeToken, binding, sourceIp);
      // Keep the one-time token consumed even when the remaining payload is
      // malformed, and enforce the exact JSON key contract independently of
      // the schema library before cryptographic verification.
      if (!hasStrictDirectPasskeyShape(req.body)) throw loginFailure();
      const parsed = verifySchema.safeParse(req.body);
      if (!parsed.success) throw loginFailure();
      const { response } = parsed.data;
      const credentialId = decodeBase64UrlStrict(response.id, maxCredentialIdBytes);
      const rawCredentialId = decodeBase64UrlStrict(response.rawId, maxCredentialIdBytes);
      if (!equalBytes(credentialId, rawCredentialId)) throw loginFailure();

      const userHandle = decodeBase64UrlStrict(response.response.userHandle, maxUserHandleBytes);
      const passkey = await findPasskeyByCredentialId(credentialId);
      if (!passkey) throw loginFailure();
      knownUserId = passkey.user_id;
      if (!equalBytes(userHandle, passkey.webauthn_user_id)) throw loginFailure();

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
        throw loginFailure();
      }
      if (!verification.verified) throw loginFailure();

      const previousCounter = Number(passkey.counter);
      const newCounter = Number(verification.authenticationInfo.newCounter);
      if (!Number.isSafeInteger(previousCounter) || previousCounter < 0) throw loginFailure();
      if (!Number.isSafeInteger(newCounter) || newCounter < 0) throw loginFailure();
      if (previousCounter > 0 && newCounter <= previousCounter) throw loginFailure();

      if (await isPermanentlyBlockedTotpIp(sourceIp, passkey.user_id)) {
        throw new ApiError(
          403,
          "TOTP_IP_PERMANENTLY_BLOCKED",
          "Access from this IP address is temporarily blocked for this account"
        );
      }
      await enforceCountryLoginPolicy(passkey.user_id, undefined, sourceIp);
      await enforceVpnAccessPolicy(passkey.user_id, undefined, sourceIp, getClientTimeZone(req), getClientWebRtcSignal(req));

      const result = await transaction(async (client) => {
        const user = await client.queryOne<UserRow>(
          "SELECT * FROM users WHERE id = ? FOR UPDATE",
          [passkey.user_id]
        );
        if (!user) throw loginFailure();

        const currentPasskey = assertStablePasskey(
          await client.queryOne<PasskeyRow>(
            `SELECT id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
                    device_type, backed_up
             FROM user_passkeys
             WHERE id = ? AND user_id = ?
             FOR UPDATE`,
            [passkey.id, passkey.user_id]
          ),
          passkey
        );
        if (!equalBytes(userHandle, currentPasskey.webauthn_user_id)) throw loginFailure();

        const updated = await client.execute<{ affectedRows: number }>(
          `UPDATE user_passkeys
           SET counter = ?, device_type = ?, backed_up = ?, last_used_at = CURRENT_TIMESTAMP(3)
           WHERE id = ? AND user_id = ? AND counter = ?`,
          [
            newCounter,
            verification.authenticationInfo.credentialDeviceType,
            verification.authenticationInfo.credentialBackedUp,
            currentPasskey.id,
            currentPasskey.user_id,
            previousCounter
          ]
        );
        const affectedRows = Number(updated.affectedRows);
        if (!Number.isSafeInteger(affectedRows) || affectedRows < 0 || affectedRows > 1) {
          throw loginFailure();
        }

        // MariaDB may report zero changed rows when a counterless authenticator
        // legitimately writes the same counter/device values. Confirm the
        // security-relevant post-state under the existing row lock instead of
        // treating the driver's changed-row count as a match oracle.
        const persistedPasskey = await client.queryOne<PasskeyRow>(
          `SELECT id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
                  device_type, backed_up
           FROM user_passkeys
           WHERE id = ? AND user_id = ?
           FOR UPDATE`,
          [currentPasskey.id, currentPasskey.user_id]
        );
        if (
          !persistedPasskey
          || persistedPasskey.id !== currentPasskey.id
          || persistedPasskey.user_id !== currentPasskey.user_id
          || Number(persistedPasskey.counter) !== newCounter
          || persistedPasskey.device_type !== verification.authenticationInfo.credentialDeviceType
          || Boolean(persistedPasskey.backed_up) !== verification.authenticationInfo.credentialBackedUp
          || !equalBytes(persistedPasskey.credential_id, currentPasskey.credential_id)
          || !equalBytes(persistedPasskey.webauthn_user_id, currentPasskey.webauthn_user_id)
          || !equalBytes(persistedPasskey.public_key, currentPasskey.public_key)
        ) {
          throw loginFailure();
        }

        await client.execute(
          `UPDATE users
           SET failed_login_attempts = 0, last_failed_login_at = NULL, login_locked_until = NULL
           WHERE id = ?`,
          [user.id]
        );
        await recordLoginAttempt(user.id, sourceIp, "SUCCESS", client);

        return {
          user: toPublicUser(user),
          token: signAuthToken({
            sub: user.id,
            username: user.username,
            authVersion: normalizeAuthVersion(user.auth_version)
          })
        };
      });

      setAuthSessionCookie(res, result.token);
      clearPasskeyCeremonyBinding(res);
      res.json({ user: result.user });
    } catch (error) {
      if (knownUserId && error instanceof ApiError && error.code === "PASSKEY_LOGIN_FAILED") {
        await recordLoginAttempt(knownUserId, sourceIp, "FAILURE");
      }
      next(error);
    }
  }
);
