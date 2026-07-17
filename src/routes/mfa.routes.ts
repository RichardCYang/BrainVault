import { Router } from "express";
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
import { db, transaction, type DbClient } from "../lib/db.js";
import { signAuthToken, verifyPassword } from "../lib/auth.js";
import { ApiError } from "../lib/http.js";
import { createId } from "../lib/id.js";
import {
  buildTotpUri,
  createOpaqueToken,
  decryptMfaSecret,
  encryptMfaSecret,
  findMatchingTotpStep,
  fromBase64Url,
  generateTotpSecret,
  hashOpaqueToken,
  toBase64Url,
  webAuthnConfig
} from "../lib/mfa.js";
import { toPublicUser } from "../lib/mappers.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import type { UserRow } from "../types/domain.js";
import { requireUser } from "../utils/schemas.js";

export const mfaRouter = Router();

const mfaSessionLifetimeMs = 5 * 60_000;
const challengeLifetimeMs = 5 * 60_000;
const totpSetupLifetimeMs = 10 * 60_000;
const maxMfaAttempts = 8;

const currentPasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128)
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
  currentPassword: z.string().min(1).max(128),
  name: passkeyNameSchema
});

const registrationResponseSchema = z.object({
  id: z.string().min(1).max(2000),
  rawId: z.string().min(1).max(2000),
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  response: z.object({
    clientDataJSON: z.string().min(1),
    attestationObject: z.string().min(1),
    authenticatorData: z.string().optional(),
    transports: z.array(z.string()).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: z.string().optional()
  })
});

const passkeyRegistrationSchema = z.object({
  challengeToken: z.string().min(20).max(256),
  response: registrationResponseSchema
});

const authenticationResponseSchema = z.object({
  id: z.string().min(1).max(2000),
  rawId: z.string().min(1).max(2000),
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  response: z.object({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().optional()
  })
});

const passkeyLoginVerifySchema = z.object({
  mfaToken: z.string().min(20).max(256),
  challengeToken: z.string().min(20).max(256),
  response: authenticationResponseSchema
});

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

async function getUserById(userId: string, client: DbClient = db) {
  return client.queryOne<UserRow>("SELECT * FROM users WHERE id = ?", [userId]);
}

async function requireCurrentPassword(userId: string, currentPassword: string) {
  const user = await getUserById(userId);
  if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
    throw new ApiError(400, "CURRENT_PASSWORD_INCORRECT", "Current password is incorrect");
  }
  return user;
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

export async function createMfaLoginSession(userId: string) {
  const token = createOpaqueToken();
  await db.execute(
    "DELETE FROM mfa_login_sessions WHERE user_id = ? OR expires_at <= CURRENT_TIMESTAMP(3) OR used_at IS NOT NULL",
    [userId]
  );
  await db.execute(
    `INSERT INTO mfa_login_sessions (token_hash, user_id, expires_at)
     VALUES (?, ?, ?)`,
    [hashOpaqueToken(token), userId, expiresAt(mfaSessionLifetimeMs)]
  );
  return token;
}

async function getActiveMfaSession(mfaToken: string, client: DbClient = db) {
  const row = await client.queryOne<MfaSessionRow>(
    `SELECT token_hash, user_id, failed_attempts, expires_at, used_at
     FROM mfa_login_sessions
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)`,
    [hashOpaqueToken(mfaToken)]
  );
  if (!row || row.failed_attempts >= maxMfaAttempts) {
    throw new ApiError(401, "MFA_SESSION_EXPIRED", "The two-step verification session expired");
  }
  return row;
}

async function recordMfaFailure(mfaToken: string) {
  await db.execute(
    `UPDATE mfa_login_sessions
     SET failed_attempts = failed_attempts + 1
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)`,
    [hashOpaqueToken(mfaToken)]
  );
}

async function completeMfaSession(client: DbClient, mfaToken: string, userId: string) {
  const result = await client.execute<{ affectedRows: number }>(
    `UPDATE mfa_login_sessions
     SET used_at = CURRENT_TIMESTAMP(3)
     WHERE token_hash = ? AND user_id = ? AND used_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP(3) AND failed_attempts < ?`,
    [hashOpaqueToken(mfaToken), userId, maxMfaAttempts]
  );
  if (Number(result.affectedRows) !== 1) {
    throw new ApiError(401, "MFA_SESSION_EXPIRED", "The two-step verification session expired");
  }
}

