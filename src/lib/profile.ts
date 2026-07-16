import { ApiError } from "./http.js";

export const supportedProfileLanguages = ["en", "ja", "ko", "fr", "de", "es", "pt"] as const;
export type SupportedProfileLanguage = (typeof supportedProfileLanguages)[number];

export const maxAvatarBytes = 512 * 1024;
const avatarDataUrlPattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

function hasExpectedSignature(mimeType: string, bytes: Buffer) {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}

export function normalizeAvatarDataUrl(value: string | null) {
  if (value === null) return null;

  const match = avatarDataUrlPattern.exec(value.trim());
  if (!match) {
    throw new ApiError(400, "INVALID_AVATAR", "Avatar must be a PNG, JPEG, or WebP data URL");
  }

  const mimeType = `image/${match[1].toLowerCase()}`;
  const payload = match[2];
  const bytes = Buffer.from(payload, "base64");
  if (!bytes.length || bytes.byteLength > maxAvatarBytes || !hasExpectedSignature(mimeType, bytes)) {
    throw new ApiError(400, "INVALID_AVATAR", "Avatar image is invalid or too large");
  }

  return `data:${mimeType};base64,${payload}`;
}
