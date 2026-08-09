import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { ApiError } from "../lib/http.js";

function getDbError(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; errno?: unknown; sqlState?: unknown };
  return {
    code: candidate.code ? String(candidate.code) : null,
    errno: candidate.errno ? Number(candidate.errno) : null,
    sqlState: candidate.sqlState ? String(candidate.sqlState) : null
  };
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new ApiError(404, "ROUTE_NOT_FOUND", `Route ${req.method} ${req.originalUrl} not found`));
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (
    typeof error === "object"
    && error !== null
    && "status" in error
    && Number(error.status) === 413
    && "type" in error
    && error.type === "entity.too.large"
  ) {
    res.status(413).json({
      error: {
        code: "REQUEST_BODY_TOO_LARGE",
        message: "Request body exceeds the permitted size"
      }
    });
    return;
  }

  if (error instanceof MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    const dataTransfer = req.originalUrl.startsWith("/api/data/import");
    res.status(tooLarge ? 413 : 400).json({
      error: {
        code: dataTransfer
          ? (tooLarge ? "DATA_BACKUP_TOO_LARGE" : "DATA_BACKUP_UPLOAD_FAILED")
          : (tooLarge ? "ATTACHMENT_TOO_LARGE" : "ATTACHMENT_UPLOAD_FAILED"),
        message: dataTransfer
          ? (tooLarge ? "Backup exceeds the configured data-transfer limit" : "Backup upload failed")
          : (tooLarge ? "Attachment exceeds the configured size limit" : "Attachment upload failed"),
        details: { multerCode: error.code }
      }
    });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({
      error: {
        code: "INVALID_JSON",
        message: "Request body contains invalid JSON"
      }
    });
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.flatten()
      }
    });
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    });
    return;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "commitOutcomeUnknown" in error &&
    error.commitOutcomeUnknown === true
  ) {
    res.status(503).json({
      error: {
        code: "TRANSACTION_COMMIT_OUTCOME_UNKNOWN",
        message: "The database commit may have succeeded; retry the same mutation id to confirm the result"
      }
    });
    return;
  }

  const dbError = getDbError(error);
  if (dbError?.sqlState === "23000" || dbError?.code === "ER_DUP_ENTRY") {
    res.status(409).json({
      error: {
        code: "DATABASE_CONSTRAINT_FAILED",
        message: "Database constraint failed"
      }
    });
    return;
  }

  const descriptor = typeof error === "object" && error !== null
    ? {
      name: "name" in error ? String(error.name) : error.constructor?.name ?? "Error",
      code: "code" in error ? String(error.code) : dbError?.code,
      errno: dbError?.errno,
      sqlState: dbError?.sqlState
    }
    : { name: typeof error, code: null, errno: null, sqlState: null };
  console.error("Unexpected request failure", {
    method: req.method,
    path: req.path,
    ...descriptor
  });
  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error"
    }
  });
}
