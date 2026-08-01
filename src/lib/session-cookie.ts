import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export const authSessionCookieName = "brainvault_session";

const secureSessionCookie = env.HTTPS_MODE !== "off" || new URL(env.PUBLIC_ORIGIN).protocol === "https:";

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

  res.cookie(authSessionCookieName, token, { ...baseCookieOptions, expires });
  res.setHeader("Cache-Control", "private, no-store");
}

export function clearAuthSessionCookie(res: Response) {
  res.clearCookie(authSessionCookieName, baseCookieOptions);
  res.setHeader("Cache-Control", "private, no-store");
}

export function readAuthSessionCookie(req: Request) {
  const header = req.header("cookie");
  if (!header) return null;

  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (name !== authSessionCookieName) continue;
    const value = entry.slice(separator + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }

  return null;
}
