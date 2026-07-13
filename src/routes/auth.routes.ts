import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { createId } from "../lib/id.js";
import { hashPassword, signAuthToken, verifyPassword } from "../lib/auth.js";
import { ApiError } from "../lib/http.js";
import { toPublicUser } from "../lib/mappers.js";
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

const registerSchema = z.object({
  username: usernameSchema,
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(80).optional()
});

const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128)
});

authRouter.post("/register", validate({ body: registerSchema }), async (req, res, next) => {
  try {
    const { username, password, name } = req.body as z.infer<typeof registerSchema>;

    const exists = await db.queryOne("SELECT id FROM users WHERE username = ?", [username]);
    if (exists) {
      throw new ApiError(409, "ID_TAKEN", "A user with that ID already exists");
    }

    const id = createId("usr");
    await db.execute(
      `INSERT INTO users (id, username, name, password_hash)
       VALUES (?, ?, ?, ?)`,
      [id, username, name ?? null, await hashPassword(password)]
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
