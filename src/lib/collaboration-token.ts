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
  scope: "page:collaborate";
};

export function signCollaborationToken(payload: CollaborationTokenPayload) {
  const options: SignOptions = {
    audience: collaborationAudience,
    issuer: collaborationIssuer,
    expiresIn: collaborationExpiresInSeconds
  };
  return jwt.sign(payload, env.JWT_SECRET as Secret, options);
}

export function verifyCollaborationToken(token: string): CollaborationTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET as Secret, {
      audience: collaborationAudience,
      issuer: collaborationIssuer
    });
    if (
      typeof decoded !== "object" ||
      !decoded.sub ||
      !decoded.username ||
      !decoded.pageId ||
      decoded.scope !== "page:collaborate"
    ) {
      throw new ApiError(401, "INVALID_COLLABORATION_TICKET", "Invalid collaboration ticket");
    }
    return {
      sub: String(decoded.sub),
      username: String(decoded.username),
      pageId: String(decoded.pageId),
      scope: "page:collaborate"
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "INVALID_COLLABORATION_TICKET", "Invalid or expired collaboration ticket");
  }
}

export const collaborationTicketTtlSeconds = collaborationExpiresInSeconds;
