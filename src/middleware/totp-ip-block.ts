import type { NextFunction, Request, Response } from "express";
import { getClientIpAddress } from "../lib/login-history.js";
import {
  isPermanentlyBlockedTotpIp,
  isPermanentTotpIpEnforcementReady
} from "../lib/totp-ip-block.js";

export async function enforcePermanentTotpIpBlock(req: Request, res: Response, next: NextFunction) {
  try {
    if (!isPermanentTotpIpEnforcementReady()) {
      next();
      return;
    }

    const ipAddress = getClientIpAddress(req);
    if (ipAddress === "unknown" || !(await isPermanentlyBlockedTotpIp(ipAddress))) {
      next();
      return;
    }

    res.setHeader("Cache-Control", "private, no-store");
    if (req.path.startsWith("/api/")) {
      res.status(403).json({
        error: {
          code: "TOTP_IP_PERMANENTLY_BLOCKED",
          message: "Access from this IP address is permanently blocked"
        }
      });
      return;
    }
    res.status(403).type("text/plain; charset=utf-8").send("Forbidden");
  } catch (error) {
    // Once enforcement has been initialized, a database lookup failure must not
    // accidentally turn into a bypass for a potentially blocked address.
    next(error);
  }
}
