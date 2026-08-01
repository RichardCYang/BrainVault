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

function usernameKey(req: Request) {
  const raw = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  if (!raw) return `ip:${clientIpKey(req)}`;
  return hashRateLimitKey("account", raw);
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

function mfaSetupAccountKey(req: Request) {
  const userId = typeof req.user?.id === "string" ? req.user.id : "";
  return userId ? hashRateLimitKey("mfa-setup", userId) : `ip:${clientIpKey(req)}`;
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
