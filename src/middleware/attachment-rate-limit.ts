import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";
import {
  AttachmentUploadAdmissionGate,
  AttachmentUploadAdmissionLease
} from "../lib/attachment-upload-admission.js";

function uploadPrincipalKey(scope: string, req: Request) {
  const userId = typeof req.user?.id === "string" ? req.user.id : "";
  if (userId) {
    const digest = createHash("sha256").update(userId, "utf8").digest("hex");
    return `${scope}-user:${digest}`;
  }
  return `${scope}-ip:${ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown")}`;
}

function attachmentUploadKey(req: Request) {
  return uploadPrincipalKey("attachment-upload", req);
}

export const attachmentUploadRateLimit = rateLimit({
  windowMs: env.ATTACHMENT_UPLOAD_WINDOW_MS,
  limit: env.ATTACHMENT_UPLOAD_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: attachmentUploadKey,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: {
        code: "ATTACHMENT_UPLOAD_RATE_LIMITED",
        message: "Too many attachment upload requests. Try again later."
      }
    });
  }
});


export const customIconUploadRateLimit = rateLimit({
  windowMs: env.ATTACHMENT_UPLOAD_WINDOW_MS,
  limit: env.ATTACHMENT_UPLOAD_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => uploadPrincipalKey("custom-icon-upload", req),
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: {
        code: "CUSTOM_ICON_UPLOAD_RATE_LIMITED",
        message: "Too many custom icon upload requests. Try again later."
      }
    });
  }
});

const attachmentUploadAdmissionGate = new AttachmentUploadAdmissionGate(
  env.ATTACHMENT_UPLOAD_MAX_CONCURRENT
);
const attachmentUploadAdmissionLeases = new WeakMap<Response, AttachmentUploadAdmissionLease>();

export function beginAttachmentUploadProcessing(res: Response) {
  const lease = attachmentUploadAdmissionLeases.get(res);
  if (!lease || !lease.beginProcessing()) {
    throw new Error("Attachment upload admission lease is unavailable");
  }

  return () => {
    if (lease.release()) attachmentUploadAdmissionLeases.delete(res);
  };
}

export function attachmentUploadConcurrencyLimit(req: Request, res: Response, next: NextFunction) {
  const principal = attachmentUploadKey(req);
  const admission = attachmentUploadAdmissionGate.tryAcquire(principal);
  if (!admission.accepted) {
    if (admission.reason === "principal-active") {
      res.status(429).json({
        error: {
          code: "ATTACHMENT_UPLOAD_IN_PROGRESS",
          message: "Another attachment upload is already active for this account."
        }
      });
      return;
    }
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      error: {
        code: "ATTACHMENT_UPLOAD_BUSY",
        message: "The server is already processing the maximum number of attachment uploads. Try again later."
      }
    });
    return;
  }

  const lease = new AttachmentUploadAdmissionLease(() => attachmentUploadAdmissionGate.release(principal));
  attachmentUploadAdmissionLeases.set(res, lease);
  const releaseBeforeProcessing = () => {
    if (lease.releaseBeforeProcessing()) attachmentUploadAdmissionLeases.delete(res);
  };
  res.once("finish", releaseBeforeProcessing);
  res.once("close", releaseBeforeProcessing);
  req.once("aborted", releaseBeforeProcessing);
  next();
}
