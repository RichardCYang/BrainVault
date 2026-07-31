import bcrypt from "bcryptjs";
import jwt, { type Secret, type SignOptions } from "jsonwebtoken";
import { env } from "../config/env.js";
import { ApiError } from "./http.js";

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

export const hashPassword = (password: string) => bcrypt.hash(password, 12);

export const verifyPassword = (password: string, passwordHash: string) =>
  bcrypt.compare(password, passwordHash);

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
