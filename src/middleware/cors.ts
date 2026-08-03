import type { Request } from "express";
import type { CorsOptions, CorsOptionsDelegate } from "cors";
import { corsOrigins } from "../config/env.js";
import { createExactHttpOriginSet, parseExactHttpOrigin } from "../lib/request-origin.js";

const explicitCorsOrigins = createExactHttpOriginSet(corsOrigins);

export function isAllowedCorsOrigin(_req: Request, origin?: string) {
  if (!origin) return true;
  const parsedOrigin = parseExactHttpOrigin(origin);
  return parsedOrigin !== null && explicitCorsOrigins.has(parsedOrigin);
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
