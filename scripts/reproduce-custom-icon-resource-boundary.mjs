import assert from "node:assert/strict";
import { assessCustomIconStorageLimit } from "../src/lib/custom-icon-storage-limit.ts";

const maxCustomIconBytes = 512 * 1024;
const defaultGlobalRequestsPerMinute = 120;
const defaultStorageBytes = 64n * 1024n * 1024n;
const defaultStorageFiles = 2_048;

function makeInlinePngIcon(fillByte) {
  const bytes = Buffer.alloc(maxCustomIconBytes, fillByte);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  return `image:data:image/png;base64,${bytes.toString("base64")}`;
}

const before = makeInlinePngIcon(0x41);
const after = makeInlinePngIcon(0x42);
const modeledVersionChangeBytes = Buffer.byteLength(JSON.stringify([
  { kind: "page-updated", fields: [{ field: "icon", before, after }] }
]));
const modeledHistoryBytesPerMinute = modeledVersionChangeBytes * defaultGlobalRequestsPerMinute;
const modeledUploadBytesPerMinute = maxCustomIconBytes * defaultGlobalRequestsPerMinute;

const exactQuotaBoundary = assessCustomIconStorageLimit(
  defaultStorageBytes - BigInt(maxCustomIconBytes),
  BigInt(maxCustomIconBytes),
  defaultStorageFiles - 1,
  1,
  defaultStorageBytes,
  defaultStorageFiles
);
const byteOverflowRejected = assessCustomIconStorageLimit(
  defaultStorageBytes,
  1n,
  defaultStorageFiles,
  0,
  defaultStorageBytes,
  defaultStorageFiles
);
const fileOverflowRejected = assessCustomIconStorageLimit(
  0n,
  1n,
  defaultStorageFiles,
  1,
  defaultStorageBytes,
  defaultStorageFiles
);

assert.equal(exactQuotaBoundary.accepted, true);
assert.deepEqual(byteOverflowRejected, { accepted: false, reason: "quota-exceeded" });
assert.deepEqual(fileOverflowRejected, { accepted: false, reason: "file-count-exceeded" });

console.log(JSON.stringify({
  vulnerableModel: {
    customIconFileSizeBytes: maxCustomIconBytes,
    defaultGlobalRequestsPerMinute,
    persistentUploadMiBPerMinuteWithoutAccountQuota: modeledUploadBytesPerMinute / 1024 / 1024,
    pageVersionChangeBytesPerInlineIconSwap: modeledVersionChangeBytes,
    pageVersionHistoryMiBPerMinuteAtGlobalLimit: modeledHistoryBytesPerMinute / 1024 / 1024
  },
  fixedBoundary: {
    defaultCustomIconStorageMiBPerAccount: Number(defaultStorageBytes / 1024n / 1024n),
    defaultCustomIconFilesPerAccount: defaultStorageFiles,
    exactQuotaBoundaryAccepted: exactQuotaBoundary.accepted,
    byteOverflowRejected,
    fileOverflowRejected,
    newInlineImageIconMutations: "rejected-by-iconMutationValueSchema"
  }
}, null, 2));
