import { Router } from "express";
import { z } from "zod";
import { db, type DbValue } from "../lib/db.js";
import { createId } from "../lib/id.js";
import { hashPassword, signAuthToken, verifyPassword } from "../lib/auth.js";
import { ApiError } from "../lib/http.js";
import { toPublicUser } from "../lib/mappers.js";
import {
  maxAvatarBytes,
  normalizeAvatarDataUrl,
  supportedProfileLanguages
} from "../lib/profile.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { requireUser } from "../utils/schemas.js";
import type { UserRow } from "../types/domain.js";

export const authRouter = Router();

const usernameSchema = z
  .string()
  .trim()
  .min(3, "ID must be at least 3 characters")
  .max(40, "ID must be at most 40 characters")
  .regex(/^[a-zA-Z0-9._-]+$/, "ID can contain letters, numbers, dots, underscores, and hyphens only")
  .transform((value) => value.toLowerCase());

const preferredLanguageSchema = z.enum(supportedProfileLanguages);

const registerSchema = z.object({
  username: usernameSchema,
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(80).optional(),
  preferredLanguage: preferredLanguageSchema.optional()
});

const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128)
});

const profileSchema = z
  .object({
    name: z.string().trim().max(80).nullable().optional(),
    avatarData: z.string().max(Math.ceil((maxAvatarBytes * 4) / 3) + 128).nullable().optional(),
    preferredLanguage: preferredLanguageSchema.nullable().optional(),
    defaultCollectionIcon: z.string().trim().min(1).max(32).nullable().optional()
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "At least one profile field is required"
  });

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(8).max(128)
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    path: ["newPassword"],
    message: "New password must differ from the current password"
  });

authRouter.post("/register", validate({ body: registerSchema }), async (req, res, next) => {
  try {
    const { username, password, name, preferredLanguage } = req.body as z.infer<typeof registerSchema>;

    const exists = await db.queryOne("SELECT id FROM users WHERE username = ?", [username]);
    if (exists) {
      throw new ApiError(409, "ID_TAKEN", "A user with that ID already exists");
    }

    const id = createId("usr");
    await db.execute(
      `INSERT INTO users (id, username, name, preferred_language, password_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [id, username, name ?? null, preferredLanguage ?? null, await hashPassword(password)]
    );

    const user = await db.queryOne<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
    if (!user) throw new ApiError(500, "USER_CREATE_FAILED", "User was not created");

    const token = signAuthToken({ sub: user.id, username: user.username });
    res.status(201).json({ user: toPublicUser(user), token });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/login", validate({ body: loginSchema }), async (req, res, next) => {
  try {
    const { username, password } = req.body as z.infer<typeof loginSchema>;
    const user = await db.queryOne<UserRow>("SELECT * FROM users WHERE username = ?", [username]);

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid ID or password");
    }

    const token = signAuthToken({ sub: user.id, username: user.username });
    res.json({ user: toPublicUser(user), token });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = requireUser(req.user);
  res.json({ user });
});

authRouter.patch("/profile", requireAuth, validate({ body: profileSchema }), async (req, res, next) => {
  try {
    const currentUser = requireUser(req.user);
    const body = req.body as z.infer<typeof profileSchema>;
    const fields: string[] = [];
    const values: DbValue[] = [];

    if (body.name !== undefined) {
      fields.push("name = ?");
      values.push(body.name || null);
    }
    if (body.avatarData !== undefined) {
      fields.push("avatar_data = ?");
      values.push(normalizeAvatarDataUrl(body.avatarData));
    }
    if (body.preferredLanguage !== undefined) {
      fields.push("preferred_language = ?");
      values.push(body.preferredLanguage);
    }
    if (body.defaultCollectionIcon !== undefined) {
      fields.push("default_collection_icon = ?");
      values.push(body.defaultCollectionIcon);
    }

    await db.execute(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, [...values, currentUser.id]);
    const user = await db.queryOne<UserRow>("SELECT * FROM users WHERE id = ?", [currentUser.id]);
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");

    res.json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/password", requireAuth, validate({ body: passwordSchema }), async (req, res, next) => {
  try {
    const currentUser = requireUser(req.user);
    const { currentPassword, newPassword } = req.body as z.infer<typeof passwordSchema>;
    const user = await db.queryOne<UserRow>("SELECT * FROM users WHERE id = ?", [currentUser.id]);

    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      throw new ApiError(400, "CURRENT_PASSWORD_INCORRECT", "Current password is incorrect");
    }
    if (await verifyPassword(newPassword, user.password_hash)) {
      throw new ApiError(400, "NEW_PASSWORD_SAME", "New password must differ from the current password");
    }

    await db.execute("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(newPassword), user.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
