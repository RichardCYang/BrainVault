import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { db } from "../lib/db.js";
import { normalizeAuthVersion, verifyAuthToken } from "../lib/auth.js";
import { setPrivateNoStoreCacheControl } from "../lib/cache-control.js";
import { ApiError } from "../lib/http.js";
import { enforceCountryLoginPolicy } from "../lib/country-login-policy.js";
import { enforceVpnAccessPolicy, getClientTimeZone, getClientWebRtcSignal } from "../lib/vpn-access-policy.js";
import { getClientIpAddress } from "../lib/login-history.js";
import { isPermanentlyBlockedTotpIp } from "../lib/totp-ip-block.js";
import { toPublicUser } from "../lib/mappers.js";
import { clearAuthSessionCookie, readAuthSessionCookie } from "../lib/session-cookie.js";
import { ensureAuthSessionForRequest } from "../lib/auth-sessions.js";
import { isAllowedCorsOrigin } from "./cors.js";
import { parseExactHttpOrigin } from "../lib/request-origin.js";
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

function assertBrowserRequestOrigin(
  req: Request,
  {
    requireOrigin = false,
    requirePublicOrigin = false
  }: { requireOrigin?: boolean; requirePublicOrigin?: boolean } = {}
) {
  const fetchSite = req.header("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site") {
    throw new ApiError(403, "CROSS_SITE_REQUEST_BLOCKED", "Cross-site browser authentication is not allowed");
  }

  const origin = req.header("origin");
  if (!origin) {
    if (requireOrigin) {
      throw new ApiError(403, "ORIGIN_REQUIRED", "A same-origin request origin is required");
    }
    return;
  }
  const parsedOrigin = parseExactHttpOrigin(origin);
  if (!parsedOrigin || !isAllowedCorsOrigin(req, parsedOrigin)) {
    throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed");
  }
  if (requirePublicOrigin && parsedOrigin !== env.PUBLIC_ORIGIN) {
    throw new ApiError(403, "ORIGIN_MISMATCH", "Cookie-authenticated mutations must originate from the public application origin");
  }
}

function requiresCookieMutationOrigin(req: Request, source: "bearer" | "cookie") {
  return source === "cookie" && !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase());
}

export function requireSameOriginBrowserRequest(req: Request, _res: Response, next: NextFunction) {
  try {
    assertBrowserRequestOrigin(req, { requireOrigin: true });
    next();
  } catch (error) {
    next(error);
  }
}

export function requireJsonRequestBody(req: Request, _res: Response, next: NextFunction) {
  if (!req.is("application/json")) {
    next(new ApiError(415, "JSON_BODY_REQUIRED", "This authentication endpoint requires an application/json body"));
    return;
  }
  next();
}

async function authenticateRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  { allowTotpIpBlock = false }: { allowTotpIpBlock?: boolean } = {}
) {
  setPrivateNoStoreCacheControl(res);
  let source: "bearer" | "cookie" | null = null;
  try {
    const cookieToken = readAuthSessionCookie(req);
    const bearerToken = cookieToken ? null : getBearerToken(req);
    const token = cookieToken ?? bearerToken;
    const selectedSource = cookieToken ? "cookie" : bearerToken ? "bearer" : null;

    if (!token || !selectedSource) {
      next(new ApiError(401, "UNAUTHENTICATED", "Authentication required"));
      return;
    }
    const cookieMutation = requiresCookieMutationOrigin(req, selectedSource);
    assertBrowserRequestOrigin(req, { requireOrigin: cookieMutation, requirePublicOrigin: cookieMutation });
    source = selectedSource;

    const payload = verifyAuthToken(token);
    const user = await db.queryOne<UserRow>(
      `SELECT id, username, name, avatar_data, preferred_language, default_collection_icon, theme, country_login_mode,
              password_hash, vpn_block_enabled, auth_version, created_at, updated_at
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

    const clientIp = getClientIpAddress(req);
    if (!allowTotpIpBlock && await isPermanentlyBlockedTotpIp(clientIp, user.id)) {
      throw new ApiError(
        403,
        "TOTP_IP_PERMANENTLY_BLOCKED",
        "Access from this IP address is temporarily blocked for this account"
      );
    }

    await enforceCountryLoginPolicy(user.id, user.country_login_mode, clientIp);
    await enforceVpnAccessPolicy(
      user.id,
      user.vpn_block_enabled,
      clientIp,
      getClientTimeZone(req),
      getClientWebRtcSignal(req)
    );

    // Session revocation must apply uniformly to cookie and optional bearer credentials.
    const authSessionId = await ensureAuthSessionForRequest(token, payload, req);
    req.auth = { authVersion };
    if (authSessionId) req.auth.sessionId = authSessionId;
    req.user = toPublicUser(user);
    next();
  } catch (error) {
    if (
      source === "cookie"
      && !(error instanceof ApiError && error.code === "TOTP_IP_PERMANENTLY_BLOCKED")
    ) clearAuthSessionCookie(res);
    next(error);
  }
}

export function requireRequestAuthScope(req: Request) {
  const authVersion = Number(req.auth?.authVersion);
  const sessionId = req.auth?.sessionId;
  if (!Number.isSafeInteger(authVersion) || authVersion < 1 || !sessionId) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication context is missing");
  }
  return Object.freeze({ authVersion, sessionId });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  void authenticateRequest(req, res, next);
}

export function requireAuthAllowTotpIpBlock(req: Request, res: Response, next: NextFunction) {
  void authenticateRequest(req, res, next, { allowTotpIpBlock: true });
}
