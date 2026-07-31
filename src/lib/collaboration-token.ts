import jwt, { type Secret, type SignOptions } from "jsonwebtoken";
import { env } from "../config/env.js";
import { ApiError } from "./http.js";

const collaborationAudience = "brainvault-page-collaboration";
const collaborationIssuer = "brainvault";
const collaborationExpiresInSeconds = 120;

export type CollaborationTokenPayload = {
  sub: string;
  username: string;
  pageId: string;
  documentEpoch: string;
  authVersion: number;
  scope: "page:collaborate";
};

export function signCollaborationToken(payload: CollaborationTokenPayload) {
  const options: SignOptions = {
    algorithm: "HS256",
    audience: collaborationAudience,
    issuer: collaborationIssuer,
    expiresIn: collaborationExpiresInSeconds
  };
  return jwt.sign(payload, env.JWT_SECRET as Secret, options);
}

export function verifyCollaborationToken(token: string): CollaborationTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET as Secret, {
      algorithms: ["HS256"],
      audience: collaborationAudience,
      issuer: collaborationIssuer
    });
    if (
      typeof decoded !== "object" ||
      !decoded.sub ||
      !decoded.username ||
      !decoded.pageId ||
      typeof decoded.documentEpoch !== "string" ||
      !decoded.documentEpoch ||
      decoded.documentEpoch.length > 64 ||
      !Number.isSafeInteger(Number(decoded.authVersion)) ||
      Number(decoded.authVersion) < 1 ||
      decoded.scope !== "page:collaborate"
    ) {
      throw new ApiError(401, "INVALID_COLLABORATION_TICKET", "Invalid collaboration ticket");
    }
    return {
      sub: String(decoded.sub),
      username: String(decoded.username),
      pageId: String(decoded.pageId),
      documentEpoch: decoded.documentEpoch,
      authVersion: Number(decoded.authVersion),
      scope: "page:collaborate"
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "INVALID_COLLABORATION_TICKET", "Invalid or expired collaboration ticket");
  }
}

export const collaborationTicketTtlSeconds = collaborationExpiresInSeconds;
