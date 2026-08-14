import { createHash } from "node:crypto";
import { z } from "zod";
import { isPrivateOrLocalHostname } from "./network-address.js";

export const maxCustomCoverImageBytes = 2 * 1024 * 1024;
export const maxPageCoverUrlLength = Math.ceil((maxCustomCoverImageBytes * 4) / 3) + 128;
export const defaultPageCoverPaths = Object.freeze(
  Array.from({ length: 5 }, (_, index) => `/img/default_cover/coverimg${index + 1}.png`)
);

const defaultPageCoverPathSet = new Set(defaultPageCoverPaths);
const supportedCustomCoverMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const dataUrlPattern = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/;

export const storedCustomPageCoverSentinel = "custom-image:stored";

export function isCustomPageCoverValue(value: string | null | undefined) {
  return Boolean(
    value === storedCustomPageCoverSentinel
      || value?.startsWith("data:image/png;base64,")
      || value?.startsWith("data:image/jpeg;base64,")
      || value?.startsWith("data:image/webp;base64,")
  );
}

export function toPublicPageCoverUrl(
  pageId: string,
  value: string | null,
  pageVersion: number
) {
  if (!value) return null;
  if (!isCustomPageCoverValue(value)) return value;
  const version = Number.isSafeInteger(pageVersion) && pageVersion > 0 ? pageVersion : 1;
  return `/api/pages/${encodeURIComponent(pageId)}/cover?v=${version}`;
}

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

export function inspectCustomCoverBytes(mimeType: string, bytes: Buffer) {
  if (!supportedCustomCoverMimeTypes.has(mimeType)) {
    throw new Error("Cover image type is unsupported");
  }
  if (!bytes.length || bytes.length > maxCustomCoverImageBytes) {
    throw new Error("Cover image is too large");
  }
  if (!hasExpectedSignature(mimeType, bytes)) {
    throw new Error("Cover image content does not match its declared type");
  }
  return { mimeType, bytes };
}

export function createCustomCoverDataUrl(mimeType: string, bytes: Buffer) {
  inspectCustomCoverBytes(mimeType, bytes);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

export function inspectCustomCoverDataUrl(value: string) {
  const match = dataUrlPattern.exec(value);
  if (!match) throw new Error("Cover image must be a base64 PNG, JPEG, or WebP data URL");
  const [, mimeType, encoded] = match;
  if (!supportedCustomCoverMimeTypes.has(mimeType) || encoded.length % 4 !== 0) {
    throw new Error("Cover image encoding is invalid");
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error("Cover image encoding is invalid");
  }
  return inspectCustomCoverBytes(mimeType, bytes);
}

export function normalizePageCoverUrl(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxPageCoverUrlLength) {
    throw new Error("Cover image URL is invalid");
  }
  if (defaultPageCoverPathSet.has(normalized)) return normalized;
  if (normalized.startsWith("data:")) {
    inspectCustomCoverDataUrl(normalized);
    return normalized;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Cover image URL is invalid");
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || normalized.length > 2048) {
    throw new Error("Cover image URL must use HTTP or HTTPS");
  }
  if (isPrivateOrLocalHostname(parsed.hostname)) {
    throw new Error("Cover image URL must not target a private or local host");
  }
  return normalized;
}

export const pageCoverUrlSchema = z
  .string()
  .trim()
  .max(maxPageCoverUrlLength)
  .transform((value, context) => {
    try {
      return normalizePageCoverUrl(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Cover image URL is invalid"
      });
      return z.NEVER;
    }
  });

export const pageCoverPositionSchema = z.number().int().min(0).max(100);

export function describePageCoverUrlForHistory(value: string | null) {
  if (!value || !value.startsWith("data:")) return value;
  try {
    const { mimeType, bytes } = inspectCustomCoverDataUrl(value);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return `custom-image:${mimeType}:${bytes.length}:${digest}`;
  } catch {
    return "custom-image:invalid";
  }
}
