import { createHash } from "node:crypto";
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
  shareGeneration: string | null;
  authVersion: number;
  workspaceGeneration: number;
  sessionBinding: string;
  scope: "page:collaborate";
  webRtcState?: "ABSENT" | "AVAILABLE" | "DISABLED" | "UNAVAILABLE";
  webRtcObservedIps?: string[];
};

export function createCollaborationSessionBinding(authSessionToken: string) {
  return createHash("sha256").update(authSessionToken, "utf8").digest("hex");
}

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
      (
        decoded.shareGeneration !== null
        && (
          typeof decoded.shareGeneration !== "string"
          || !decoded.shareGeneration
          || decoded.shareGeneration.length > 64
        )
      ) ||
      !Number.isSafeInteger(Number(decoded.authVersion)) ||
      Number(decoded.authVersion) < 1 ||
      !Number.isSafeInteger(Number(decoded.workspaceGeneration)) ||
      Number(decoded.workspaceGeneration) < 1 ||
      typeof decoded.sessionBinding !== "string" ||
      !/^[0-9a-f]{64}$/.test(decoded.sessionBinding) ||
      decoded.scope !== "page:collaborate"
    ) {
      throw new ApiError(401, "INVALID_COLLABORATION_TICKET", "Invalid collaboration ticket");
    }
    const webRtcState = decoded.webRtcState === undefined ? "ABSENT" : String(decoded.webRtcState);
    if (!["ABSENT", "AVAILABLE", "DISABLED", "UNAVAILABLE"].includes(webRtcState)) {
      throw new ApiError(401, "INVALID_COLLABORATION_TICKET", "Invalid collaboration ticket");
    }
    const webRtcObservedIps = decoded.webRtcObservedIps === undefined ? [] : decoded.webRtcObservedIps;
    if (
      !Array.isArray(webRtcObservedIps)
      || webRtcObservedIps.length > 4
      || webRtcObservedIps.some((value) => typeof value !== "string" || !value || value.length > 64)
      || (webRtcState === "AVAILABLE" && webRtcObservedIps.length === 0)
      || (webRtcState !== "AVAILABLE" && webRtcObservedIps.length > 0)
    ) {
      throw new ApiError(401, "INVALID_COLLABORATION_TICKET", "Invalid collaboration ticket");
    }
    return {
      sub: String(decoded.sub),
      username: String(decoded.username),
      pageId: String(decoded.pageId),
      documentEpoch: decoded.documentEpoch,
      shareGeneration: decoded.shareGeneration === null ? null : decoded.shareGeneration,
      authVersion: Number(decoded.authVersion),
      workspaceGeneration: Number(decoded.workspaceGeneration),
      sessionBinding: decoded.sessionBinding,
      scope: "page:collaborate",
      webRtcState: webRtcState as CollaborationTokenPayload["webRtcState"],
      webRtcObservedIps: webRtcObservedIps.map(String)
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "INVALID_COLLABORATION_TICKET", "Invalid or expired collaboration ticket");
  }
}

export const collaborationTicketTtlSeconds = collaborationExpiresInSeconds;
