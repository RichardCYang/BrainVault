import { randomInt } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { db, transaction, type DbValue } from "../lib/db.js";
import { createId } from "../lib/id.js";
import { hashPassword, normalizeAuthVersion, signAuthToken, verifyPassword } from "../lib/auth.js";
import { disconnectUserCollaborators } from "../lib/collaboration-server.js";
import { ApiError } from "../lib/http.js";
import { iconMutationValueSchema, normalizeIconValue } from "../lib/icon-value.js";
import { evaluatePasswordLogin } from "../lib/login-lockout.js";
import {
  assertPolicyAllowsCurrentLocation,
  countryLoginModes,
  defaultCountryBlockHistoryMonths,
  enforceCountryLoginPolicy,
  getCountryLoginPolicy,
  listCountryLoginBlocks,
  maxCountryBlockHistoryMonths,
  normalizeCountryLoginMode,
  resolveCountryLoginLocation
} from "../lib/country-login-policy.js";
import { normalizeIsoCountryCode } from "../lib/country-codes.js";
import {
  assertVpnPolicyAllowsCurrentConnection,
  enforceVpnAccessPolicy,
  getClientTimeZone,
  getClientWebRtcSignal,
  normalizeVpnBlockEnabled,
  resolveVpnAccessRisk
} from "../lib/vpn-access-policy.js";
import {
  defaultLoginHistoryMonths,
  getClientIpAddress,
  listLoginAttempts,
  maxLoginHistoryMonths,
  recordLoginAttempt
} from "../lib/login-history.js";
import {
  defaultTotpIpBlockThreshold,
  getTotpIpBlockPolicy,
  listPermanentTotpIpBlocks,
  maxTotpIpBlockThreshold,
  minTotpIpBlockThreshold,
  normalizeTotpBlockIpAddress,
  isPermanentlyBlockedTotpIp
} from "../lib/totp-ip-block.js";
import { toPublicUser } from "../lib/mappers.js";
import { clearAuthSessionCookie, setAuthSessionCookie } from "../lib/session-cookie.js";
import {
  maxAvatarBytes,
  normalizeAvatarDataUrl,
  supportedProfileLanguages,
  supportedProfileThemes
} from "../lib/profile.js";
import {
  requireAuth,
  requireAuthAllowTotpIpBlock,
  requireJsonRequestBody,
  requireSameOriginBrowserRequest
} from "../middleware/auth.js";
import {
  accountReauthenticationRateLimit,
  loginAccountRateLimit,
  loginIpRateLimit,
  registrationGlobalRateLimit,
  registrationRateLimit
} from "../middleware/auth-rate-limit.js";
import { getValidatedQuery, validate } from "../middleware/validate.js";
import { passwordInputSchema, requireUser, usernameSchema } from "../utils/schemas.js";
import type { UserRow } from "../types/domain.js";
import { createMfaLoginSession, getMfaMethods, mfaRouter } from "./mfa.routes.js";
import { passkeyLoginRouter } from "./passkey-login.routes.js";

export const authRouter = Router();

const dummyPasswordHash = hashPassword("brainvault-invalid-user-password");
const preferredLanguageSchema = z.enum(supportedProfileLanguages);
const profileThemeSchema = z.enum(supportedProfileThemes);

const registerSchema = z.object({
  username: usernameSchema,
  password: passwordInputSchema(8),
  name: z.string().trim().min(1).max(80).optional(),
  preferredLanguage: preferredLanguageSchema.optional()
});

const loginSchema = z.object({
  username: usernameSchema,
  password: passwordInputSchema(1)
});

const profileSchema = z
  .object({
    name: z.string().trim().max(80).nullable().optional(),
    avatarData: z.string().max(Math.ceil((maxAvatarBytes * 4) / 3) + 128).nullable().optional(),
    preferredLanguage: preferredLanguageSchema.nullable().optional(),
    defaultCollectionIcon: iconMutationValueSchema.nullable().optional(),
    theme: profileThemeSchema.optional()
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "At least one profile field is required"
  });

const loginHistoryQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(maxLoginHistoryMonths).default(defaultLoginHistoryMonths)
});

const countryBlockHistoryQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(maxCountryBlockHistoryMonths).default(defaultCountryBlockHistoryMonths)
});

const vpnBlockPolicySchema = z.object({
  currentPassword: passwordInputSchema(1),
  enabled: z.boolean()
});

