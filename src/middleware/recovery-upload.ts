import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { BoundedRateLimitStore } from "../lib/bounded-rate-limit-store.js";
import {
  AttachmentUploadAdmissionGate,
  AttachmentUploadAdmissionLease
} from "../lib/attachment-upload-admission.js";
import { ApiError } from "../lib/http.js";
import { maxRecoveryCandidateBytes } from "../lib/recovery-candidates.js";
import { requireUser } from "../utils/schemas.js";

export const recoveryCandidateUploadRateLimit = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `recovery:${requireUser(req.user).id}`,
  handler: (_req, _res, next) => next(new ApiError(
    429, "RECOVERY_UPLOAD_RATE_LIMITED", "Too many recovery uploads. The browser copy was not removed."
  ))
});

export function validateRecoveryUploadHeaders(req: Request, _res: Response, next: NextFunction) {
  if (!req.is("application/octet-stream") || (req.headers["content-encoding"] ?? "identity") !== "identity") {
    next(new ApiError(415, "INVALID_RECOVERY_CONTENT_TYPE", "Recovery uploads require uncompressed application/octet-stream"));
    return;
  }
  // Chunked uploads remain supported: the raw parser enforces the actual byte
  // limit, while admission bounds concurrent buffers even without this header.
  const length = req.headers["content-length"];
  if (length !== undefined && (typeof length !== "string" || !/^\d+$/.test(length)
    || !Number.isSafeInteger(Number(length)) || Number(length) > maxRecoveryCandidateBytes)) {
    next(new ApiError(413, "RECOVERY_CANDIDATE_TOO_LARGE", "The recovery candidate exceeds the supported size"));
    return;
  }
  next();
}

// Reuse the attachment lease's disconnect-safe lifecycle with a separate budget:
// one request per account, two across the process, through transaction completion.
const gate = new AttachmentUploadAdmissionGate(2);
const leases = new WeakMap<Response, AttachmentUploadAdmissionLease>();

export function admitRecoveryUpload(req: Request, res: Response, next: NextFunction) {
  const principal = requireUser(req.user).id;
  const admission = gate.tryAcquire(principal);
  if (!admission.accepted) {
    res.setHeader("Retry-After", "5");
    next(new ApiError(429, "RECOVERY_UPLOAD_BUSY", "Recovery upload capacity is busy. The browser copy was not removed."));
    return;
  }
  const lease = new AttachmentUploadAdmissionLease(() => gate.release(principal));
  leases.set(res, lease);
  const releaseBeforeProcessing = () => {
    if (lease.releaseBeforeProcessing()) leases.delete(res);
  };
  res.once("finish", releaseBeforeProcessing);
  res.once("close", releaseBeforeProcessing);
  req.once("aborted", releaseBeforeProcessing);
  next();
}

export function beginRecoveryUploadProcessing(res: Response) {
  const lease = leases.get(res);
  if (!lease || !lease.beginProcessing()) {
    throw new ApiError(409, "RECOVERY_UPLOAD_ABORTED", "Recovery upload is no longer active");
  }
  return () => {
    if (lease.release()) leases.delete(res);
  };
}
