import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { createOpaqueToken } from "./mfa.js";
import { readUniqueCookieValue } from "./session-cookie-policy.js";

const secureCookie = env.HTTPS_MODE !== "off" || new URL(env.PUBLIC_ORIGIN).protocol === "https:";
const ceremonyLifetimeMs = 5 * 60_000;
const canonicalOpaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export const mfaCeremonyCookieName = secureCookie
  ? "__Host-brainvault_mfa_ceremony"
  : "brainvault_mfa_ceremony";

const cookieOptions = {
  httpOnly: true,
  secure: secureCookie,
  sameSite: "strict" as const,
  path: "/"
};

export function getOrCreateMfaCeremonyBinding(req: Request, res: Response) {
  const existing = readUniqueCookieValue(req.header("cookie"), mfaCeremonyCookieName);
  const binding = existing && canonicalOpaqueTokenPattern.test(existing) ? existing : createOpaqueToken();
  res.cookie(mfaCeremonyCookieName, binding, { ...cookieOptions, maxAge: ceremonyLifetimeMs });
  res.setHeader("Cache-Control", "private, no-store");
  return binding;
}

export function readMfaCeremonyBinding(req: Request) {
  const value = readUniqueCookieValue(req.header("cookie"), mfaCeremonyCookieName);
  return value && canonicalOpaqueTokenPattern.test(value) ? value : null;
}

export function clearMfaCeremonyBinding(res: Response) {
  res.clearCookie(mfaCeremonyCookieName, cookieOptions);
  res.setHeader("Cache-Control", "private, no-store");
}