const totpIpBlockPolicySchema = z.object({
  currentPassword: passwordInputSchema(1),
  enabled: z.boolean(),
  maxAttempts: z.coerce.number().int().min(minTotpIpBlockThreshold).max(maxTotpIpBlockThreshold)
});

const totpIpBlockParamsSchema = z.object({
  ipAddress: z.string().trim().min(2).max(64)
    .transform((value) => normalizeTotpBlockIpAddress(value))
    .refine((value) => value !== "unknown", "Invalid IP address")
});

const totpIpUnblockSchema = z.object({
  currentPassword: passwordInputSchema(1)
});

const countryLoginPolicySchema = z
  .object({
    currentPassword: passwordInputSchema(1),
    mode: z.enum(countryLoginModes),
    countries: z.array(
      z.string()
        .transform((value) => value.trim().toUpperCase())
        .refine((value) => Boolean(normalizeIsoCountryCode(value)), "Invalid ISO country code")
    ).max(249)
  })
  .superRefine((value, context) => {
    if (new Set(value.countries).size !== value.countries.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["countries"],
        message: "Country codes must be unique"
      });
    }
    if (value.mode !== "OFF" && value.countries.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["countries"],
        message: "At least one country is required when the policy is enabled"
      });
    }
  });

const navigationPreferenceSchema = z.object({
  pageId: z.string().min(1).max(64),
  collapsed: z.boolean()
});

const navigationOrderSchema = z.object({
  pageIds: z.array(z.string().min(1).max(64)).min(1).max(20_000)
}).superRefine((value, context) => {
  if (new Set(value.pageIds).size !== value.pageIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pageIds"],
      message: "Page ids must be unique"
    });
  }
});

const passwordSchema = z
  .object({
    currentPassword: passwordInputSchema(1),
    newPassword: passwordInputSchema(8)
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    path: ["newPassword"],
    message: "New password must differ from the current password"
  });

function requireRequestAuthVersion(req: { auth?: { authVersion: number } }) {
  const authVersion = Number(req.auth?.authVersion);
  if (!Number.isSafeInteger(authVersion) || authVersion < 1) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication context is missing");
  }
  return authVersion;
}

function assertAuthenticationVersion(user: UserRow, expectedAuthVersion: number) {
  if (normalizeAuthVersion(user.auth_version) !== expectedAuthVersion) {
    throw new ApiError(401, "SESSION_REVOKED", "This authentication session is no longer valid");
  }
}

function isDuplicateEntryError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";
}

async function padRegistrationResponse(startedAt: number) {
  const targetDurationMs = 350 + randomInt(0, 76);
  const remainingMs = targetDurationMs - (Date.now() - startedAt);
  if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
}

async function padFailedLoginResponse(startedAt: number) {
  const targetDurationMs = 500 + randomInt(0, 101);
  const remainingMs = targetDurationMs - (Date.now() - startedAt);
  if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
}

authRouter.post(
  "/register",
  requireSameOriginBrowserRequest,
  requireJsonRequestBody,
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

authRouter.post(
  "/login",
  requireSameOriginBrowserRequest,
  requireJsonRequestBody,
  loginIpRateLimit,
  loginAccountRateLimit,
  validate({ body: loginSchema }),
  async (req, res, next) => {
    try {
      const startedAt = Date.now();
      const { username, password } = req.body as z.infer<typeof loginSchema>;
      const sourceIp = getClientIpAddress(req);
      const candidate = await db.queryOne<UserRow>("SELECT * FROM users WHERE username = ?", [username]);
      let user: UserRow | undefined;
      let passwordDecision: "ALLOWED" | "DENIED" | "LOCKED" = "DENIED";

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
          if (decision !== "ALLOWED") {
            await recordLoginAttempt(lockedUser.id, sourceIp, decision === "LOCKED" ? "LOCKED" : "FAILURE", client);
          }
          return { user: lockedUser, decision };
        });
        user = result.user;
        passwordDecision = result.decision;
      }

      if (!user || passwordDecision !== "ALLOWED") {
        await padFailedLoginResponse(startedAt);
        throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid ID or password");
      }
      if (await isPermanentlyBlockedTotpIp(sourceIp, user.id)) {
        throw new ApiError(
          403,
          "TOTP_IP_PERMANENTLY_BLOCKED",
          "Access from this IP address is temporarily blocked for this account"
        );
      }

      await enforceCountryLoginPolicy(user.id, user.country_login_mode, sourceIp);
      await enforceVpnAccessPolicy(
        user.id,
        user.vpn_block_enabled,
        sourceIp,
        getClientTimeZone(req),
        getClientWebRtcSignal(req)
      );

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
  }
);

