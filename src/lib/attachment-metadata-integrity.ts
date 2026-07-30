export type AttachmentInfo = {
  originalName: string;
  mimeType: string;
  size: number;
};

export type AttachmentMetadata = {
  attachment: AttachmentInfo;
};

export class AttachmentMetadataIntegrityError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`${path} ${reason}`);
    this.name = "AttachmentMetadataIntegrityError";
    this.path = path;
    this.reason = reason;
  }
}

function fail(path: string, reason: string): never {
  throw new AttachmentMetadataIntegrityError(path, reason);
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseMetadata(metadata: unknown) {
  if (typeof metadata !== "string") return metadata;
  try {
    return JSON.parse(metadata) as unknown;
  } catch {
    return null;
  }
}

function parseMetadataLosslessly(metadata: unknown) {
  if (typeof metadata !== "string") return metadata;
  try {
    return JSON.parse(metadata) as unknown;
  } catch {
    fail("metadata", "is not valid JSON");
  }
}

function parseExpectedSize(value: string | number | bigint) {
  if (typeof value === "bigint") {
    if (value < 0n) fail("attachment.size", "must not be negative");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("attachment.size", "is not a non-negative safe integer");
    }
    return BigInt(value);
  }
  if (!/^\d+$/.test(value)) fail("attachment.size", "is not a decimal byte count");
  return BigInt(value);
}

export function sanitizeAttachmentFilename(value: string) {
  const basename = String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();

  const safeName = !basename || basename === "." || basename === ".." ? "attachment" : basename;
  return safeName.slice(0, 255);
}

export function normalizeAttachmentMimeType(value: string) {
  const mimeType = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType)
    ? mimeType.slice(0, 255)
    : "application/octet-stream";
}

export function getAttachmentInfo(metadata: unknown): AttachmentInfo | null {
  const source = record(parseMetadata(metadata));
  const attachment = record(source?.attachment);
  if (!attachment) return null;

  const originalName = sanitizeAttachmentFilename(
    typeof attachment.originalName === "string" ? attachment.originalName : ""
  );
  const mimeType = normalizeAttachmentMimeType(
    typeof attachment.mimeType === "string" ? attachment.mimeType : ""
  );
  const size = typeof attachment.size === "number"
    && Number.isSafeInteger(attachment.size)
    && attachment.size >= 0
    ? attachment.size
    : 0;
  return { originalName, mimeType, size };
}

export function assertLosslessAttachmentMetadata(
  metadata: unknown,
  expectedSize?: string | number | bigint
): AttachmentInfo {
  const source = record(parseMetadataLosslessly(metadata));
  if (!source) fail("metadata", "must be an object");

  const attachment = record(source.attachment);
  if (!attachment) fail("metadata.attachment", "must be an object");

  if (typeof attachment.originalName !== "string") {
    fail("metadata.attachment.originalName", "must be a string");
  }
  const originalName = sanitizeAttachmentFilename(attachment.originalName);
  if (originalName !== attachment.originalName) {
    fail("metadata.attachment.originalName", "is not in the canonical lossless filename form");
  }

  if (typeof attachment.mimeType !== "string") {
    fail("metadata.attachment.mimeType", "must be a string");
  }
  const mimeType = normalizeAttachmentMimeType(attachment.mimeType);
  if (mimeType !== attachment.mimeType) {
    fail("metadata.attachment.mimeType", "is not in the canonical lossless MIME type form");
  }

  if (typeof attachment.size !== "number"
    || !Number.isSafeInteger(attachment.size)
    || attachment.size < 0) {
    fail("metadata.attachment.size", "must be a non-negative safe integer");
  }
  if (expectedSize !== undefined && BigInt(attachment.size) !== parseExpectedSize(expectedSize)) {
    fail("metadata.attachment.size", "does not match the attachment file byte count");
  }

  return { originalName, mimeType, size: attachment.size };
}
