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

const safeAttachmentMimeTypes = new Set([
  "application/epub+zip",
  "application/gzip",
  "application/json",
  "application/msword",
  "application/octet-stream",
  "application/pdf",
  "application/rtf",
  "application/vnd.apple.keynote",
  "application/vnd.apple.numbers",
  "application/vnd.apple.pages",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/x-tar",
  "application/zip",
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
  "video/mp4",
  "video/mpeg",
  "video/ogg",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo"
]);

const activeAttachmentMimeTypes = new Set([
  "application/hta",
  "application/java-archive",
  "application/javascript",
  "application/vnd.microsoft.portable-executable",
  "application/wasm",
  "application/x-httpd-php",
  "application/x-msdos-program",
  "application/x-msdownload",
  "application/x-sh",
  "application/x-shockwave-flash",
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "text/html",
  "text/javascript",
  "text/xml",
  "text/x-shellscript"
]);

const blockedAttachmentExtensions = new Set([
  "apk", "app", "application", "appinstaller", "asp", "aspx", "bat", "bash", "cgi", "chm", "cmd",
  "com", "cpl", "crt", "desktop", "dll", "dmg", "exe", "gadget", "hta", "htm", "html", "iso",
  "jar", "jnlp", "js", "jse", "jsp", "lnk", "mjs", "msi", "msp", "mst", "phtml", "php", "phar",
  "pif", "pl", "ps1", "py", "rb", "reg", "scf", "scr", "sct", "sh", "shs", "shtml", "svg", "svgz",
  "swf", "url", "vbs", "vbe", "wasm", "wsf", "wsh", "xhtml", "xml", "xsl", "xslt", "zsh"
]);

const unsafeAttachmentFilenameFormatting = /[\u0000-\u001f\u007f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

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
    ?.replace(unsafeAttachmentFilenameFormatting, "_")
    .trim();

  const safeName = !basename || basename === "." || basename === ".." ? "attachment" : basename;
  return safeName.slice(0, 255);
}

export function canonicalizeAttachmentMimeType(value: string) {
  const mimeType = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType)
    ? mimeType.slice(0, 255)
    : "application/octet-stream";
}

export function normalizeAttachmentMimeType(value: string) {
  const mimeType = canonicalizeAttachmentMimeType(value);
  return safeAttachmentMimeTypes.has(mimeType) ? mimeType : "application/octet-stream";
}

export function isSafeAttachmentMimeType(value: string) {
  return safeAttachmentMimeTypes.has(canonicalizeAttachmentMimeType(value));
}

export function isActiveAttachmentMimeType(value: string) {
  return activeAttachmentMimeTypes.has(canonicalizeAttachmentMimeType(value));
}

export function isBlockedAttachmentFilename(value: string) {
  const filename = sanitizeAttachmentFilename(value).trim().replace(/[. ]+$/g, "").toLowerCase();
  if (!filename) return true;
  if ([".htaccess", ".htpasswd", "crossdomain.xml", "clientaccesspolicy.xml"].includes(filename)) return true;
  const extension = filename.includes(".") ? filename.split(".").pop() ?? "" : "";
  return blockedAttachmentExtensions.has(extension);
}

export function sanitizeAttachmentDownloadFilename(value: string) {
  const filename = sanitizeAttachmentFilename(value);
  if (!isBlockedAttachmentFilename(filename)) return filename;
  const suffix = ".download";
  return `${filename.slice(0, 255 - suffix.length)}${suffix}`;
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
  const mimeType = canonicalizeAttachmentMimeType(attachment.mimeType);
  if (mimeType !== attachment.mimeType) {
    fail("metadata.attachment.mimeType", "is not in the canonical lossless MIME type form");
  }
  if (isBlockedAttachmentFilename(originalName)) {
    fail("metadata.attachment.originalName", "uses a blocked filename or extension");
  }
  if (isActiveAttachmentMimeType(mimeType)) {
    fail("metadata.attachment.mimeType", "uses an active web or executable MIME type");
  }
  if (!isSafeAttachmentMimeType(mimeType)) {
    fail("metadata.attachment.mimeType", "uses a MIME type that is not allowed for attachments");
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
