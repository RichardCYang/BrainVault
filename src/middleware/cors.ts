import type { Request } from "express";
import type { CorsOptions, CorsOptionsDelegate } from "cors";
import { corsOrigins } from "../config/env.js";

function normalizeOrigin(origin: string) {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.trim();
  }
}

const explicitCorsOrigins = new Set(corsOrigins.map(normalizeOrigin));

export function isAllowedCorsOrigin(_req: Request, origin?: string) {
  if (!origin) return true;
  return explicitCorsOrigins.has(normalizeOrigin(origin));
}

export const corsOptionsDelegate: CorsOptionsDelegate<Request> = (req, callback) => {
  const requestOrigin = req.header("Origin");
  const corsOptions: CorsOptions = {
    origin: isAllowedCorsOrigin(req, requestOrigin),
    credentials: true,
    optionsSuccessStatus: 204
  };

  callback(null, corsOptions);
};
