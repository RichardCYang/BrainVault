import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import {
  customIconLibraryLimit,
  listCustomIconLibraryRemovalKeys,
  listCustomIcons,
  rememberCustomIconPaths,
  removeCustomIconFromLibrary,
  restoreCustomIconToLibrary,
  storeCustomIcon
} from "../lib/custom-icons.js";
import { ApiError } from "../lib/http.js";
import { iconValueSchema, maxCustomIconBytes } from "../lib/icon-value.js";
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
    fields: 0,
    // Busboy emits partsLimit when the configured count is reached, not only when it is exceeded.
    // Keep one spare aggregate slot so a valid one-file upload does not become LIMIT_PART_COUNT;
    // files: 1, fields: 0, and .single("icon") still enforce the exact request shape.
    parts: 2,
    fieldNameSize: 64,
    headerPairs: 32,
    fieldNestingDepth: 1
  },
  preservePath: false,
  defParamCharset: "utf8"
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

const customIconLibraryEntrySchema = z.object({
  value: iconValueSchema
});

customIconRouter.get("/", async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    res.setHeader("Cache-Control", "private, no-store");
    const [icons, removedKeys] = await Promise.all([
      listCustomIcons(user.id),
      listCustomIconLibraryRemovalKeys(user.id)
    ]);
    res.json({ icons, removedKeys });
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

customIconRouter.delete("/", validate({ body: customIconLibraryEntrySchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const body = req.body as z.infer<typeof customIconLibraryEntrySchema>;
    res.json(await removeCustomIconFromLibrary(user.id, body.value));
  } catch (error) {
    next(error);
  }
});

customIconRouter.post("/restore", validate({ body: customIconLibraryEntrySchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const body = req.body as z.infer<typeof customIconLibraryEntrySchema>;
    await restoreCustomIconToLibrary(user.id, body.value);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
