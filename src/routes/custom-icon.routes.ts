import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import {
  customIconLibraryLimit,
  listCustomIcons,
  rememberCustomIconPaths,
  storeCustomIcon
} from "../lib/custom-icons.js";
import { ApiError } from "../lib/http.js";
import { maxCustomIconBytes } from "../lib/icon-value.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { requireUser } from "../utils/schemas.js";

export const customIconRouter = Router();

customIconRouter.use(requireAuth);

const customIconUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxCustomIconBytes,
    files: 1,
    fields: 0
  }
}).single("icon");

function parseCustomIconUpload(req: Request, res: Response, next: NextFunction) {
  customIconUpload(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        next(new ApiError(413, "CUSTOM_ICON_TOO_LARGE", "Custom icon images must be 512 KB or smaller"));
        return;
      }
      next(new ApiError(400, "INVALID_CUSTOM_ICON_UPLOAD", "Custom icon upload is invalid"));
      return;
    }
    next(error);
  });
}

const touchCustomIconsSchema = z.object({
  values: z.array(z.string().trim().min(1).max(2048)).max(customIconLibraryLimit)
});

customIconRouter.get("/", async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ icons: await listCustomIcons(user.id) });
  } catch (error) {
    next(error);
  }
});

customIconRouter.post("/", parseCustomIconUpload, async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    if (!req.file?.buffer?.length) {
      throw new ApiError(400, "CUSTOM_ICON_REQUIRED", "Select an icon image to upload");
    }
    const icon = await storeCustomIcon(user.id, req.file.buffer);
    res.status(201).json({ icon });
  } catch (error) {
    next(error);
  }
});

customIconRouter.post("/touch", validate({ body: touchCustomIconsSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const body = req.body as z.infer<typeof touchCustomIconsSchema>;
    await rememberCustomIconPaths(user.id, body.values);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
