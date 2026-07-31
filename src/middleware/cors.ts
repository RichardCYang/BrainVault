import type { Request } from "express";
import type { CorsOptions, CorsOptionsDelegate } from "cors";
import { corsOrigins, env } from "../config/env.js";

function normalizeOrigin(origin: string) {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.trim();
  }
}

const explicitCorsOrigins = new Set(corsOrigins.map(normalizeOrigin));

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function isLocalDevelopmentOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function isAllowedCorsOrigin(_req: Request, origin?: string) {
  if (!origin) return true;

  const normalizedOrigin = normalizeOrigin(origin);
  if (explicitCorsOrigins.has(normalizedOrigin)) return true;
  return env.NODE_ENV !== "production" && isLocalDevelopmentOrigin(normalizedOrigin);
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
