import path from "node:path";
import { rm } from "node:fs/promises";
import { Router } from "express";
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
import { requireUser } from "../utils/schemas.js";

export const dataRouter = Router();
dataRouter.use(requireAuth);

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
    fileSize: env.DATA_TRANSFER_MAX_SIZE_MB * 1024 * 1024,
    files: 1,
    fields: 0,
    parts: 2
  },
  preservePath: false,
  defParamCharset: "utf8"
});

dataRouter.get("/export", async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const plan = await prepareUserDataBackup(user.id);
    const date = new Date().toISOString().slice(0, 10);
    const safeUsername = plan.account.username.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `BrainVault-${safeUsername}-${date}.zip`;

    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
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

dataRouter.post("/import", backupUpload.single("backup"), async (req, res, next) => {
  const uploadPath = req.file?.path ?? null;
  try {
    const user = requireUser(req.user);
    if (!uploadPath) throw new ApiError(400, "DATA_BACKUP_REQUIRED", "Select a BrainVault backup ZIP file");
    const extension = path.extname(req.file?.originalname ?? "").toLowerCase();
    if (extension && extension !== ".zip") {
      throw new ApiError(400, "INVALID_DATA_BACKUP", "Select a .zip backup exported by BrainVault");
    }

    const result = await importUserDataBackup(user.id, uploadPath);
    res.json({ user: toPublicUser(result.user), counts: result.counts });
  } catch (error) {
    next(error);
  } finally {
    if (uploadPath) await rm(uploadPath, { force: true }).catch(() => undefined);
  }
});
