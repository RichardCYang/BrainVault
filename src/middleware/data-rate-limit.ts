import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";
import { DataImportAdmissionGate, DataImportAdmissionLease } from "../lib/data-import-admission.js";

function dataKey(scope: "export" | "import", req: Request) {
  const userId = typeof req.user?.id === "string" ? req.user.id : "";
  if (userId) {
    const digest = createHash("sha256").update(userId, "utf8").digest("hex");
    return `data-${scope}-user:${digest}`;
  }
  return `data-${scope}-ip:${ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown")}`;
}

export const dataExportRateLimit = rateLimit({
  windowMs: env.DATA_EXPORT_WINDOW_MS,
  limit: env.DATA_EXPORT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => dataKey("export", req),
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: {
        code: "DATA_EXPORT_RATE_LIMITED",
        message: "Too many data export requests. Try again later."
      }
    });
  }
});

export const dataImportRateLimit = rateLimit({
  windowMs: env.DATA_IMPORT_WINDOW_MS,
  limit: env.DATA_IMPORT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => dataKey("import", req),
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: {
        code: "DATA_IMPORT_RATE_LIMITED",
        message: "Too many data import requests. Try again later."
      }
    });
  }
});

const dataImportAdmissionGate = new DataImportAdmissionGate(env.DATA_IMPORT_MAX_CONCURRENT);
const dataImportAdmissionLeases = new WeakMap<Response, DataImportAdmissionLease>();

export function beginDataImportProcessing(res: Response) {
  const lease = dataImportAdmissionLeases.get(res);
  if (!lease || !lease.beginProcessing()) {
    throw new Error("Data import admission lease is unavailable");
  }

  return () => {
    if (lease.release()) dataImportAdmissionLeases.delete(res);
  };
}

export function dataImportConcurrencyLimit(req: Request, res: Response, next: NextFunction) {
  const principal = dataKey("import", req);
  const admission = dataImportAdmissionGate.tryAcquire(principal);
  if (!admission.accepted) {
    if (admission.reason === "principal-active") {
      res.status(429).json({
        error: {
          code: "DATA_IMPORT_IN_PROGRESS",
          message: "Another data import is already active for this account."
        }
      });
      return;
    }
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      error: {
        code: "DATA_IMPORT_BUSY",
        message: "The server is already processing the maximum number of data imports. Try again later."
      }
    });
    return;
  }

  const lease = new DataImportAdmissionLease(() => dataImportAdmissionGate.release(principal));
  dataImportAdmissionLeases.set(res, lease);
  const releaseBeforeProcessing = () => {
    if (lease.releaseBeforeProcessing()) dataImportAdmissionLeases.delete(res);
  };
  res.once("finish", releaseBeforeProcessing);
  res.once("close", releaseBeforeProcessing);
  req.once("aborted", releaseBeforeProcessing);
  next();
}
