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

function firstHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.at(0);
  return value;
}

function isSameRequestOrigin(req: Request, origin: string) {
  try {
    const originUrl = new URL(origin);
    const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"]);
    const host = forwardedHost?.split(",").at(0)?.trim() || req.get("host");

    if (!host || originUrl.host !== host) {
      return false;
    }

    const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
    const protocol = (forwardedProto?.split(",").at(0)?.trim() || req.protocol).replace(/:$/, "");
    return originUrl.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}

export function isAllowedCorsOrigin(req: Request, origin?: string) {
  if (!origin) {
    return true;
  }

  const normalizedOrigin = normalizeOrigin(origin);

  if (explicitCorsOrigins.has(normalizedOrigin)) {
    return true;
  }

  if (isSameRequestOrigin(req, normalizedOrigin)) {
    return true;
  }

  if (env.NODE_ENV !== "production" && isLocalDevelopmentOrigin(normalizedOrigin)) {
    return true;
  }

  return false;
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
