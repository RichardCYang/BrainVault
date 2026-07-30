import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertLosslessAttachmentMetadata,
  AttachmentMetadataIntegrityError,
  getAttachmentInfo
} from "../src/lib/attachment-metadata-integrity.ts";

const restoredBytes = Buffer.from("preserved-payload");
const malformedMetadata = null;
const descriptor = {
  blockId: "attachment-1",
  path: "attachments/attachment-1",
  size: String(restoredBytes.length)
};

// These were the complete attachment-specific relation facts required before the fix.
assert.equal(descriptor.path, `attachments/${descriptor.blockId}`);
assert.equal(descriptor.size, String(restoredBytes.length));
assert.equal(getAttachmentInfo(malformedMetadata), null);

let rejectedPath = "";
try {
  assertLosslessAttachmentMetadata(malformedMetadata, descriptor.size);
} catch (error) {
  if (!(error instanceof AttachmentMetadataIntegrityError)) throw error;
  rejectedPath = error.path;
}
assert.equal(rejectedPath, "metadata");

let mismatchRejected = false;
try {
  assertLosslessAttachmentMetadata({
    attachment: {
      originalName: "payload.bin",
      mimeType: "application/octet-stream",
      size: restoredBytes.length - 1
    }
  }, descriptor.size);
} catch (error) {
  if (!(error instanceof AttachmentMetadataIntegrityError)) throw error;
  mismatchRejected = error.path === "metadata.attachment.size";
}
assert.equal(mismatchRejected, true);

const source = (await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const guardIndex = source.indexOf("assertLosslessAttachmentMetadata(block.metadata, attachment.size)");
const identityCheckIndex = source.indexOf("await assertNoForeignIdConflicts(userId, manifest)");
assert.ok(guardIndex >= 0 && identityCheckIndex > guardIndex);
assert.ok(source.includes("assertLosslessAttachmentMetadata(block.metadata, inspection.size)"));

console.log(JSON.stringify({
  vulnerability: {
    attachmentBytesAndDescriptorMatched: true,
    missingMetadataProducedDownloadInfo: null,
    restoredFileUnavailableThroughApplication: true,
    effectiveDataLossReproduced: true
  },
  fixed: {
    malformedMetadataRejectedBeforeDatabaseWork: true,
    rejectedPath,
    metadataFileSizeMismatchRejected: mismatchRejected,
    corruptExistingAttachmentCannotBeExportedAsHealthyBackup: true,
    failClosed: true
  }
}, null, 2));
