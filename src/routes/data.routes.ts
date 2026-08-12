import path from "node:path";
import { rm } from "node:fs/promises";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { env } from "../config/env.js";
import {
  dataTransferTempDir,
  ensureDataTransferDirectories,
  importUserDataBackup,
  prepareUserDataBackup,
  writeUserDataBackup
} from "../lib/data-transfer.js";
import { createId } from "../lib/id.js";
import { ApiError } from "../lib/http.js";
import { toPublicUser } from "../lib/mappers.js";
import { requireAuth } from "../middleware/auth.js";
import {
  beginDataImportProcessing,
  dataExportRateLimit,
  dataImportConcurrencyLimit,
  dataImportRateLimit
} from "../middleware/data-rate-limit.js";
import { requireUser } from "../utils/schemas.js";

export const dataRouter = Router();
dataRouter.use(requireAuth);

const maxBackupUploadBytes = env.DATA_TRANSFER_MAX_SIZE_MB * 1024 * 1024;
const maxMultipartOverheadBytes = 1024 * 1024;

function enforceBackupUploadRequestSize(req: Request, _res: Response, next: NextFunction) {
  const rawContentLength = req.headers["content-length"];
  if (rawContentLength === undefined) {
    next();
    return;
  }
  const contentLength = Number(rawContentLength);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    next(new ApiError(400, "INVALID_CONTENT_LENGTH", "Content-Length is invalid"));
    return;
  }
  if (contentLength > maxBackupUploadBytes + maxMultipartOverheadBytes) {
    next(new ApiError(413, "DATA_BACKUP_TOO_LARGE", "Backup exceeds the configured data-transfer limit"));
    return;
  }
  next();
}

const backupUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      ensureDataTransferDirectories()
        .then(() => callback(null, dataTransferTempDir))
        .catch((error) => callback(error, dataTransferTempDir));
    },
    filename: (_req, _file, callback) => callback(null, createId("backup-upload"))
  }),
  limits: {
    fileSize: maxBackupUploadBytes,
    files: 1,
    fields: 0,
    parts: 2,
    fieldNameSize: 64,
    headerPairs: 32,
    fieldNestingDepth: 1
  },
  preservePath: false,
  defParamCharset: "utf8"
});

dataRouter.get("/export", dataExportRateLimit, async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const plan = await prepareUserDataBackup(user.id);
    const date = new Date().toISOString().slice(0, 10);
    const safeUsername = plan.account.username.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `BrainVault-${safeUsername}-${date}.zip`;

    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", plan.archiveSize.toString());
    res.setHeader("Cache-Control", "private, no-store, no-transform");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.strictContentLength = true;
    await writeUserDataBackup(plan, res);
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    next(error);
  }
});

dataRouter.post(
  "/import",
  dataImportRateLimit,
  enforceBackupUploadRequestSize,
  dataImportConcurrencyLimit,
  backupUpload.single("backup"),
  async (req, res, next) => {
    const uploadPath = req.file?.path ?? null;
    let releaseDataImport: (() => void) | null = null;
    try {
      releaseDataImport = beginDataImportProcessing(res);
      const user = requireUser(req.user);
      if (!uploadPath) throw new ApiError(400, "DATA_BACKUP_REQUIRED", "Select a BrainVault backup ZIP file");
      const extension = path.extname(req.file?.originalname ?? "").toLowerCase();
      if (extension && extension !== ".zip") {
        throw new ApiError(400, "INVALID_DATA_BACKUP", "Select a .zip backup exported by BrainVault");
      }

      const result = await importUserDataBackup(user.id, uploadPath);
      res.json({ user: toPublicUser(result.user), counts: result.counts, sharing: result.sharing });
    } catch (error) {
      next(error);
    } finally {
      if (uploadPath) await rm(uploadPath, { force: true }).catch(() => undefined);
      releaseDataImport?.();
    }
  }
);
