import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import {
  getAuthSessionCookieName,
  legacyAuthSessionCookieName,
  readUniqueCookieValue
} from "./session-cookie-policy.js";

const secureSessionCookie = env.HTTPS_MODE !== "off" || new URL(env.PUBLIC_ORIGIN).protocol === "https:";

export const authSessionCookieName = getAuthSessionCookieName(secureSessionCookie);

const baseCookieOptions = {
  httpOnly: true,
  secure: secureSessionCookie,
  sameSite: "strict" as const,
  path: "/"
};

export function setAuthSessionCookie(res: Response, token: string) {
  const decoded = jwt.decode(token);
  const expires =
    decoded && typeof decoded === "object" && typeof decoded.exp === "number"
      ? new Date(decoded.exp * 1000)
      : undefined;

  // Secure deployments intentionally stop accepting the unprefixed cookie.
  // Clearing it here provides a clean migration for a browser that previously
  // received a host-only BrainVault session cookie.
  if (authSessionCookieName !== legacyAuthSessionCookieName) {
    res.clearCookie(legacyAuthSessionCookieName, baseCookieOptions);
  }
  res.cookie(authSessionCookieName, token, { ...baseCookieOptions, expires });
  res.setHeader("Cache-Control", "private, no-store");
}

export function clearAuthSessionCookie(res: Response) {
  res.clearCookie(authSessionCookieName, baseCookieOptions);
  if (authSessionCookieName !== legacyAuthSessionCookieName) {
    res.clearCookie(legacyAuthSessionCookieName, baseCookieOptions);
  }
  res.setHeader("Cache-Control", "private, no-store");
}

export function readAuthSessionCookie(req: Request) {
  return readUniqueCookieValue(req.header("cookie"), authSessionCookieName);
}
