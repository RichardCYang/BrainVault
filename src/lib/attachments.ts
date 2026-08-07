import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { link, lstat, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { env } from "../config/env.js";
import { assessAttachmentFileCountLimit, assessAttachmentStorageLimit } from "./attachment-storage-limit.js";
import { dataTransferResourceLimits } from "./data-transfer-limits.js";
import { ApiError } from "./http.js";
import { transaction, type DbClient } from "./db.js";
import {
  canonicalizeAttachmentMimeType,
  getAttachmentInfo,
  isActiveAttachmentMimeType,
  isBlockedAttachmentFilename,
  normalizeAttachmentMimeType,
  sanitizeAttachmentDownloadFilename,
  sanitizeAttachmentFilename,
  type AttachmentInfo,
  type AttachmentMetadata
} from "./attachment-metadata-integrity.js";

export {
  getAttachmentInfo,
  isBlockedAttachmentFilename,
  normalizeAttachmentMimeType,
  sanitizeAttachmentDownloadFilename,
  sanitizeAttachmentFilename,
  type AttachmentInfo,
  type AttachmentMetadata
};

const projectRoot = path.resolve(process.cwd());
export const attachmentUploadRoot = path.resolve(projectRoot, env.ATTACHMENT_UPLOAD_DIR);
export const attachmentTempDir = path.join(attachmentUploadRoot, ".tmp");
export const maxAttachmentStorageBytes = BigInt(env.ATTACHMENT_STORAGE_MAX_MB) * 1024n * 1024n;
export const maxAttachmentFilesPerAccount = dataTransferResourceLimits.maxAttachments;

function comparablePath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInside(root: string, candidate: string) {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

if (isPathInside(projectRoot, attachmentUploadRoot) && comparablePath(attachmentUploadRoot) === comparablePath(projectRoot)) {
  throw new Error("ATTACHMENT_UPLOAD_DIR cannot be the project root");
}
for (const forbiddenRoot of [path.join(projectRoot, "public"), path.join(projectRoot, "docs"), path.join(projectRoot, ".git")]) {
  if (isPathInside(forbiddenRoot, attachmentUploadRoot)) {
    throw new Error("ATTACHMENT_UPLOAD_DIR must stay outside the public, docs, and .git folders");
  }
}

const signatureKindsByMimeType = new Map<string, Set<string>>([
  ["application/epub+zip", new Set(["zip"])],
  ["application/gzip", new Set(["gzip"])],
  ["application/msword", new Set(["ole"])],
  ["application/pdf", new Set(["pdf"])],
  ["application/rtf", new Set(["rtf"])],
  ["application/vnd.ms-excel", new Set(["ole"])],
  ["application/vnd.ms-powerpoint", new Set(["ole"])],
  ["application/vnd.oasis.opendocument.presentation", new Set(["zip"])],
  ["application/vnd.oasis.opendocument.spreadsheet", new Set(["zip"])],
  ["application/vnd.oasis.opendocument.text", new Set(["zip"])],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", new Set(["zip"])],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", new Set(["zip"])],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", new Set(["zip"])],
  ["application/x-7z-compressed", new Set(["7z"])],
  ["application/x-rar-compressed", new Set(["rar"])],
  ["application/zip", new Set(["zip"])],
  ["audio/flac", new Set(["flac"])],
  ["audio/mp4", new Set(["isobmff"])],
  ["audio/mpeg", new Set(["mp3"])],
  ["audio/ogg", new Set(["ogg"])],
  ["audio/wav", new Set(["wav"])],
  ["audio/webm", new Set(["webm"])],
  ["image/avif", new Set(["isobmff"])],
  ["image/bmp", new Set(["bmp"])],
  ["image/gif", new Set(["gif"])],
  ["image/heic", new Set(["isobmff"])],
  ["image/heif", new Set(["isobmff"])],
  ["image/jpeg", new Set(["jpeg"])],
  ["image/png", new Set(["png"])],
  ["image/tiff", new Set(["tiff"])],
  ["image/webp", new Set(["webp"])],
  ["video/mp4", new Set(["isobmff"])],
  ["video/ogg", new Set(["ogg"])],
  ["video/quicktime", new Set(["isobmff"])],
  ["video/webm", new Set(["webm"])],
  ["video/x-msvideo", new Set(["avi"])]
]);

const detectedMimeTypeBySignature = new Map<string, string>([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
  ["tiff", "image/tiff"],
  ["gzip", "application/gzip"],
  ["7z", "application/x-7z-compressed"],
  ["rar", "application/x-rar-compressed"],
  ["ogg", "audio/ogg"],
  ["wav", "audio/wav"],
  ["flac", "audio/flac"],
  ["mp3", "audio/mpeg"],
  ["webm", "video/webm"]
]);

function safeStorageSegment(value: string) {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!normalized) throw new Error("Attachment storage segment is empty");
  return normalized;
}

function startsWithBytes(value: Buffer, bytes: readonly number[]) {
  return value.length >= bytes.length && bytes.every((byte, index) => value[index] === byte);
}

