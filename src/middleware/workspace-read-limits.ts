import type { Response } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
import { BoundedRateLimitStore } from "../lib/bounded-rate-limit-store.js";
import { ApiError } from "../lib/http.js";
import { requireUser } from "../utils/schemas.js";

export const workspaceQueryRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: 60_000,
  limit: 120,
  keyGenerator: (req) => requireUser(req.user).id,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new ApiError(429, "WORKSPACE_QUERY_RATE_LIMITED", "Retry the workspace query shortly"))
});

const mediaBytes = new BoundedRateLimitStore();
mediaBytes.init({ windowMs: 60_000 });
const maxBytes = Math.max(256, env.MAX_ATTACHMENT_SIZE_MB) * 1024 * 1024;

export async function reserveMediaDownload(userId: string, bytes: number, res: Response) {
  const usage = await mediaBytes.increment(userId, Math.max(1, bytes));
  if (usage.totalHits > maxBytes) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((usage.resetTime!.getTime() - Date.now()) / 1000))));
    throw new ApiError(429, "MEDIA_DOWNLOAD_RATE_LIMITED", "The account download budget will reset shortly");
  }
}
