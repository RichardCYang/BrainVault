import { createHash } from "node:crypto";
import type { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";

function clientIpKey(req: Request) {
  return ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown");
}

function usernameKey(req: Request) {
  const raw = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  if (!raw) return `ip:${clientIpKey(req)}`;
  return `account:${createHash("sha256").update(raw.slice(0, 128), "utf8").digest("hex")}`;
}

const handler = (_req: Request, res: import("express").Response) => {
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
  keyGenerator: clientIpKey,
  handler
});

export const loginAccountRateLimit = rateLimit({
  windowMs: env.AUTH_LOGIN_ACCOUNT_WINDOW_MS,
  limit: env.AUTH_LOGIN_ACCOUNT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: usernameKey,
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
