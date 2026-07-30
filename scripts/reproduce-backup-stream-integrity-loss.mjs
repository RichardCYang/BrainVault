import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { crc32, ZipWriter } from "../src/lib/zip.ts";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

const inspected = Buffer.from("canonical attachment bytes", "utf8");
const changed = Buffer.from("tampered--attachment bytes", "utf8");
assert.equal(changed.length, inspected.length);

const expectedCrc32 = crc32(inspected);
const expectedSha256 = sha256(inspected);
const changedCrc32 = crc32(changed);
const changedSha256 = sha256(changed);

// Pre-fix model: ZipWriter checked only byte count and copied the already
// inspected CRC into both headers. A same-size mutation therefore completed,
// but BrainVault restore rejected the payload later.
const vulnerableWriterAccepted = changed.length === inspected.length;
const vulnerableRestoreAccepted =
  changedCrc32 === expectedCrc32 && changedSha256 === expectedSha256;
assert.equal(vulnerableWriterAccepted, true);
assert.equal(vulnerableRestoreAccepted, false);

const directory = await mkdtemp(path.join(os.tmpdir(), "brainvault-backup-repro-"));
let fixedWriterRejected = false;
let fixedError = null;
let sha256GuardRejected = false;
let sha256Error = null;
try {
  const stagedPath = path.join(directory, "attachment.bin");
  await writeFile(stagedPath, changed);
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const writer = new ZipWriter(output);
  try {
    await writer.add({
      name: "attachments/attachment.bin",
      size: BigInt(inspected.length),
      crc32: expectedCrc32,
      sha256: expectedSha256,
      source: { kind: "file", path: stagedPath }
    });
  } catch (error) {
    fixedWriterRejected = true;
    fixedError = error instanceof Error ? error.message : String(error);
  }

  const shaOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const shaWriter = new ZipWriter(shaOutput);
  try {
    await shaWriter.add({
      name: "attachments/collision-resistant.bin",
      size: BigInt(changed.length),
      crc32: changedCrc32,
      sha256: expectedSha256,
      source: { kind: "buffer", data: changed }
    });
  } catch (error) {
    sha256GuardRejected = true;
    sha256Error = error instanceof Error ? error.message : String(error);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

assert.equal(fixedWriterRejected, true);
assert.match(fixedError ?? "", /ZIP source checksum changed while exporting/);
assert.equal(sha256GuardRejected, true);
assert.match(sha256Error ?? "", /ZIP source SHA-256 changed while exporting/);

console.log(JSON.stringify({
  vulnerable: {
    sourceChangedAfterInspection: true,
    sizeStayedEqual: true,
    exportCompletedWithoutContentRecheck: vulnerableWriterAccepted,
    resultingBackupPassesRestoreIntegrityChecks: vulnerableRestoreAccepted,
    unusableBackupFalseSuccessReproduced:
      vulnerableWriterAccepted && !vulnerableRestoreAccepted
  },
  fixed: {
    streamTimeCrc32Verified: true,
    streamTimeSha256Verified: sha256GuardRejected,
    writerRejectedBeforeCentralDirectoryFinalization: fixedWriterRejected,
    crc32Error: fixedError,
    sha256Error,
    unusableBackupFalseSuccessClosed: fixedWriterRejected && sha256GuardRejected
  }
}, null, 2));
