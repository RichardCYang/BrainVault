import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";
import { BoundedRateLimitStore } from "../lib/bounded-rate-limit-store.js";

function clientIpKey(req: Request) {
  return ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown");
}

function hashRateLimitKey(prefix: string, value: string) {
  return `${prefix}:${createHash("sha256").update(value.slice(0, 256), "utf8").digest("hex")}`;
}

function usernameKey(req: Request) {
  const ip = clientIpKey(req);
  const raw = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  if (!raw) return `login-account-ip:${ip}`;
  // This is intentionally account-wide across source networks. The short
  // loginIpRateLimit remains the independent per-source control.
  return hashRateLimitKey("account", raw);
}

function mfaTokenKey(req: Request) {
  const token = req.body?.mfaToken;
  // Malformed anonymous input must neither access the database nor create a
  // distinct key. The request schema rejects it after source admission.
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? hashRateLimitKey("mfa-token", token)
    : `mfa-invalid:${clientIpKey(req)}`;
}

function mfaAccountKey(_req: Request, res: Response) {
  // Set only after a live, source- and ceremony-bound session was read by the
  // route middleware. Never trust a client-supplied user ID or query here.
  const userId = res.locals.mfaLoginSession?.user_id;
  if (typeof userId !== "string" || !userId) throw new Error("Verified MFA session required");
  return hashRateLimitKey("mfa-account", userId);
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

function collaborationSessionPageKey(req: Request) {
  const userId = typeof req.user?.id === "string" ? req.user.id : "";
  const pageId = typeof req.params?.pageId === "string" ? req.params.pageId : "";
  return userId && pageId
    ? hashRateLimitKey("collaboration-session-page", `${userId}:${pageId}`)
    : `ip:${clientIpKey(req)}`;
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
  store: new BoundedRateLimitStore(),
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
  store: new BoundedRateLimitStore(),
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
  store: new BoundedRateLimitStore(),
  windowMs: env.AUTH_PASSKEY_OPTIONS_IP_WINDOW_MS,
  limit: env.AUTH_PASSKEY_OPTIONS_IP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  handler
});

export const passkeyLoginVerifyIpRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
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
  store: new BoundedRateLimitStore(),
  windowMs: env.AUTH_MFA_IP_WINDOW_MS,
  limit: env.AUTH_MFA_IP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: clientIpKey,
  handler
});

export const mfaLoginAccountRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
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
  store: new BoundedRateLimitStore(),
  windowMs: env.AUTH_MFA_IP_WINDOW_MS,
  limit: env.AUTH_MFA_IP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  handler
});

export const mfaLoginOptionsAccountRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: env.AUTH_MFA_ACCOUNT_WINDOW_MS,
  limit: env.AUTH_MFA_ACCOUNT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: mfaAccountKey,
  handler
});

export const accountReauthenticationRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: env.AUTH_MFA_SETUP_WINDOW_MS,
  limit: env.AUTH_MFA_SETUP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: accountReauthenticationKey,
  handler
});

export const mfaSetupRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: env.AUTH_MFA_SETUP_WINDOW_MS,
  limit: env.AUTH_MFA_SETUP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: mfaSetupAccountKey,
  handler
});

export const registrationGlobalRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: env.AUTH_REGISTER_WINDOW_MS,
  limit: env.AUTH_REGISTER_GLOBAL_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: () => "registration-global",
  handler
});

export const registrationRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
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
  store: new BoundedRateLimitStore(),
  windowMs: env.COLLABORATION_SHARE_WINDOW_MS,
  limit: env.COLLABORATION_SHARE_IP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  handler: collaborationShareHandler
});

export const collaborationShareAccountRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: env.COLLABORATION_SHARE_WINDOW_MS,
  limit: env.COLLABORATION_SHARE_ACCOUNT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => authenticatedAccountKey("page-share-account", req),
  handler: collaborationShareHandler
});

export const collaborationSessionPageRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: env.COLLABORATION_SESSION_WINDOW_MS,
  limit: env.COLLABORATION_SESSION_PAGE_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: collaborationSessionPageKey,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: {
        code: "COLLABORATION_SESSION_RATE_LIMITED",
        message: "Too many collaboration reconnect attempts. Try again shortly."
      }
    });
  }
});

export const navigationOrderRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
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


// This admission gate precedes the live-session lookup. Account-wide budgets
// remain separate and are applied after the single authenticated session read.
export const mfaLoginTokenRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: env.AUTH_MFA_ACCOUNT_WINDOW_MS,
  limit: env.AUTH_MFA_ACCOUNT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: mfaTokenKey,
  handler
});

export const loginLockoutRecoveryRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: env.AUTH_LOGIN_IP_WINDOW_MS,
  limit: 3,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => authenticatedAccountKey("login-lockout-recovery", req),
  handler
});

// Only call after an independently authenticated recovery operation. Never
// reset the shared per-IP failure budget (other accounts may use that IP).
export async function clearPasswordLoginAccountLimit(username: string): Promise<void> {
  const normalized = username.trim().toLowerCase();
  if (normalized) await loginAccountRateLimit.resetKey(hashRateLimitKey("account", normalized));
}
