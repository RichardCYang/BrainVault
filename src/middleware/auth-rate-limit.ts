import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";
import { db } from "../lib/db.js";
import { hashOpaqueToken } from "../lib/mfa.js";

function clientIpKey(req: Request) {
  return ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown");
}

function hashRateLimitKey(prefix: string, value: string) {
  return `${prefix}:${createHash("sha256").update(value.slice(0, 256), "utf8").digest("hex")}`;
}

const maxDistinctLoginAccountKeysPerIpWindow = 50;
const maxTrackedLoginAccountIpNamespaces = 1_024;

type LoginAccountKeyNamespace = {
  expiresAt: number;
  accountKeys: Set<string>;
};

const loginAccountKeysByIp = new Map<string, LoginAccountKeyNamespace>();

function pruneExpiredLoginAccountKeyNamespaces(now: number) {
  for (const [ip, namespace] of loginAccountKeysByIp) {
    if (namespace.expiresAt <= now) loginAccountKeysByIp.delete(ip);
  }
}

function loginAccountOverflowKey(ip: string, now: number) {
  const bucket = Math.floor(now / Math.max(1, env.AUTH_LOGIN_IP_WINDOW_MS));
  return hashRateLimitKey("login-account-overflow", `${ip}:${bucket}`);
}

function usernameKey(req: Request) {
  const ip = clientIpKey(req);
  const raw = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  if (!raw) return `login-account-ip:${ip}`;

  const accountKey = hashRateLimitKey("account", raw);
  const now = Date.now();
  let namespace = loginAccountKeysByIp.get(ip);
  if (namespace && namespace.expiresAt <= now) {
    loginAccountKeysByIp.delete(ip);
    namespace = undefined;
  }

  if (!namespace) {
    if (loginAccountKeysByIp.size >= maxTrackedLoginAccountIpNamespaces) {
      pruneExpiredLoginAccountKeyNamespaces(now);
    }
    if (loginAccountKeysByIp.size >= maxTrackedLoginAccountIpNamespaces) {
      return loginAccountOverflowKey(ip, now);
    }
    namespace = {
      expiresAt: now + env.AUTH_LOGIN_ACCOUNT_WINDOW_MS,
      accountKeys: new Set<string>()
    };
    loginAccountKeysByIp.set(ip, namespace);
  }

  if (namespace.accountKeys.has(accountKey)) return accountKey;
  if (namespace.accountKeys.size >= maxDistinctLoginAccountKeysPerIpWindow) {
    return loginAccountOverflowKey(ip, now);
  }

  namespace.accountKeys.add(accountKey);
  return accountKey;
}

async function mfaAccountKey(req: Request) {
  const mfaToken = typeof req.body?.mfaToken === "string" ? req.body.mfaToken.trim() : "";
  if (!mfaToken) return `ip:${clientIpKey(req)}`;

  const row = await db.queryOne<{ user_id: string }>(
    "SELECT user_id FROM mfa_login_sessions WHERE token_hash = ?",
    [hashOpaqueToken(mfaToken)]
  );
  return row?.user_id
    ? hashRateLimitKey("mfa-account", row.user_id)
    : hashRateLimitKey("mfa-token", mfaToken);
}

function accountReauthenticationKey(req: Request) {
  const userId = typeof req.user?.id === "string" ? req.user.id : "";
  return userId ? hashRateLimitKey("account-reauthentication", userId) : `ip:${clientIpKey(req)}`;
}

function mfaSetupAccountKey(req: Request) {
  const userId = typeof req.user?.id === "string" ? req.user.id : "";
  return userId ? hashRateLimitKey("mfa-setup", userId) : `ip:${clientIpKey(req)}`;
}

function authenticatedAccountKey(scope: string, req: Request) {
  const userId = typeof req.user?.id === "string" ? req.user.id : "";
  return userId ? hashRateLimitKey(scope, userId) : `ip:${clientIpKey(req)}`;
}

function authenticationRequestSucceeded(_req: Request, res: Response) {
  return res.statusCode < 400 && res.locals.authenticationPending !== true;
}

const handler = (_req: Request, res: Response) => {
  res.status(429).json({
    error: {
      code: "RATE_LIMITED",
      message: "Too many authentication attempts. Try again later."
    }
  });
};