authRouter.post("/logout", requireAuth, async (req, res, next) => {
  try {
    const currentUser = requireUser(req.user);
    const expectedAuthVersion = requireRequestAuthVersion(req);
    const revokedUser = await transaction(async (client) => {
      const user = await client.queryOne<UserRow>("SELECT * FROM users WHERE id = ? FOR UPDATE", [currentUser.id]);
      if (!user) throw new ApiError(401, "UNAUTHENTICATED", "User no longer exists");
      assertAuthenticationVersion(user, expectedAuthVersion);

      const authVersion = normalizeAuthVersion(user.auth_version) + 1;
      await client.execute("UPDATE users SET auth_version = ? WHERE id = ?", [authVersion, user.id]);
      await client.execute("DELETE FROM mfa_login_sessions WHERE user_id = ?", [user.id]);
      await client.execute("DELETE FROM webauthn_challenges WHERE user_id = ?", [user.id]);
      await client.execute("DELETE FROM mfa_totp_setups WHERE user_id = ?", [user.id]);
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

authRouter.get("/navigation-preferences", requireAuth, async (req, res, next) => {
  try {
    const currentUser = requireUser(req.user);
    const [collapsedRows, orderRows] = await Promise.all([
      db.query<{ page_id: string }>(
        `SELECT page_id
         FROM user_navigation_collapsed_pages
         WHERE user_id = ?
         ORDER BY page_id`,
        [currentUser.id]
      ),
      db.query<{ page_id: string; sort_order: number }>(
        `SELECT no.page_id, no.sort_order
         FROM user_navigation_page_order no
         INNER JOIN pages p ON p.id = no.page_id
         WHERE no.user_id = ?
           AND (p.owner_id = ? OR EXISTS (
             SELECT 1 FROM page_shares ps
             WHERE ps.page_id = p.id AND ps.user_id = ? AND ps.permission = 'EDIT'
           ))
         ORDER BY no.sort_order ASC, no.page_id ASC`,
        [currentUser.id, currentUser.id, currentUser.id]
      )
    ]);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      collapsedPageIds: collapsedRows.map((row) => row.page_id),
      navigationPageOrder: orderRows.map((row) => ({ pageId: row.page_id, sortOrder: Number(row.sort_order) }))
    });
  } catch (error) {
    next(error);
  }
});

authRouter.patch(
  "/navigation-preferences",
  requireAuth,
  validate({ body: navigationPreferenceSchema }),
  async (req, res, next) => {
    try {
      const currentUser = requireUser(req.user);
      const { pageId, collapsed } = req.body as z.infer<typeof navigationPreferenceSchema>;
      await transaction(async (client) => {
        // Backup/restore uses the same per-user row lock. Serializing preference
        // mutations with that lock prevents a collapse/expand write from landing
        // between the backup snapshot and its archived navigation state.
        const lockedUser = await client.queryOne<{ id: string }>(
          "SELECT id FROM users WHERE id = ? FOR UPDATE",
          [currentUser.id]
        );
        if (!lockedUser) throw new ApiError(404, "NOT_FOUND", "User not found");

        const page = await client.queryOne<{ id: string }>(
          `SELECT p.id
           FROM pages p
           LEFT JOIN page_shares ps
             ON ps.page_id = p.id AND ps.user_id = ? AND ps.permission = 'EDIT'
           WHERE p.id = ? AND (p.owner_id = ? OR ps.user_id IS NOT NULL)
           LIMIT 1`,
          [currentUser.id, pageId, currentUser.id]
        );
        if (!page) throw new ApiError(404, "NOT_FOUND", "Page not found");

        if (collapsed) {
          await client.execute(
            `INSERT IGNORE INTO user_navigation_collapsed_pages (user_id, page_id)
             VALUES (?, ?)`,
            [currentUser.id, pageId]
          );
        } else {
          await client.execute(
            "DELETE FROM user_navigation_collapsed_pages WHERE user_id = ? AND page_id = ?",
            [currentUser.id, pageId]
          );
        }
      });

      res.setHeader("Cache-Control", "private, no-store");
      res.json({ pageId, collapsed });
    } catch (error) {
      next(error);
    }
  }
);


authRouter.patch(
  "/navigation-order",
  requireAuth,
  validate({ body: navigationOrderSchema }),
  async (req, res, next) => {
    try {
      const currentUser = requireUser(req.user);
      const { pageIds } = req.body as z.infer<typeof navigationOrderSchema>;
      await transaction(async (client) => {
        // Serialize navigation mutations with backup/restore snapshots. The order
        // table is preference-only and never updates page or block content rows.
        const lockedUser = await client.queryOne<{ id: string }>(
          "SELECT id FROM users WHERE id = ? FOR UPDATE",
          [currentUser.id]
        );
        if (!lockedUser) throw new ApiError(404, "NOT_FOUND", "User not found");

        const accessibleRows = await client.query<{ id: string }>(
          `SELECT p.id
           FROM pages p
           WHERE p.is_archived = 0
             AND (p.owner_id = ? OR EXISTS (
               SELECT 1 FROM page_shares ps
               WHERE ps.page_id = p.id AND ps.user_id = ? AND ps.permission = 'EDIT'
             ))
           ORDER BY p.id ASC`,
          [currentUser.id, currentUser.id]
        );
        const accessibleIds = new Set(accessibleRows.map((row) => row.id));
        if (pageIds.some((pageId) => !accessibleIds.has(pageId))) {
          throw new ApiError(404, "NOT_FOUND", "Page not found");
        }

        const chunkSize = 250;
        for (let offset = 0; offset < pageIds.length; offset += chunkSize) {
          const chunk = pageIds.slice(offset, offset + chunkSize);
          const values = chunk.map(() => "(?, ?, ?)").join(", ");
          const params: DbValue[] = [];
          chunk.forEach((pageId, index) => {
            params.push(currentUser.id, pageId, offset + index);
          });
          await client.execute(
            `INSERT INTO user_navigation_page_order (user_id, page_id, sort_order)
             VALUES ${values}
             ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order), updated_at = CURRENT_TIMESTAMP(3)`,
            params
          );
        }
      });

      res.setHeader("Cache-Control", "private, no-store");
      res.json({ pageIds });
    } catch (error) {
      next(error);
    }
  }
);

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

authRouter.get(
  "/block-history",
  requireAuth,
  validate({ query: countryBlockHistoryQuerySchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const { months } = getValidatedQuery<z.infer<typeof countryBlockHistoryQuerySchema>>(req);
      const history = await listCountryLoginBlocks(user.id, months);
      res.setHeader("Cache-Control", "private, no-store");
      res.json(history);
    } catch (error) {
      next(error);
    }
  }
);

authRouter.get("/totp-ip-block-policy", requireAuth, async (req, res, next) => {
  try {
    const currentUser = requireUser(req.user);
    const policy = await getTotpIpBlockPolicy(currentUser.id);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      enabled: policy.enabled,
      maxAttempts: policy.maxAttempts,
      defaultMaxAttempts: defaultTotpIpBlockThreshold,
      minAttempts: minTotpIpBlockThreshold,
      maxAllowedAttempts: maxTotpIpBlockThreshold,
      currentIp: getClientIpAddress(req)
    });
  } catch (error) {
    next(error);
  }
});

authRouter.put(
  "/totp-ip-block-policy",
  requireAuth,
  accountReauthenticationRateLimit,
  validate({ body: totpIpBlockPolicySchema }),
  async (req, res, next) => {
    try {
      const currentUser = requireUser(req.user);
      const expectedAuthVersion = requireRequestAuthVersion(req);
      const { currentPassword, enabled, maxAttempts } = req.body as z.infer<typeof totpIpBlockPolicySchema>;

      const updatedUser = await transaction(async (client) => {
        const user = await client.queryOne<UserRow>(
          "SELECT * FROM users WHERE id = ? FOR UPDATE",
          [currentUser.id]
        );
        if (!user) throw new ApiError(401, "UNAUTHENTICATED", "User no longer exists");
        assertAuthenticationVersion(user, expectedAuthVersion);
        if (!(await verifyPassword(currentPassword, user.password_hash))) {
          throw new ApiError(400, "CURRENT_PASSWORD_INCORRECT", "Current password is incorrect");
        }

        const authVersion = normalizeAuthVersion(user.auth_version) + 1;
        await client.execute(
          `UPDATE users
           SET totp_ip_block_enabled = ?, totp_ip_block_threshold = ?, auth_version = ?
           WHERE id = ?`,
          [enabled ? 1 : 0, maxAttempts, authVersion, user.id]
        );
        // Changing the policy begins a fresh failure counter, but deliberately
        // does not remove active IP blocks. Those require explicit
        // manual unblocking from the separate blocked-IP list.
        await client.execute("DELETE FROM user_totp_ip_failures WHERE user_id = ?", [user.id]);
        await client.execute("DELETE FROM mfa_login_sessions WHERE user_id = ?", [user.id]);
        await client.execute("DELETE FROM webauthn_challenges WHERE user_id = ?", [user.id]);
        await client.execute("DELETE FROM mfa_totp_setups WHERE user_id = ?", [user.id]);
        return {
          ...user,
          totp_ip_block_enabled: enabled ? 1 : 0,
          totp_ip_block_threshold: maxAttempts,
          auth_version: authVersion
        };
      });

      disconnectUserCollaborators(updatedUser.id, "TOTP IP blocking policy changed");
      const token = signAuthToken({
        sub: updatedUser.id,
        username: updatedUser.username,
        authVersion: normalizeAuthVersion(updatedUser.auth_version)
      });
      setAuthSessionCookie(res, token);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        enabled,
        maxAttempts,
        defaultMaxAttempts: defaultTotpIpBlockThreshold,
        minAttempts: minTotpIpBlockThreshold,
        maxAllowedAttempts: maxTotpIpBlockThreshold,
        currentIp: getClientIpAddress(req)
      });
    } catch (error) {
      next(error);
    }
  }
);

