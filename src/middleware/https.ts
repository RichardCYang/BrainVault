import type { RequestHandler } from "express";
import { isHttpsRequestFromTrustedProxy } from "../lib/reverse-proxy.js";

export type HttpsEnforcementOptions = {
  enabled: boolean;
  publicOrigin: string;
  redirect: boolean;
  healthcheckBypass: boolean;
  trustedProxyAddresses: readonly string[];
};

export function buildHttpsRedirectUrl(publicOrigin: string, originalUrl: string) {
  const source = new URL(originalUrl || "/", "http://brainvault.internal");
  const target = new URL(publicOrigin);
  target.pathname = source.pathname;
  target.search = source.search;
  target.hash = "";
  return target.toString();
}

function isDirectTlsRequest(socket: unknown) {
  return (socket as { encrypted?: boolean }).encrypted === true;
}

export function createHttpsEnforcementMiddleware(options: HttpsEnforcementOptions): RequestHandler {
  return (req, res, next) => {
    const secureRequest =
      isDirectTlsRequest(req.socket) ||
      isHttpsRequestFromTrustedProxy(req, options.trustedProxyAddresses);

    if (!options.enabled || secureRequest) {
      next();
      return;
    }

    if (options.healthcheckBypass && req.path === "/health") {
      next();
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    if (options.redirect) {
      res.redirect(308, buildHttpsRedirectUrl(options.publicOrigin, req.originalUrl));
      return;
    }

    res.status(426).json({
      error: {
        code: "HTTPS_REQUIRED",
        message: "This BrainVault deployment accepts browser traffic only over HTTPS"
      }
    });
  };
}
