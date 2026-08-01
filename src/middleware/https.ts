import type { RequestHandler } from "express";

export type HttpsEnforcementOptions = {
  enabled: boolean;
  publicOrigin: string;
  redirect: boolean;
  healthcheckBypass: boolean;
};

export function buildHttpsRedirectUrl(publicOrigin: string, originalUrl: string) {
  const source = new URL(originalUrl || "/", "http://brainvault.internal");
  const target = new URL(publicOrigin);
  target.pathname = source.pathname;
  target.search = source.search;
  target.hash = "";
  return target.toString();
}

export function createHttpsEnforcementMiddleware(options: HttpsEnforcementOptions): RequestHandler {
  return (req, res, next) => {
    if (!options.enabled || req.secure) {
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
