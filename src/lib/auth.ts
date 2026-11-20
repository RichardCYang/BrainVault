import bcrypt from "bcryptjs";
import { createId } from "./id.js";
import jwt, { type Secret, type SignOptions } from "jsonwebtoken";
import { env } from "../config/env.js";
import { ApiError } from "./http.js";
import {
  assertPasswordWithinBcryptLimit,
  isPasswordWithinBcryptLimit
} from "./password-policy.js";

const authAudience = "brainvault-api";
const authIssuer = "brainvault";

export type AuthTokenPayload = {
  sub: string;
  username: string;
  authVersion: number;
  sessionId?: string;
  authenticatedAt?: number;
};

export function normalizeAuthVersion(value: unknown) {
  const version = Number(value ?? 1);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid authentication token");
  }
  return version;
}

function bcryptWouldTruncate(password: string) {
  return bcrypt.truncates(password) || !isPasswordWithinBcryptLimit(password);
}

export function hashPassword(password: string) {
  const libraryWouldTruncate = bcrypt.truncates(password);
  assertPasswordWithinBcryptLimit(password);
  if (libraryWouldTruncate) {
    throw new RangeError("Password exceeds the bcrypt input limit");
  }
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, passwordHash: string) {
  if (bcryptWouldTruncate(password)) return Promise.resolve(false);
  return bcrypt.compare(password, passwordHash);
}

const authTokenLifetimeUnitMs = { s: 1_000, m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 } as const;

// JWT_EXPIRES_IN is validated as <digits><s|m|h|d> by the environment schema.
export function getAuthTokenLifetimeMs() {
  const value = String(env.JWT_EXPIRES_IN);
  const unit = value.at(-1) as keyof typeof authTokenLifetimeUnitMs;
  return Number(value.slice(0, -1)) * authTokenLifetimeUnitMs[unit];
}

export function signAuthToken(payload: AuthTokenPayload, { expiresAt }: { expiresAt?: Date } = {}) {
  const options: SignOptions = {
    algorithm: "HS256",
    audience: authAudience,
    issuer: authIssuer
  };
  // An extended session keeps its id but may be capped below the usual
  // lifetime, so it carries an explicit expiry instead of a relative one.
  const exp = expiresAt ? Math.floor(expiresAt.getTime() / 1000) : null;
  if (exp === null) options.expiresIn = env.JWT_EXPIRES_IN as SignOptions["expiresIn"];
  else if (!Number.isSafeInteger(exp) || exp * 1000 <= Date.now()) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid authentication token");
  }
  const sessionId = payload.sessionId ?? createId("ses");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid authentication token");
  }
  return jwt.sign(
    {
      ...payload,
      authenticatedAt: payload.authenticatedAt ?? Math.floor(Date.now() / 1000),
      authVersion: normalizeAuthVersion(payload.authVersion),
      sessionId,
      ...(exp === null ? {} : { exp })
    },
    env.JWT_SECRET as Secret,
    options
  );
}

export function getAuthTokenExpiresAt(token: string) {
  const decoded = jwt.decode(token);
  if (typeof decoded !== "object" || !decoded || typeof decoded.exp !== "number") return null;
  const expiresAt = new Date(decoded.exp * 1000);
  return Number.isFinite(expiresAt.getTime()) ? expiresAt : null;
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET as Secret, {
      algorithms: ["HS256"],
      audience: authAudience,
      issuer: authIssuer
    });
    if (typeof decoded !== "object" || !decoded.sub || !decoded.username) {
      throw new ApiError(401, "INVALID_TOKEN", "Invalid authentication token");
    }
    const sessionId = decoded.sessionId === undefined ? undefined : String(decoded.sessionId);
    if (sessionId !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) {
      throw new ApiError(401, "INVALID_TOKEN", "Invalid authentication token");
    }
    return {
      authenticatedAt: Number.isSafeInteger(decoded.authenticatedAt) ? decoded.authenticatedAt : 0,
      sub: String(decoded.sub),
      username: String(decoded.username),
      authVersion: normalizeAuthVersion(decoded.authVersion),
      ...(sessionId ? { sessionId } : {})
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired authentication token");
  }
}