authRouter.get("/totp-ip-blocks", requireAuth, async (req, res, next) => {
  try {
    const currentUser = requireUser(req.user);
    const result = await listPermanentTotpIpBlocks(currentUser.id);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.delete(
  "/totp-ip-blocks/:ipAddress",
  requireAuthAllowTotpIpBlock,
  accountReauthenticationRateLimit,
  validate({ params: totpIpBlockParamsSchema, body: totpIpUnblockSchema }),
  async (req, res, next) => {
    try {
      const currentUser = requireUser(req.user);
      const expectedAuthVersion = requireRequestAuthVersion(req);
      const { ipAddress } = req.params as z.infer<typeof totpIpBlockParamsSchema>;
      const { currentPassword } = req.body as z.infer<typeof totpIpUnblockSchema>;

      await transaction(async (client) => {
        const user = await client.queryOne<UserRow>(
          "SELECT * FROM users WHERE id = ? FOR UPDATE",
          [currentUser.id]
        );
        if (!user) throw new ApiError(401, "UNAUTHENTICATED", "User no longer exists");
        assertAuthenticationVersion(user, expectedAuthVersion);
        if (!(await verifyPassword(currentPassword, user.password_hash))) {
          throw new ApiError(400, "CURRENT_PASSWORD_INCORRECT", "Current password is incorrect");
        }

        const deleted = await client.execute<{ affectedRows: number }>(
          "DELETE FROM user_totp_ip_blocks WHERE user_id = ? AND ip_address = ?",
          [user.id, ipAddress]
        );
        if (Number(deleted.affectedRows) !== 1) {
          throw new ApiError(404, "TOTP_IP_BLOCK_NOT_FOUND", "TOTP IP block not found");
        }
        await client.execute(
          "DELETE FROM user_totp_ip_failures WHERE user_id = ? AND ip_address = ?",
          [user.id, ipAddress]
        );
      });

      res.setHeader("Cache-Control", "private, no-store");
      res.json({ ok: true, ipAddress });
    } catch (error) {
      next(error);
    }
  }
);

authRouter.get("/vpn-block-policy", requireAuth, async (req, res, next) => {
  try {
    const currentUser = requireUser(req.user);
    const row = await db.queryOne<{ vpn_block_enabled: unknown }>(
      "SELECT vpn_block_enabled FROM users WHERE id = ?",
      [currentUser.id]
    );
    if (!row) throw new ApiError(404, "NOT_FOUND", "User not found");

    const enabled = normalizeVpnBlockEnabled(row.vpn_block_enabled);
    const risk = await resolveVpnAccessRisk(
      getClientIpAddress(req),
      getClientTimeZone(req),
      getClientWebRtcSignal(req)
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      enabled,
      currentIp: risk.ipAddress || "unknown",
      currentCountryCode: risk.countryCode,
      verdict: risk.verdict,
      confidence: risk.confidence,
      datacenter: risk.datacenter,
      timezoneMismatch: risk.timezoneMismatch,
      providerCount: risk.providerCount,
      webRtcState: risk.webRtcState,
      webRtcObservedIps: risk.webRtcObservedIps,
      webRtcIpMismatch: risk.webRtcIpMismatch,
      supportingSignals: risk.supportingSignals
    });
  } catch (error) {
    next(error);
  }
});

authRouter.put(
  "/vpn-block-policy",
  requireAuth,
  accountReauthenticationRateLimit,
  validate({ body: vpnBlockPolicySchema }),
  async (req, res, next) => {
    try {
      const currentUser = requireUser(req.user);
      const expectedAuthVersion = requireRequestAuthVersion(req);
      const { currentPassword, enabled } = req.body as z.infer<typeof vpnBlockPolicySchema>;
      const sourceIp = getClientIpAddress(req);
      const clientTimeZone = getClientTimeZone(req);
      const risk = await assertVpnPolicyAllowsCurrentConnection(
        enabled,
        sourceIp,
        clientTimeZone,
        getClientWebRtcSignal(req)
      );

      const updatedUser = await transaction(async (client) => {
        const user = await client.queryOne<UserRow>(
          "SELECT * FROM users WHERE id = ? FOR UPDATE",
          [currentUser.id]
        );
        if (!user) throw new ApiError(401, "UNAUTHENTICATED", "User no longer exists");
        assertAuthenticationVersion(user, expectedAuthVersion);
        if (!(await verifyPassword(currentPassword, user.password_hash))) {
          throw new ApiError(400, "CURRENT_PASSWORD_INCORRECT", "Current password is incorrect");
        }

        const authVersion = normalizeAuthVersion(user.auth_version) + 1;
        await client.execute(
          "UPDATE users SET vpn_block_enabled = ?, auth_version = ? WHERE id = ?",
          [enabled ? 1 : 0, authVersion, user.id]
        );
        await client.execute("DELETE FROM mfa_login_sessions WHERE user_id = ?", [user.id]);
        await client.execute("DELETE FROM webauthn_challenges WHERE user_id = ?", [user.id]);
        await client.execute("DELETE FROM mfa_totp_setups WHERE user_id = ?", [user.id]);
        return { ...user, vpn_block_enabled: enabled ? 1 : 0, auth_version: authVersion };
      });

      disconnectUserCollaborators(updatedUser.id, "VPN access policy changed");
      const token = signAuthToken({
        sub: updatedUser.id,
        username: updatedUser.username,
        authVersion: normalizeAuthVersion(updatedUser.auth_version)
      });
      setAuthSessionCookie(res, token);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        enabled,
        currentIp: risk.ipAddress || sourceIp || "unknown",
        currentCountryCode: risk.countryCode,
        verdict: risk.verdict,
        confidence: risk.confidence,
        datacenter: risk.datacenter,
        timezoneMismatch: risk.timezoneMismatch,
        providerCount: risk.providerCount,
        webRtcState: risk.webRtcState,
        webRtcObservedIps: risk.webRtcObservedIps,
        webRtcIpMismatch: risk.webRtcIpMismatch,
        supportingSignals: risk.supportingSignals
      });
    } catch (error) {
      next(error);
    }
  }
);

