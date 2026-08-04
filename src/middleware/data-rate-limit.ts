import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";

function exportKey(req: Request) {
  const userId = typeof req.user?.id === "string" ? req.user.id : "";
  if (userId) return `data-export-user:${createHash("sha256").update(userId, "utf8").digest("hex")}`;
  return `data-export-ip:${ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown")}`;
}

export const dataExportRateLimit = rateLimit({
  windowMs: env.DATA_EXPORT_WINDOW_MS,
  limit: env.DATA_EXPORT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: exportKey,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: {
        code: "DATA_EXPORT_RATE_LIMITED",
        message: "Too many data export requests. Try again later."
      }
    });
  }
});
