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

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    res.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? "ATTACHMENT_TOO_LARGE" : "ATTACHMENT_UPLOAD_FAILED",
        message: tooLarge ? "Attachment exceeds the configured size limit" : "Attachment upload failed",
        details: { multerCode: error.code }
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

  const dbError = getDbError(error);
  if (dbError?.sqlState === "23000" || dbError?.code === "ER_DUP_ENTRY") {
    res.status(409).json({
      error: {
        code: dbError.code ?? "DATABASE_CONSTRAINT_FAILED",
        message: "Database constraint failed"
      }
    });
    return;
  }

  console.error(error);
  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error"
    }
  });
}
