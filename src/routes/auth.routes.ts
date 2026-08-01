import { randomInt } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { db, transaction, type DbValue } from "../lib/db.js";
import { createId } from "../lib/id.js";
import { hashPassword, normalizeAuthVersion, signAuthToken, verifyPassword } from "../lib/auth.js";
import { disconnectUserCollaborators } from "../lib/collaboration-server.js";
import { ApiError } from "../lib/http.js";
import { iconValueSchema, normalizeIconValue } from "../lib/icon-value.js";
import { evaluatePasswordLogin } from "../lib/login-lockout.js";
import {
  defaultLoginHistoryMonths,
  getClientIpAddress,
  listLoginAttempts,
  maxLoginHistoryMonths,
  recordLoginAttempt
} from "../lib/login-history.js";
import { toPublicUser } from "../lib/mappers.js";
import { clearAuthSessionCookie, setAuthSessionCookie } from "../lib/session-cookie.js";
import {
  maxAvatarBytes,
  normalizeAvatarDataUrl,
  supportedProfileLanguages
} from "../lib/profile.js";
import { requireAuth } from "../middleware/auth.js";
import {
  loginAccountRateLimit,
  loginIpRateLimit,
  registrationGlobalRateLimit,
  registrationRateLimit
} from "../middleware/auth-rate-limit.js";
import { getValidatedQuery, validate } from "../middleware/validate.js";
import { requireUser, usernameSchema } from "../utils/schemas.js";
import type { UserRow } from "../types/domain.js";
import { createMfaLoginSession, getMfaMethods, mfaRouter } from "./mfa.routes.js";

export const authRouter = Router();

const dummyPasswordHash = hashPassword("brainvault-invalid-user-password");
const preferredLanguageSchema = z.enum(supportedProfileLanguages);

const registerSchema = z.object({
  username: usernameSchema,
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(80).optional(),
  preferredLanguage: preferredLanguageSchema.optional()
});

const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128)
});

const profileSchema = z
  .object({
    name: z.string().trim().max(80).nullable().optional(),
    avatarData: z.string().max(Math.ceil((maxAvatarBytes * 4) / 3) + 128).nullable().optional(),
    preferredLanguage: preferredLanguageSchema.nullable().optional(),
    defaultCollectionIcon: iconValueSchema.nullable().optional()
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "At least one profile field is required"
  });

const loginHistoryQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(maxLoginHistoryMonths).default(defaultLoginHistoryMonths)
});

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(8).max(128)
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    path: ["newPassword"],
    message: "New password must differ from the current password"
  });

function isDuplicateEntryError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";
}

async function padRegistrationResponse(startedAt: number) {
  const targetDurationMs = 350 + randomInt(0, 76);
  const remainingMs = targetDurationMs - (Date.now() - startedAt);
  if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
}