function detectAttachmentSignature(value: Buffer) {
  if (startsWithBytes(value, [0x4d, 0x5a])) return "executable";
  if (startsWithBytes(value, [0x7f, 0x45, 0x4c, 0x46])) return "executable";
  if (
    startsWithBytes(value, [0xca, 0xfe, 0xba, 0xbe])
    || startsWithBytes(value, [0xce, 0xfa, 0xed, 0xfe])
    || startsWithBytes(value, [0xcf, 0xfa, 0xed, 0xfe])
    || startsWithBytes(value, [0xfe, 0xed, 0xfa, 0xce])
    || startsWithBytes(value, [0xfe, 0xed, 0xfa, 0xcf])
    || startsWithBytes(value, [0x00, 0x61, 0x73, 0x6d])
  ) return "executable";
  if (value.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (startsWithBytes(value, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWithBytes(value, [0xff, 0xd8, 0xff])) return "jpeg";
  if (["GIF87a", "GIF89a"].includes(value.subarray(0, 6).toString("ascii"))) return "gif";
  if (value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (value.subarray(0, 2).toString("ascii") === "BM") return "bmp";
  if (startsWithBytes(value, [0x49, 0x49, 0x2a, 0x00]) || startsWithBytes(value, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (startsWithBytes(value, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(value, [0x50, 0x4b, 0x05, 0x06]) || startsWithBytes(value, [0x50, 0x4b, 0x07, 0x08])) return "zip";
  if (startsWithBytes(value, [0x1f, 0x8b])) return "gzip";
  if (startsWithBytes(value, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
  if (value.subarray(0, 7).toString("binary") === "Rar!\x1a\x07\x00" || value.subarray(0, 8).toString("binary") === "Rar!\x1a\x07\x01\x00") return "rar";
  if (startsWithBytes(value, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (value.subarray(0, 4).toString("ascii") === "OggS") return "ogg";
  if (value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WAVE") return "wav";
  if (value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "AVI ") return "avi";
  if (value.subarray(0, 4).toString("ascii") === "fLaC") return "flac";
  if (value.subarray(0, 3).toString("ascii") === "ID3" || (value.length >= 2 && value[0] === 0xff && (value[1] & 0xe0) === 0xe0)) return "mp3";
  if (value.length >= 12 && value.subarray(4, 8).toString("ascii") === "ftyp") return "isobmff";
  if (startsWithBytes(value, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
  if (value.subarray(0, 5).toString("ascii").toLowerCase() === "{\\rtf") return "rtf";
  return null;
}

export async function createAttachmentFileHash(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function readAttachmentHeader(filePath: string) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(8 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function inspectAttachmentUpload(
  temporaryPath: string,
  clientFilename: string,
  clientMimeType: string
) {
  const originalName = sanitizeAttachmentFilename(clientFilename);
  if (isBlockedAttachmentFilename(originalName)) {
    throw new ApiError(415, "ATTACHMENT_FILENAME_NOT_ALLOWED", "This attachment filename or extension is not allowed");
  }

  const canonicalMimeType = canonicalizeAttachmentMimeType(clientMimeType);
  if (isActiveAttachmentMimeType(canonicalMimeType)) {
    throw new ApiError(415, "ATTACHMENT_MIME_NOT_ALLOWED", "Active web content and executable attachment types are not allowed");
  }

  let mimeType = normalizeAttachmentMimeType(canonicalMimeType);
  const signature = detectAttachmentSignature(await readAttachmentHeader(temporaryPath));
  if (signature === "executable") {
    throw new ApiError(415, "ATTACHMENT_CONTENT_NOT_ALLOWED", "Executable attachment content is not allowed");
  }

  const expectedSignatures = signatureKindsByMimeType.get(mimeType);
  if (expectedSignatures && (!signature || !expectedSignatures.has(signature))) {
    throw new ApiError(415, "ATTACHMENT_CONTENT_TYPE_MISMATCH", "Attachment content does not match its declared media type");
  }

  if (mimeType === "application/octet-stream" && signature) {
    mimeType = detectedMimeTypeBySignature.get(signature) ?? mimeType;
  }

  return { originalName, mimeType };
}

export function formatAttachmentSize(size: number) {
  const bytes = Number.isFinite(size) && size > 0 ? size : 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export async function ensureAttachmentDirectories() {
  await mkdir(attachmentTempDir, { recursive: true });
}

export async function cleanupStaleAttachmentTempFiles(nowMs = Date.now()) {
  await ensureAttachmentDirectories();
  let removed = 0;
  for (const entry of await readdir(attachmentTempDir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(attachmentTempDir, entry.name);
    const info = await lstat(filePath).catch(() => null);
    if (!info || nowMs - info.mtimeMs < env.ATTACHMENT_TEMP_MAX_AGE_MS) continue;
    await rm(filePath, { force: true });
    removed += 1;
  }
  return removed;
}

async function syncPath(value: string) {
  const handle = await open(value, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function getAttachmentFilePath(ownerId: string, blockId: string) {
  return path.join(
    attachmentUploadRoot,
    safeStorageSegment(ownerId),
    safeStorageSegment(blockId)
  );
}

export async function getAttachmentStorageUsage(ownerId: string) {
  const ownerDirectory = path.join(attachmentUploadRoot, safeStorageSegment(ownerId));
  let entries;
  try {
    entries = await readdir(ownerDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { bytes: 0n, files: 0 };
    }
    throw error;
  }

  let totalBytes = 0n;
  let totalFiles = 0;
  for (const entry of entries) {
    const filePath = path.join(ownerDirectory, entry.name);
    const info = await lstat(filePath, { bigint: true });
    if (!info.isFile()) {
      throw new Error(`Attachment storage contains an unsupported entry: ${filePath}`);
    }
    totalBytes += info.size;
    totalFiles += 1;
  }
  return { bytes: totalBytes, files: totalFiles };
}

export function assertAttachmentStorageLimit(
  currentBytes: bigint,
  incomingBytes: bigint,
  currentFiles: number,
  incomingFiles: number
) {
  const byteAssessment = assessAttachmentStorageLimit(currentBytes, incomingBytes, maxAttachmentStorageBytes);
  if (!byteAssessment.accepted) {
    throw new ApiError(
      413,
      "ATTACHMENT_STORAGE_QUOTA_EXCEEDED",
      "The account attachment storage limit has been reached"
    );
  }
  const countAssessment = assessAttachmentFileCountLimit(
    currentFiles,
    incomingFiles,
    maxAttachmentFilesPerAccount
  );
  if (!countAssessment.accepted) {
    throw new ApiError(
      413,
      "ATTACHMENT_FILE_COUNT_LIMIT_EXCEEDED",
      "The account attachment file-count limit has been reached"
    );
  }
  return { bytes: byteAssessment.nextBytes, files: countAssessment.nextFiles };
}

export async function moveAttachmentFile(temporaryPath: string, ownerId: string, blockId: string) {
  const target = getAttachmentFilePath(ownerId, blockId);
  const targetDirectory = path.dirname(target);
  const temporaryDirectory = path.dirname(temporaryPath);
  await mkdir(targetDirectory, { recursive: true });
  let linked = false;
  let sourceRemoved = false;
  try {
    // rename() replaces an existing destination on POSIX. Claim the final path with
    // an exclusive hard link so an ID collision can never overwrite stored bytes.
    await link(temporaryPath, target);
    linked = true;
    await syncPath(target);
    await syncPath(targetDirectory);
    await rm(temporaryPath);
    sourceRemoved = true;
    if (temporaryDirectory !== targetDirectory) await syncPath(temporaryDirectory);
    await syncPath(attachmentUploadRoot);
    return target;
  } catch (error) {
    // Before the temporary name is removed, rolling back the new link restores
    // the original two-copy state. Afterwards the destination is the only live
    // name and must be preserved even when a later directory sync fails.
    if (linked && !sourceRemoved) {
      await rm(target, { force: true }).catch(() => undefined);
      await syncPath(targetDirectory).catch(() => undefined);
    }
    throw error;
  }
}

export async function removeAttachmentPath(filePath: string) {
  await rm(filePath, { force: true }).catch(() => undefined);
}

export async function removeAttachmentFile(ownerId: string, blockId: string) {
  await removeAttachmentPath(getAttachmentFilePath(ownerId, blockId));
}

export async function removeAttachmentFiles(ownerId: string, blockIds: string[]) {
  await Promise.all(blockIds.map((blockId) => removeAttachmentFile(ownerId, blockId)));
}

export async function withUserAttachmentLock<Result>(
  ownerId: string,
  fn: (client: DbClient) => Promise<Result>
) {
  return transaction(async (client) => {
    const user = await client.queryOne<{ id: string }>(
      "SELECT id FROM users WHERE id = ? FOR UPDATE",
      [ownerId]
    );
    if (!user) throw new Error(`Attachment owner does not exist: ${ownerId}`);
    return fn(client);
  });
}

export async function removeDeletedAttachmentFiles(ownerId: string, blockIds: string[]) {
  const uniqueIds = [...new Set(blockIds)];
  if (!uniqueIds.length) return;

  await withUserAttachmentLock(ownerId, async (client) => {
    const existingIds = new Set<string>();
    for (let index = 0; index < uniqueIds.length; index += 500) {
      const group = uniqueIds.slice(index, index + 500);
      const rows = await client.query<{ id: string }>(
        `SELECT b.id
         FROM blocks b INNER JOIN pages p ON p.id = b.page_id
         WHERE p.owner_id = ? AND b.id IN (${group.map(() => "?").join(",")})`,
        [ownerId, ...group]
      );
      for (const row of rows) existingIds.add(row.id);
    }
    await removeAttachmentFiles(ownerId, uniqueIds.filter((id) => !existingIds.has(id)));
  });
}

export async function attachmentFileExists(ownerId: string, blockId: string) {
  try {
    const result = await stat(getAttachmentFilePath(ownerId, blockId));
    return result.isFile();
  } catch {
    return false;
  }
}
