import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { db } from "../lib/db.js";
import { normalizeAuthVersion, verifyAuthToken } from "../lib/auth.js";
import { ApiError } from "../lib/http.js";
import { toPublicUser } from "../lib/mappers.js";
import { clearAuthSessionCookie, readAuthSessionCookie } from "../lib/session-cookie.js";
import { isAllowedCorsOrigin } from "./cors.js";
import type { UserRow } from "../types/domain.js";

function getBearerToken(req: Request) {
  const authorization = req.header("authorization");
  if (!authorization) return null;
  if (!env.AUTH_ALLOW_BEARER_TOKENS) {
    throw new ApiError(401, "BEARER_AUTH_DISABLED", "Bearer authentication is disabled for this deployment");
  }
  const [scheme, token, ...extra] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !token || extra.length) {
    throw new ApiError(401, "UNAUTHENTICATED", "Invalid Authorization header");
  }
  return token;
}

function assertBrowserRequestOrigin(req: Request) {
  const fetchSite = req.header("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") {
    throw new ApiError(403, "CROSS_SITE_REQUEST_BLOCKED", "Cross-site browser authentication is not allowed");
  }

  const origin = req.header("origin");
  if (origin && !isAllowedCorsOrigin(req, origin)) {
    throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed");
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  let source: "bearer" | "cookie" | null = null;
  try {
    const bearerToken = getBearerToken(req);
    const cookieToken = readAuthSessionCookie(req);
    const token = bearerToken ?? cookieToken;
    source = bearerToken ? "bearer" : cookieToken ? "cookie" : null;

    if (!token || !source) {
      next(new ApiError(401, "UNAUTHENTICATED", "Authentication required"));
      return;
    }
    assertBrowserRequestOrigin(req);

    const payload = verifyAuthToken(token);
    const user = await db.queryOne<UserRow>(
      `SELECT id, username, name, avatar_data, preferred_language, default_collection_icon, password_hash,
              auth_version, created_at, updated_at
       FROM users WHERE id = ?`,
      [payload.sub]
    );

    if (!user) {
      if (source === "cookie") clearAuthSessionCookie(res);
      next(new ApiError(401, "UNAUTHENTICATED", "User no longer exists"));
      return;
    }

    const authVersion = normalizeAuthVersion(user.auth_version);
    if (payload.authVersion !== authVersion) {
      if (source === "cookie") clearAuthSessionCookie(res);
      next(new ApiError(401, "SESSION_REVOKED", "This authentication session is no longer valid"));
      return;
    }

    req.auth = { authVersion };
    req.user = toPublicUser(user);
    next();
  } catch (error) {
    if (source === "cookie") clearAuthSessionCookie(res);
    next(error);
  }
}
