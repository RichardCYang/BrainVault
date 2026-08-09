import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { createOpaqueToken } from "./mfa.js";
import { readUniqueCookieValue } from "./session-cookie-policy.js";

const secureCookie = env.HTTPS_MODE !== "off" || new URL(env.PUBLIC_ORIGIN).protocol === "https:";
const ceremonyLifetimeMs = 10 * 60_000;
const canonicalOpaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export const passkeyCeremonyCookieName = secureCookie
  ? "__Host-brainvault_passkey_ceremony"
  : "brainvault_passkey_ceremony";

const cookieOptions = {
  httpOnly: true,
  secure: secureCookie,
  sameSite: "strict" as const,
  path: "/"
};

export function getOrCreatePasskeyCeremonyBinding(req: Request, res: Response) {
  const existing = readUniqueCookieValue(req.header("cookie"), passkeyCeremonyCookieName);
  const binding = existing && canonicalOpaqueTokenPattern.test(existing) ? existing : createOpaqueToken();
  res.cookie(passkeyCeremonyCookieName, binding, { ...cookieOptions, maxAge: ceremonyLifetimeMs });
  res.setHeader("Cache-Control", "private, no-store");
  return binding;
}

export function readPasskeyCeremonyBinding(req: Request) {
  const value = readUniqueCookieValue(req.header("cookie"), passkeyCeremonyCookieName);
  return value && canonicalOpaqueTokenPattern.test(value) ? value : null;
}

export function clearPasskeyCeremonyBinding(res: Response) {
  res.clearCookie(passkeyCeremonyCookieName, cookieOptions);
  res.setHeader("Cache-Control", "private, no-store");
}
