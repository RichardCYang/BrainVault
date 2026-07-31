import { z } from "zod";
import { ApiError } from "./http.js";

export const builtInIconPrefix = "icon:";
export const imageIconPrefix = "image:";
export const maxLegacyIconLength = 32;
export const maxCustomIconBytes = 512 * 1024;
export const maxRemoteIconUrlLength = 2048;
export const maxIconValueLength = Math.ceil((maxCustomIconBytes * 4) / 3) + 256;

const builtInIconPattern = /^icon:[a-z0-9-]{1,27}$/;
const imageDataUrlPattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

function hasExpectedImageSignature(mimeType: string, bytes: Buffer) {
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

function normalizeImageIconSource(source: string) {
  const value = source.trim();
  if (value.length <= maxRemoteIconUrlLength) {
    try {
      const url = new URL(value);
      if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) {
        return url.toString();
      }
    } catch {
      // A non-URL source may still be an allowed data URL.
    }
  }

  const match = imageDataUrlPattern.exec(value);
  if (!match) {
    throw new ApiError(400, "INVALID_ICON", "Custom icons must use an HTTP(S) URL or a PNG, JPEG, or WebP data URL");
  }

  const mimeType = `image/${match[1].toLowerCase()}`;
  const payload = match[2];
  const bytes = Buffer.from(payload, "base64");
  if (!bytes.length || bytes.byteLength > maxCustomIconBytes || !hasExpectedImageSignature(mimeType, bytes)) {
    throw new ApiError(400, "INVALID_ICON", "Custom icon image is invalid or too large");
  }

  return `data:${mimeType};base64,${payload}`;
}

export function normalizeIconValue(value: string | null) {
  if (value === null) return null;

  const normalized = value.trim();
  if (!normalized) throw new ApiError(400, "INVALID_ICON", "Icon cannot be empty");

  if (normalized.toLowerCase().startsWith(builtInIconPrefix)) {
    const canonical = normalized.toLowerCase();
    if (!builtInIconPattern.test(canonical)) {
      throw new ApiError(400, "INVALID_ICON", "Built-in icon identifier is invalid");
    }
    return canonical;
  }

  if (normalized.startsWith(imageIconPrefix)) {
    return `${imageIconPrefix}${normalizeImageIconSource(normalized.slice(imageIconPrefix.length))}`;
  }

  if (normalized.length > maxLegacyIconLength) {
    throw new ApiError(400, "INVALID_ICON", "Text and emoji icons must be 32 characters or fewer");
  }
  return normalized;
}

export function isValidIconValue(value: string) {
  try {
    normalizeIconValue(value);
    return true;
  } catch {
    return false;
  }
}

export const iconValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(maxIconValueLength)
  .refine(isValidIconValue, "Icon value is invalid");
