import type { NextFunction, Request, Response } from "express";
import { getClientIpAddress } from "../lib/login-history.js";
import { isPermanentlyBlockedTotpIp, isPermanentTotpIpEnforcementReady } from "../lib/totp-ip-block.js";

/**
 * Optional post-authentication guard. It must never be mounted as a global
 * pre-authentication IP deny list because blocks are owned by one account.
 */
export async function enforcePermanentTotpIpBlock(req: Request, res: Response, next: NextFunction) {
  try {
    if (!isPermanentTotpIpEnforcementReady() || !req.user?.id) {
      next();
      return;
    }
    const ipAddress = getClientIpAddress(req);
    if (ipAddress === "unknown" || !(await isPermanentlyBlockedTotpIp(ipAddress, req.user.id))) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.status(403).json({
      error: {
        code: "TOTP_IP_PERMANENTLY_BLOCKED",
        message: "Access from this IP address is temporarily blocked for this account"
      }
    });
  } catch (error) {
    next(error);
  }
}
