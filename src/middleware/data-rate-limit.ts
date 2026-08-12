import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";
import { DataImportAdmissionGate, DataImportAdmissionLease } from "../lib/data-import-admission.js";
import { ApiError } from "../lib/http.js";

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
type DataImportLeaseRecord = { principal: string; lease: DataImportAdmissionLease };
const dataImportAdmissionLeases = new WeakMap<Response, DataImportLeaseRecord>();

export function beginDataImportProcessing(res: Response) {
  const record = dataImportAdmissionLeases.get(res);
  if (!record) throw new Error("Data import admission lease is unavailable");

  const processingAdmission = dataImportAdmissionGate.tryBeginProcessing(record.principal);
  if (!processingAdmission.accepted) {
    if (record.lease.releaseBeforeProcessing()) dataImportAdmissionLeases.delete(res);
    if (processingAdmission.reason === "server-capacity") {
      res.setHeader("Retry-After", "5");
      throw new ApiError(503, "DATA_IMPORT_BUSY", "The server is already processing the maximum number of data imports. Try again later.");
    }
    throw new Error("Data import admission principal is unavailable");
  }

  if (!record.lease.beginProcessing()) {
    dataImportAdmissionGate.release(record.principal);
    dataImportAdmissionLeases.delete(res);
    throw new Error("Data import admission lease is unavailable");
  }

  return () => {
    if (record.lease.release()) dataImportAdmissionLeases.delete(res);
  };
}

export function dataImportConcurrencyLimit(req: Request, res: Response, next: NextFunction) {
  const principal = dataKey("import", req);
  const admission = dataImportAdmissionGate.tryAcquire(principal);
  if (!admission.accepted) {
    res.status(429).json({
      error: {
        code: "DATA_IMPORT_IN_PROGRESS",
        message: "Another data import is already active for this account."
      }
    });
    return;
  }

  const lease = new DataImportAdmissionLease(() => dataImportAdmissionGate.release(principal));
  dataImportAdmissionLeases.set(res, { principal, lease });
  const releaseBeforeProcessing = () => {
    if (lease.releaseBeforeProcessing()) dataImportAdmissionLeases.delete(res);
  };
  res.once("finish", releaseBeforeProcessing);
  res.once("close", releaseBeforeProcessing);
  req.once("aborted", releaseBeforeProcessing);
  next();
}