async function createChallenge(
  userId: string,
  kind: ChallengeRow["kind"],
  challenge: string,
  contextHash: string | null,
  metadata: Record<string, unknown> | null
) {
  const token = createOpaqueToken();
  await db.execute("DELETE FROM webauthn_challenges WHERE expires_at <= CURRENT_TIMESTAMP(3) OR used_at IS NOT NULL");
  await db.execute(
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

async function finishLogin(userId: string) {
  const user = await getUserById(userId);
  if (!user) throw new ApiError(401, "UNAUTHENTICATED", "User no longer exists");
  return {
    user: toPublicUser(user),
    token: signAuthToken({ sub: user.id, username: user.username })
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
  validate({ body: currentPasswordSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const { currentPassword } = req.body as z.infer<typeof currentPasswordSchema>;
      await requireCurrentPassword(user.id, currentPassword);

      const secret = generateTotpSecret();
      const encrypted = encryptMfaSecret(secret);
      const setupToken = createOpaqueToken();
      const uri = buildTotpUri(user.username, secret);
      const qrCodeDataUrl = await QRCode.toDataURL(uri, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 240
      });

      await db.execute("DELETE FROM mfa_totp_setups WHERE user_id = ? OR expires_at <= CURRENT_TIMESTAMP(3)", [user.id]);
      await db.execute(
        `INSERT INTO mfa_totp_setups
           (token_hash, user_id, secret_ciphertext, secret_iv, secret_tag, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          hashOpaqueToken(setupToken),
          user.id,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          expiresAt(totpSetupLifetimeMs)
        ]
      );

      res.json({ setupToken, secret, otpauthUri: uri, qrCodeDataUrl });
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.post(
  "/totp/verify",
  requireAuth,
  validate({ body: totpVerifySchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const { setupToken, code } = req.body as z.infer<typeof totpVerifySchema>;
      const setup = await db.queryOne<TotpSetupRow>(
        `SELECT token_hash, user_id, secret_ciphertext, secret_iv, secret_tag, expires_at
         FROM mfa_totp_setups
         WHERE token_hash = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP(3)`,
        [hashOpaqueToken(setupToken), user.id]
      );
      if (!setup) throw new ApiError(400, "TOTP_SETUP_EXPIRED", "The authenticator setup expired");

      const secret = decryptMfaSecret({
        ciphertext: setup.secret_ciphertext,
        iv: setup.secret_iv,
        tag: setup.secret_tag
      });
      if (findMatchingTotpStep(secret, code) === null) {
        throw new ApiError(400, "INVALID_MFA_CODE", "The verification code is invalid");
      }

      await transaction(async (client) => {
        await client.execute(
          `INSERT INTO user_totp_credentials
             (user_id, secret_ciphertext, secret_iv, secret_tag, last_used_step)
           VALUES (?, ?, ?, ?, NULL)
           ON DUPLICATE KEY UPDATE
             secret_ciphertext = VALUES(secret_ciphertext),
             secret_iv = VALUES(secret_iv),
             secret_tag = VALUES(secret_tag),
             last_used_step = NULL`,
          [user.id, setup.secret_ciphertext, setup.secret_iv, setup.secret_tag]
        );
        await client.execute("DELETE FROM mfa_totp_setups WHERE token_hash = ?", [hashOpaqueToken(setupToken)]);
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.delete(
  "/totp",
  requireAuth,
  validate({ body: currentPasswordSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const { currentPassword } = req.body as z.infer<typeof currentPasswordSchema>;
      await requireCurrentPassword(user.id, currentPassword);
      await db.execute("DELETE FROM user_totp_credentials WHERE user_id = ?", [user.id]);
      await db.execute("DELETE FROM mfa_totp_setups WHERE user_id = ?", [user.id]);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.post(
  "/passkeys/options",
  requireAuth,
  validate({ body: passkeyOptionsSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const { currentPassword, name } = req.body as z.infer<typeof passkeyOptionsSchema>;
      await requireCurrentPassword(user.id, currentPassword);
      const existingPasskeys = await db.query<PasskeyRow>(
        `SELECT id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
                device_type, backed_up, aaguid, name, created_at, updated_at, last_used_at
         FROM user_passkeys WHERE user_id = ?`,
        [user.id]
      );

      const options = await generateRegistrationOptions({
        rpName: webAuthnConfig.rpName,
        rpID: webAuthnConfig.rpID,
        userName: user.username,
        userDisplayName: user.name ?? user.username,
        userID: Buffer.from(user.id, "utf8"),
        attestationType: "none",
        excludeCredentials: existingPasskeys.map((passkey) => ({
          id: toBase64Url(passkey.credential_id),
          transports: parseTransports(passkey.transports)
        })),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required"
        }
      });

      const challengeToken = await createChallenge(user.id, "registration", options.challenge, null, {
        name,
        webauthnUserId: options.user.id
      });
      res.json({ options, challengeToken });
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.post(
  "/passkeys",
  requireAuth,
  validate({ body: passkeyRegistrationSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const { challengeToken, response } = req.body as z.infer<typeof passkeyRegistrationSchema>;
      const challenge = await consumeChallenge(challengeToken, user.id, "registration", null);
      const metadata = parseMetadata(challenge.metadata);

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
        ? fromBase64Url(metadata.webauthnUserId)
        : Buffer.from(user.id, "utf8");
      const id = createId("pky");

      await db.execute(
        `INSERT INTO user_passkeys
           (id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
            device_type, backed_up, aaguid, name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          user.id,
          fromBase64Url(credential.id),
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

      const passkey = await db.queryOne<PasskeyRow>(
        `SELECT id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
                device_type, backed_up, aaguid, name, created_at, updated_at, last_used_at
         FROM user_passkeys WHERE id = ? AND user_id = ?`,
        [id, user.id]
      );
      if (!passkey) throw new ApiError(500, "PASSKEY_CREATE_FAILED", "The passkey was not saved");
      res.status(201).json({ passkey: toPublicPasskey(passkey) });
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
  validate({ params: passkeyIdParamsSchema, body: currentPasswordSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const { id } = req.params as z.infer<typeof passkeyIdParamsSchema>;
      const { currentPassword } = req.body as z.infer<typeof currentPasswordSchema>;
      await requireCurrentPassword(user.id, currentPassword);
      const result = await db.execute<{ affectedRows: number }>(
        "DELETE FROM user_passkeys WHERE id = ? AND user_id = ?",
        [id, user.id]
      );
      if (Number(result.affectedRows) !== 1) throw new ApiError(404, "PASSKEY_NOT_FOUND", "Passkey not found");
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.post(
  "/login/totp",
  validate({ body: mfaLoginTotpSchema }),
  async (req, res, next) => {
    const { mfaToken, code } = req.body as z.infer<typeof mfaLoginTotpSchema>;
    try {
      const session = await getActiveMfaSession(mfaToken);
      const credential = await db.queryOne<TotpCredentialRow>(
        `SELECT user_id, secret_ciphertext, secret_iv, secret_tag, last_used_step
         FROM user_totp_credentials WHERE user_id = ?`,
        [session.user_id]
      );
      if (!credential) throw new ApiError(400, "MFA_METHOD_UNAVAILABLE", "TOTP is not available for this account");

      const secret = decryptMfaSecret({
        ciphertext: credential.secret_ciphertext,
        iv: credential.secret_iv,
        tag: credential.secret_tag
      });
      const matchedStep = findMatchingTotpStep(secret, code);
      if (matchedStep === null) {
        await recordMfaFailure(mfaToken);
        throw new ApiError(401, "INVALID_MFA_CODE", "The verification code is invalid");
      }

      await transaction(async (client) => {
        const updated = await client.execute<{ affectedRows: number }>(
          `UPDATE user_totp_credentials
           SET last_used_step = ?
           WHERE user_id = ? AND (last_used_step IS NULL OR last_used_step < ?)`,
          [matchedStep, session.user_id, matchedStep]
        );
        if (Number(updated.affectedRows) !== 1) {
          throw new ApiError(401, "MFA_CODE_REUSED", "The verification code was already used");
        }
        await completeMfaSession(client, mfaToken, session.user_id);
      });

      res.json(await finishLogin(session.user_id));
    } catch (error) {
      next(error);
    }
  }
);

mfaRouter.post(
  "/login/passkey/options",
  validate({ body: mfaTokenSchema }),
  async (req, res, next) => {
    try {
      const { mfaToken } = req.body as z.infer<typeof mfaTokenSchema>;
      const session = await getActiveMfaSession(mfaToken);
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
  validate({ body: passkeyLoginVerifySchema }),
  async (req, res, next) => {
    const { mfaToken, challengeToken, response } = req.body as z.infer<typeof passkeyLoginVerifySchema>;
    try {
      const session = await getActiveMfaSession(mfaToken);
      const contextHash = hashOpaqueToken(mfaToken);
      const challenge = await consumeChallenge(challengeToken, session.user_id, "authentication", contextHash);
      const credentialId = fromBase64Url(response.id);
      const passkey = await db.queryOne<PasskeyRow>(
        `SELECT id, user_id, credential_id, webauthn_user_id, public_key, counter, transports,
                device_type, backed_up, aaguid, name, created_at, updated_at, last_used_at
         FROM user_passkeys WHERE user_id = ? AND credential_id = ?`,
        [session.user_id, credentialId]
      );
      if (!passkey) {
        await recordMfaFailure(mfaToken);
        throw new ApiError(401, "PASSKEY_NOT_FOUND", "The passkey is not registered for this account");
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
        await recordMfaFailure(mfaToken);
        throw new ApiError(401, "PASSKEY_AUTHENTICATION_FAILED", "The passkey could not be verified");
      }
      if (!verification.verified) {
        await recordMfaFailure(mfaToken);
        throw new ApiError(401, "PASSKEY_AUTHENTICATION_FAILED", "The passkey could not be verified");
      }

      await transaction(async (client) => {
        await client.execute(
          `UPDATE user_passkeys
           SET counter = ?, device_type = ?, backed_up = ?, last_used_at = CURRENT_TIMESTAMP(3)
           WHERE id = ? AND user_id = ?`,
          [
            verification.authenticationInfo.newCounter,
            verification.authenticationInfo.credentialDeviceType,
            verification.authenticationInfo.credentialBackedUp,
            passkey.id,
            session.user_id
          ]
        );
        await completeMfaSession(client, mfaToken, session.user_id);
      });

      res.json(await finishLogin(session.user_id));
    } catch (error) {
      next(error);
    }
  }
);
