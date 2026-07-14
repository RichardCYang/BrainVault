import path from "node:path";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { env } from "../config/env.js";

export type AttachmentInfo = {
  originalName: string;
  mimeType: string;
  size: number;
};

export type AttachmentMetadata = {
  attachment: AttachmentInfo;
};

const projectRoot = path.resolve(process.cwd());
export const attachmentUploadRoot = path.resolve(projectRoot, env.ATTACHMENT_UPLOAD_DIR);
export const attachmentTempDir = path.join(attachmentUploadRoot, ".tmp");

if (attachmentUploadRoot === projectRoot) {
  throw new Error("ATTACHMENT_UPLOAD_DIR cannot be the project root");
}
for (const forbiddenRoot of [path.join(projectRoot, "public"), path.join(projectRoot, "docs"), path.join(projectRoot, ".git")]) {
  if (attachmentUploadRoot === forbiddenRoot || attachmentUploadRoot.startsWith(`${forbiddenRoot}${path.sep}`)) {
    throw new Error("ATTACHMENT_UPLOAD_DIR must stay outside the public, docs, and .git folders");
  }
}

function safeStorageSegment(value: string) {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!normalized) throw new Error("Attachment storage segment is empty");
  return normalized;
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

export function getAttachmentInfo(metadata: unknown): AttachmentInfo | null {
  let parsedMetadata = metadata;
  if (typeof metadata === "string") {
    try {
      parsedMetadata = JSON.parse(metadata) as unknown;
    } catch {
      parsedMetadata = null;
    }
  }

  const source = parsedMetadata && typeof parsedMetadata === "object" && !Array.isArray(parsedMetadata)
    ? (parsedMetadata as Record<string, unknown>)
    : null;
  const attachment = source?.attachment;
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return null;

  const value = attachment as Record<string, unknown>;
  const originalName = sanitizeAttachmentFilename(typeof value.originalName === "string" ? value.originalName : "");
  const mimeType = normalizeAttachmentMimeType(typeof value.mimeType === "string" ? value.mimeType : "");
  const size = typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : 0;
  return { originalName, mimeType, size };
}

export async function ensureAttachmentDirectories() {
  await mkdir(attachmentTempDir, { recursive: true });
}

export function getAttachmentFilePath(ownerId: string, blockId: string) {
  return path.join(
    attachmentUploadRoot,
    safeStorageSegment(ownerId),
    safeStorageSegment(blockId)
  );
}

export async function moveAttachmentFile(temporaryPath: string, ownerId: string, blockId: string) {
  const target = getAttachmentFilePath(ownerId, blockId);
  await mkdir(path.dirname(target), { recursive: true });
  await rename(temporaryPath, target);
  return target;
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

export async function attachmentFileExists(ownerId: string, blockId: string) {
  try {
    const result = await stat(getAttachmentFilePath(ownerId, blockId));
    return result.isFile();
  } catch {
    return false;
  }
}
