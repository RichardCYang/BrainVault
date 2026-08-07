export type AttachmentStorageLimitAssessment =
  | Readonly<{ accepted: true; nextBytes: bigint }>
  | Readonly<{ accepted: false; reason: "quota-exceeded" }>;

export type AttachmentFileCountLimitAssessment =
  | Readonly<{ accepted: true; nextFiles: number }>
  | Readonly<{ accepted: false; reason: "file-count-exceeded" }>;

export function assessAttachmentStorageLimit(
  currentBytes: bigint,
  incomingBytes: bigint,
  maximumBytes: bigint
): AttachmentStorageLimitAssessment {
  if (currentBytes < 0n || incomingBytes < 0n || maximumBytes < 0n) {
    throw new TypeError("Attachment storage byte counts must be non-negative");
  }
  if (currentBytes > maximumBytes || incomingBytes > maximumBytes - currentBytes) {
    return { accepted: false, reason: "quota-exceeded" };
  }
  return { accepted: true, nextBytes: currentBytes + incomingBytes };
}

export function assessAttachmentFileCountLimit(
  currentFiles: number,
  incomingFiles: number,
  maximumFiles: number
): AttachmentFileCountLimitAssessment {
  if (
    !Number.isSafeInteger(currentFiles)
    || !Number.isSafeInteger(incomingFiles)
    || !Number.isSafeInteger(maximumFiles)
    || currentFiles < 0
    || incomingFiles < 0
    || maximumFiles < 0
  ) {
    throw new TypeError("Attachment file counts must be non-negative safe integers");
  }
  if (currentFiles > maximumFiles || incomingFiles > maximumFiles - currentFiles) {
    return { accepted: false, reason: "file-count-exceeded" };
  }
  return { accepted: true, nextFiles: currentFiles + incomingFiles };
}
