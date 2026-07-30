import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertLosslessAttachmentMetadata,
  AttachmentMetadataIntegrityError,
  getAttachmentInfo
} from "../src/lib/attachment-metadata-integrity.ts";

const validMetadata = {
  attachment: {
    originalName: "계획서.pdf",
    mimeType: "application/pdf",
    size: 17
  }
};

test("a checksummed attachment with missing metadata was accepted but is unavailable to downloads", () => {
  const restoredBytes = Buffer.from("preserved-payload");
  assert.equal(restoredBytes.length, 17);

  // The pre-fix relation checks only matched block IDs, paths, checksums and file sizes.
  assert.doesNotThrow(() => JSON.parse("null"));
  assert.equal(getAttachmentInfo(null), null);

  assert.throws(
    () => assertLosslessAttachmentMetadata(null, restoredBytes.length),
    (error) => error instanceof AttachmentMetadataIntegrityError && error.path === "metadata"
  );
});

test("valid canonical attachment metadata is accepted and remains readable", () => {
  assert.deepEqual(assertLosslessAttachmentMetadata(validMetadata, "17"), validMetadata.attachment);
  assert.deepEqual(getAttachmentInfo(JSON.stringify(validMetadata)), validMetadata.attachment);
});

test("restore rejects missing, double-encoded, or normalizing attachment metadata", () => {
  const invalidCases = [
    [{}, "metadata.attachment"],
    [JSON.stringify(JSON.stringify(validMetadata)), "metadata"],
    [{ attachment: { ...validMetadata.attachment, originalName: "../계획서.pdf" } }, "metadata.attachment.originalName"],
    [{ attachment: { ...validMetadata.attachment, mimeType: " Application/PDF " } }, "metadata.attachment.mimeType"],
    [{ attachment: { ...validMetadata.attachment, size: Number.MAX_SAFE_INTEGER + 1 } }, "metadata.attachment.size"]
  ];

  for (const [metadata, expectedPath] of invalidCases) {
    assert.throws(
      () => assertLosslessAttachmentMetadata(metadata, 17),
      (error) => error instanceof AttachmentMetadataIntegrityError && error.path === expectedPath
    );
  }
});

test("restore and export reject metadata whose size disagrees with stored bytes", () => {
  assert.throws(
    () => assertLosslessAttachmentMetadata(validMetadata, "18"),
    (error) => error instanceof AttachmentMetadataIntegrityError
      && error.path === "metadata.attachment.size"
      && error.reason.includes("byte count")
  );
});

test("integration validates attachment metadata before restore identity checks and before backup completion", async () => {
  const [source, attachmentsSource] = await Promise.all([
    readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/attachments.ts", import.meta.url), "utf8")
  ]).then((values) => values.map((value) => value.replace(/\r\n/g, "\n")));
  const relationStart = source.indexOf("function validateManifestRelations");
  const relationEnd = source.indexOf("export async function prepareUserDataBackup", relationStart);
  const relation = source.slice(relationStart, relationEnd);
  const prepareStart = relationEnd;
  const prepareEnd = source.indexOf("export async function writeUserDataBackup", prepareStart);
  const prepare = source.slice(prepareStart, prepareEnd);

  assert.match(relation, /assertLosslessAttachmentMetadata\(block\.metadata, attachment\.size\)/);
  assert.ok(
    source.indexOf("validateManifestRelations(manifest)")
      < source.indexOf("await assertNoForeignIdConflicts(userId, manifest)"),
    "attachment metadata must fail before restore reaches database identity checks"
  );
  assert.match(prepare, /assertLosslessAttachmentMetadata\(block\.metadata, inspection\.size\)/);
  assert.match(prepare, /BACKUP_ATTACHMENT_METADATA_INVALID/);
  assert.match(attachmentsSource, /from "\.\/attachment-metadata-integrity\.js"/);
  assert.doesNotMatch(attachmentsSource, /export function getAttachmentInfo/);
});