authRouter.get("/country-login-policy", requireAuth, async (req, res, next) => {
  try {
    const currentUser = requireUser(req.user);
    const row = await db.queryOne<{ country_login_mode: unknown }>(
      "SELECT country_login_mode FROM users WHERE id = ?",
      [currentUser.id]
    );
    if (!row) throw new ApiError(404, "NOT_FOUND", "User not found");

    const policy = await getCountryLoginPolicy(currentUser.id, row.country_login_mode);
    const location = await resolveCountryLoginLocation(getClientIpAddress(req));
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      mode: policy.mode,
      countries: policy.countries,
      currentIp: location.ipAddress || "unknown",
      currentCountryCode: location.countryCode
    });
  } catch (error) {
    next(error);
  }
});

authRouter.put(
  "/country-login-policy",
  requireAuth,
  accountReauthenticationRateLimit,
  validate({ body: countryLoginPolicySchema }),
  async (req, res, next) => {
    try {
      const currentUser = requireUser(req.user);
      const expectedAuthVersion = requireRequestAuthVersion(req);
      const { currentPassword, mode: rawMode, countries: rawCountries } =
        req.body as z.infer<typeof countryLoginPolicySchema>;
      const mode = normalizeCountryLoginMode(rawMode);
      const countries = [...new Set(
        rawCountries
          .map((country) => normalizeIsoCountryCode(country))
          .filter((country): country is NonNullable<ReturnType<typeof normalizeIsoCountryCode>> => Boolean(country))
      )].sort();
      const sourceIp = getClientIpAddress(req);
      const location = mode === "OFF"
        ? { ipAddress: sourceIp, countryCode: null, resolved: false }
        : await assertPolicyAllowsCurrentLocation(mode, countries, sourceIp);

      const updatedUser = await transaction(async (client) => {
        const user = await client.queryOne<UserRow>(
          "SELECT * FROM users WHERE id = ? FOR UPDATE",
          [currentUser.id]
        );
        if (!user) throw new ApiError(401, "UNAUTHENTICATED", "User no longer exists");
        assertAuthenticationVersion(user, expectedAuthVersion);
        if (!(await verifyPassword(currentPassword, user.password_hash))) {
          throw new ApiError(400, "CURRENT_PASSWORD_INCORRECT", "Current password is incorrect");
        }

        const authVersion = normalizeAuthVersion(user.auth_version) + 1;
        await client.execute(
          "UPDATE users SET country_login_mode = ?, auth_version = ? WHERE id = ?",
          [mode, authVersion, user.id]
        );
        await client.execute("DELETE FROM user_country_login_countries WHERE user_id = ?", [user.id]);
        for (const countryCode of countries) {
          await client.execute(
            `INSERT INTO user_country_login_countries (user_id, country_code)
             VALUES (?, ?)`,
            [user.id, countryCode]
          );
        }
        await client.execute("DELETE FROM mfa_login_sessions WHERE user_id = ?", [user.id]);
        await client.execute("DELETE FROM webauthn_challenges WHERE user_id = ?", [user.id]);
        await client.execute("DELETE FROM mfa_totp_setups WHERE user_id = ?", [user.id]);
        return { ...user, country_login_mode: mode, auth_version: authVersion };
      });

      disconnectUserCollaborators(updatedUser.id, "Country login access policy changed");
      const token = signAuthToken({
        sub: updatedUser.id,
        username: updatedUser.username,
        authVersion: normalizeAuthVersion(updatedUser.auth_version)
      });
      setAuthSessionCookie(res, token);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        mode,
        countries,
        currentIp: location.ipAddress || sourceIp || "unknown",
        currentCountryCode: location.countryCode
      });
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
    if (body.theme !== undefined) {
      fields.push("theme = ?");
      values.push(body.theme);
    }

    await db.execute(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, [...values, currentUser.id]);
    const user = await db.queryOne<UserRow>("SELECT * FROM users WHERE id = ?", [currentUser.id]);
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");

    res.json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

authRouter.post(
  "/password",
  requireAuth,
  accountReauthenticationRateLimit,
  validate({ body: passwordSchema }),
  async (req, res, next) => {
    try {
      const currentUser = requireUser(req.user);
      const expectedAuthVersion = requireRequestAuthVersion(req);
      const { currentPassword, newPassword } = req.body as z.infer<typeof passwordSchema>;
      const passwordHash = await hashPassword(newPassword);
      const updatedUser = await transaction(async (client) => {
        const user = await client.queryOne<UserRow>(
          "SELECT * FROM users WHERE id = ? FOR UPDATE",
          [currentUser.id]
        );
        if (!user) throw new ApiError(401, "UNAUTHENTICATED", "User no longer exists");
        assertAuthenticationVersion(user, expectedAuthVersion);
        if (!(await verifyPassword(currentPassword, user.password_hash))) {
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
        await client.execute("DELETE FROM mfa_totp_setups WHERE user_id = ?", [user.id]);
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
  }
);


authRouter.use("/passkey", passkeyLoginRouter);
authRouter.use("/mfa", mfaRouter);
