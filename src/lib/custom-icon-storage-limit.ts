export type CustomIconStorageLimitAssessment =
  | Readonly<{ accepted: true; nextBytes: bigint; nextFiles: number }>
  | Readonly<{ accepted: false; reason: "quota-exceeded" | "file-count-exceeded" }>;

function assertNonNegativeSafeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

export function assessCustomIconStorageLimit(
  currentBytes: bigint,
  incomingBytes: bigint,
  currentFiles: number,
  incomingFiles: number,
  maximumBytes: bigint,
  maximumFiles: number
): CustomIconStorageLimitAssessment {
  if (currentBytes < 0n || incomingBytes < 0n || maximumBytes < 0n) {
    throw new TypeError("Custom icon storage byte counts must be non-negative");
  }
  assertNonNegativeSafeInteger(currentFiles, "Current custom icon file count");
  assertNonNegativeSafeInteger(incomingFiles, "Incoming custom icon file count");
  assertNonNegativeSafeInteger(maximumFiles, "Maximum custom icon file count");

  if (currentBytes > maximumBytes || incomingBytes > maximumBytes - currentBytes) {
    return { accepted: false, reason: "quota-exceeded" };
  }
  if (currentFiles > maximumFiles || incomingFiles > maximumFiles - currentFiles) {
    return { accepted: false, reason: "file-count-exceeded" };
  }
  return {
    accepted: true,
    nextBytes: currentBytes + incomingBytes,
    nextFiles: currentFiles + incomingFiles
  };
}
