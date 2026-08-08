import bcrypt from "bcryptjs";
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

export function signAuthToken(payload: AuthTokenPayload) {
  const options: SignOptions = {
    algorithm: "HS256",
    audience: authAudience,
    issuer: authIssuer,
    expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"]
  };
  return jwt.sign({ ...payload, authVersion: normalizeAuthVersion(payload.authVersion) }, env.JWT_SECRET as Secret, options);
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
    return {
      sub: String(decoded.sub),
      username: String(decoded.username),
      authVersion: normalizeAuthVersion(decoded.authVersion)
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired authentication token");
  }
}
