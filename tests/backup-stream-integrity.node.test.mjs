import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { crc32, ZipWriter } from "../src/lib/zip.ts";

function collectingWritable() {
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  return { output, chunks };
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

test("ZIP export rejects a same-size staged-file mutation before finalization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "brainvault-backup-integrity-"));
  try {
    const stagedPath = path.join(directory, "attachment.bin");
    const inspected = Buffer.from("canonical attachment bytes", "utf8");
    const changed = Buffer.from("tampered--attachment bytes", "utf8");
    assert.equal(changed.length, inspected.length);
    await writeFile(stagedPath, inspected);

    const expected = {
      size: BigInt(inspected.length),
      crc32: crc32(inspected),
      sha256: sha256(inspected)
    };
    await writeFile(stagedPath, changed);

    const { output } = collectingWritable();
    const writer = new ZipWriter(output);
    await assert.rejects(
      writer.add({
        name: "attachments/attachment.bin",
        ...expected,
        source: { kind: "file", path: stagedPath }
      }),
      /ZIP source checksum changed while exporting/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ZIP export accepts and finalizes bytes matching the inspected CRC32 and SHA-256", async () => {
  const data = Buffer.from("stable attachment bytes", "utf8");
  const { output, chunks } = collectingWritable();
  const writer = new ZipWriter(output);
  await writer.add({
    name: "attachments/stable.bin",
    size: BigInt(data.length),
    crc32: crc32(data),
    sha256: sha256(data),
    source: { kind: "buffer", data }
  });
  await writer.finalize();

  const archive = Buffer.concat(chunks);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
});

test("ZIP export rejects a SHA-256 mismatch even when the CRC32 matches the streamed bytes", async () => {
  const inspected = Buffer.from("original payload", "utf8");
  const changed = Buffer.from("modified payload", "utf8");
  assert.equal(changed.length, inspected.length);
  const { output } = collectingWritable();
  const writer = new ZipWriter(output);
  await assert.rejects(
    writer.add({
      name: "attachments/collision-resistant.bin",
      size: BigInt(changed.length),
      crc32: crc32(changed),
      sha256: sha256(inspected),
      source: { kind: "buffer", data: changed }
    }),
    /ZIP source SHA-256 changed while exporting/
  );
});

test("ZIP export validates caller-provided buffer CRC32 instead of trusting it", async () => {
  const data = Buffer.from("manifest", "utf8");
  const { output } = collectingWritable();
  const writer = new ZipWriter(output);
  await assert.rejects(
    writer.add({
      name: "brainvault.json",
      size: BigInt(data.length),
      crc32: (crc32(data) + 1) >>> 0,
      source: { kind: "buffer", data }
    }),
    /ZIP source checksum changed while exporting/
  );
});