export const loginIpRateLimit = rateLimit({
  windowMs: env.AUTH_LOGIN_IP_WINDOW_MS,
  limit: env.AUTH_LOGIN_IP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: authenticationRequestSucceeded,
  keyGenerator: clientIpKey,
  handler
});

export const loginAccountRateLimit = rateLimit({
  windowMs: env.AUTH_LOGIN_ACCOUNT_WINDOW_MS,
  limit: env.AUTH_LOGIN_ACCOUNT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: authenticationRequestSucceeded,
  keyGenerator: usernameKey,
  handler
});

export const passkeyLoginOptionsIpRateLimit = rateLimit({
  windowMs: env.AUTH_PASSKEY_OPTIONS_IP_WINDOW_MS,
  limit: env.AUTH_PASSKEY_OPTIONS_IP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  handler
});

export const passkeyLoginVerifyIpRateLimit = rateLimit({
  windowMs: env.AUTH_PASSKEY_VERIFY_IP_WINDOW_MS,
  limit: env.AUTH_PASSKEY_VERIFY_IP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: authenticationRequestSucceeded,
  keyGenerator: clientIpKey,
  handler
});

export const mfaLoginIpRateLimit = rateLimit({
  windowMs: env.AUTH_MFA_IP_WINDOW_MS,
  limit: env.AUTH_MFA_IP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: clientIpKey,
  handler
});

export const mfaLoginAccountRateLimit = rateLimit({
  windowMs: env.AUTH_MFA_ACCOUNT_WINDOW_MS,
  limit: env.AUTH_MFA_ACCOUNT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: mfaAccountKey,
  handler
});

// Passkey option generation is still part of an unfinished MFA ceremony, so
// successful option responses must consume the same MFA request budget instead
// of being removed by skipSuccessfulRequests.
export const mfaLoginOptionsIpRateLimit = rateLimit({
  windowMs: env.AUTH_MFA_IP_WINDOW_MS,
  limit: env.AUTH_MFA_IP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  handler
});

export const mfaLoginOptionsAccountRateLimit = rateLimit({
  windowMs: env.AUTH_MFA_ACCOUNT_WINDOW_MS,
  limit: env.AUTH_MFA_ACCOUNT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: mfaAccountKey,
  handler
});

export const accountReauthenticationRateLimit = rateLimit({
  windowMs: env.AUTH_MFA_SETUP_WINDOW_MS,
  limit: env.AUTH_MFA_SETUP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: accountReauthenticationKey,
  handler
});

export const mfaSetupRateLimit = rateLimit({
  windowMs: env.AUTH_MFA_SETUP_WINDOW_MS,
  limit: env.AUTH_MFA_SETUP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: mfaSetupAccountKey,
  handler
});

export const registrationGlobalRateLimit = rateLimit({
  windowMs: env.AUTH_REGISTER_WINDOW_MS,
  limit: env.AUTH_REGISTER_GLOBAL_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: () => "registration-global",
  handler
});

export const registrationRateLimit = rateLimit({
  windowMs: env.AUTH_REGISTER_WINDOW_MS,
  limit: env.AUTH_REGISTER_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  handler
});

const collaborationShareHandler = (_req: Request, res: Response) => {
  res.status(429).json({
    error: {
      code: "PAGE_SHARE_RATE_LIMITED",
      message: "Too many page sharing requests. Try again later."
    }
  });
};

export const collaborationShareIpRateLimit = rateLimit({
  windowMs: env.COLLABORATION_SHARE_WINDOW_MS,
  limit: env.COLLABORATION_SHARE_IP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  handler: collaborationShareHandler
});

export const collaborationShareAccountRateLimit = rateLimit({
  windowMs: env.COLLABORATION_SHARE_WINDOW_MS,
  limit: env.COLLABORATION_SHARE_ACCOUNT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => authenticatedAccountKey("page-share-account", req),
  handler: collaborationShareHandler
});

export const navigationOrderRateLimit = rateLimit({
  windowMs: env.NAVIGATION_ORDER_WINDOW_MS,
  limit: env.NAVIGATION_ORDER_ACCOUNT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => authenticatedAccountKey("navigation-order-account", req),
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: {
        code: "NAVIGATION_ORDER_RATE_LIMITED",
        message: "Too many navigation order updates. Try again later."
      }
    });
  }
});

