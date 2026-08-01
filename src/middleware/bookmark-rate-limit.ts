import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";

function bookmarkPreviewKey(req: Request) {
  const userId = typeof req.user?.id === "string" ? req.user.id : "";
  if (userId) {
    return `bookmark-user:${createHash("sha256").update(userId, "utf8").digest("hex")}`;
  }
  return `bookmark-ip:${ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown")}`;
}

const handler = (_req: Request, res: Response) => {
  res.status(429).json({
    error: {
      code: "BOOKMARK_PREVIEW_RATE_LIMITED",
      message: "Too many bookmark preview requests. Try again later."
    }
  });
};

export const bookmarkPreviewRateLimit = rateLimit({
  windowMs: env.BOOKMARK_PREVIEW_WINDOW_MS,
  limit: env.BOOKMARK_PREVIEW_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: bookmarkPreviewKey,
  handler
});
