import type { NextFunction, Request, Response } from "express";
import { db } from "../lib/db.js";
import { verifyAuthToken } from "../lib/auth.js";
import { ApiError } from "../lib/http.js";
import { toPublicUser } from "../lib/mappers.js";
import type { UserRow } from "../types/domain.js";

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const authorization = req.header("authorization");
  const [scheme, token] = authorization?.split(" ") ?? [];

  if (scheme !== "Bearer" || !token) {
    next(new ApiError(401, "UNAUTHENTICATED", "Missing Bearer token"));
    return;
  }

  try {
    const payload = verifyAuthToken(token);
    const user = await db.queryOne<UserRow>(
      `SELECT id, username, name, avatar_data, preferred_language, password_hash, created_at, updated_at
       FROM users WHERE id = ?`,
      [payload.sub]
    );

    if (!user) {
      next(new ApiError(401, "UNAUTHENTICATED", "User no longer exists"));
      return;
    }

    req.user = toPublicUser(user);
    next();
  } catch (error) {
    next(error);
  }
}
