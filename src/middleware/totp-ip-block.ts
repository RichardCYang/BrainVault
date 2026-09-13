import type { NextFunction, Request, Response } from "express";

/**
 * Compatibility middleware retained for older integrations. TOTP source-IP
 * blocks are enforced only by the TOTP verification endpoint so they cannot
 * deny established sessions, passkey sign-in, or unrelated API access.
 */
export function enforcePermanentTotpIpBlock(_req: Request, _res: Response, next: NextFunction) {
  next();
}