authRouter.post(
  "/register",
  registrationGlobalRateLimit,
  registrationRateLimit,
  validate({ body: registerSchema }),
  async (req, res, next) => {
    try {
      if (!env.REGISTRATION_ENABLED) {
        throw new ApiError(403, "REGISTRATION_DISABLED", "Account registration is disabled");
      }

      const startedAt = Date.now();
      const { username, password, name, preferredLanguage } = req.body as z.infer<typeof registerSchema>;
      const existing = await db.queryOne<{ id: string }>("SELECT id FROM users WHERE username = ?", [username]);

      if (!existing) {
        const passwordHash = await hashPassword(password);
        const id = createId("usr");
        try {
          await db.execute(
            `INSERT INTO users (id, username, name, preferred_language, password_hash)
             VALUES (?, ?, ?, ?, ?)`,
            [id, username, name ?? null, preferredLanguage ?? null, passwordHash]
          );
        } catch (error) {
          if (!isDuplicateEntryError(error)) throw error;
        }
      }

      // Use the same status, response shape, and padded timing for new and existing usernames.
      // Existing accounts do not trigger another expensive bcrypt hash.
      await padRegistrationResponse(startedAt);
      res.setHeader("Cache-Control", "private, no-store");
      res.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

authRouter.post("/login", loginIpRateLimit, loginAccountRateLimit, validate({ body: loginSchema }), async (req, res, next) => {
  try {
    const { username, password } = req.body as z.infer<typeof loginSchema>;
    const sourceIp = getClientIpAddress(req);
    const candidate = await db.queryOne<UserRow>("SELECT * FROM users WHERE username = ?", [username]);
    let user: UserRow | undefined;
    let passwordDecision: "ALLOWED" | "DENIED" = "DENIED";

    if (!candidate) {
      await verifyPassword(password, await dummyPasswordHash);
    } else {
      const result = await transaction(async (client) => {
        const lockedUser = await client.queryOne<UserRow>(
          "SELECT * FROM users WHERE id = ? FOR UPDATE",
          [candidate.id]
        );
        const passwordMatches = await verifyPassword(
          password,
          lockedUser?.password_hash ?? (await dummyPasswordHash)
        );
        if (!lockedUser) return { user: undefined, decision: "DENIED" as const };

        const decision = await evaluatePasswordLogin(client, lockedUser.id, passwordMatches);
        if (decision !== "ALLOWED") await recordLoginAttempt(lockedUser.id, sourceIp, "FAILURE", client);
        return { user: lockedUser, decision };
      });
      user = result.user;
      passwordDecision = result.decision;
    }

    if (!user || passwordDecision !== "ALLOWED") {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid ID or password");
    }

    const methods = await getMfaMethods(user.id);
    if (methods.totp || methods.passkey) {
      const mfaToken = await createMfaLoginSession(user.id, sourceIp);
      res.locals.authenticationPending = true;
      clearAuthSessionCookie(res);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        mfaRequired: true,
        mfaToken,
        methods,
        expiresInSeconds: 300
      });
      return;
    }

    await recordLoginAttempt(user.id, sourceIp, "SUCCESS");
    const token = signAuthToken({ sub: user.id, username: user.username, authVersion: normalizeAuthVersion(user.auth_version) });
    setAuthSessionCookie(res, token);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/logout", requireAuth, async (req, res, next) => {
  try {
    const currentUser = requireUser(req.user);
    const revokedUser = await transaction(async (client) => {
      const user = await client.queryOne<UserRow>("SELECT * FROM users WHERE id = ? FOR UPDATE", [currentUser.id]);
      if (!user) throw new ApiError(401, "UNAUTHENTICATED", "User no longer exists");

      const authVersion = normalizeAuthVersion(user.auth_version) + 1;
      await client.execute("UPDATE users SET auth_version = ? WHERE id = ?", [authVersion, user.id]);
      await client.execute("DELETE FROM mfa_login_sessions WHERE user_id = ?", [user.id]);
      await client.execute("DELETE FROM webauthn_challenges WHERE user_id = ?", [user.id]);
      return { ...user, auth_version: authVersion };
    });

    disconnectUserCollaborators(revokedUser.id, "User logged out");
    clearAuthSessionCookie(res);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = requireUser(req.user);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ user });
});

authRouter.get(
  "/login-history",
  requireAuth,
  validate({ query: loginHistoryQuerySchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const { months } = getValidatedQuery<z.infer<typeof loginHistoryQuerySchema>>(req);
      const history = await listLoginAttempts(user.id, months);
      res.setHeader("Cache-Control", "private, no-store");
      res.json(history);
    } catch (error) {
      next(error);
    }
  }
);

authRouter.patch("/profile", requireAuth, validate({ body: profileSchema }), async (req, res, next) => {
  try {
    const currentUser = requireUser(req.user);
    const body = req.body as z.infer<typeof profileSchema>;
    const fields: string[] = [];
    const values: DbValue[] = [];

    if (body.name !== undefined) {
      fields.push("name = ?");
      values.push(body.name || null);
    }
    if (body.avatarData !== undefined) {
      fields.push("avatar_data = ?");
      values.push(normalizeAvatarDataUrl(body.avatarData));
    }
    if (body.preferredLanguage !== undefined) {
      fields.push("preferred_language = ?");
      values.push(body.preferredLanguage);
    }
    if (body.defaultCollectionIcon !== undefined) {
      fields.push("default_collection_icon = ?");
      values.push(normalizeIconValue(body.defaultCollectionIcon));
    }

    await db.execute(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, [...values, currentUser.id]);
    const user = await db.queryOne<UserRow>("SELECT * FROM users WHERE id = ?", [currentUser.id]);
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");

    res.json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/password", requireAuth, validate({ body: passwordSchema }), async (req, res, next) => {
  try {
    const currentUser = requireUser(req.user);
    const { currentPassword, newPassword } = req.body as z.infer<typeof passwordSchema>;
    const passwordHash = await hashPassword(newPassword);
    const updatedUser = await transaction(async (client) => {
      const user = await client.queryOne<UserRow>(
        "SELECT * FROM users WHERE id = ? FOR UPDATE",
        [currentUser.id]
      );
      if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
        throw new ApiError(400, "CURRENT_PASSWORD_INCORRECT", "Current password is incorrect");
      }
      if (await verifyPassword(newPassword, user.password_hash)) {
        throw new ApiError(400, "NEW_PASSWORD_SAME", "New password must differ from the current password");
      }

      const authVersion = normalizeAuthVersion(user.auth_version) + 1;
      await client.execute(
        "UPDATE users SET password_hash = ?, auth_version = ? WHERE id = ?",
        [passwordHash, authVersion, user.id]
      );
      await client.execute("DELETE FROM mfa_login_sessions WHERE user_id = ?", [user.id]);
      await client.execute("DELETE FROM webauthn_challenges WHERE user_id = ?", [user.id]);
      return { ...user, password_hash: passwordHash, auth_version: authVersion };
    });

    disconnectUserCollaborators(updatedUser.id, "Authentication credentials changed");
    const token = signAuthToken({
      sub: updatedUser.id,
      username: updatedUser.username,
      authVersion: normalizeAuthVersion(updatedUser.auth_version)
    });
    setAuthSessionCookie(res, token);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});


authRouter.use("/mfa", mfaRouter);
