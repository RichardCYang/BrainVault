import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { calculateZipArchiveSize, crc32, ZipWriter } from "../src/lib/zip.ts";

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

test("ZIP export calculates the exact regular archive byte length before streaming", async () => {
  const first = Buffer.from("manifest", "utf8");
  const second = Buffer.from("attachment", "utf8");
  const entries = [
    {
      name: "brainvault-backup.json",
      size: BigInt(first.length),
      crc32: crc32(first),
      source: { kind: "buffer", data: first }
    },
    {
      name: "attachments/block_demo",
      size: BigInt(second.length),
      crc32: crc32(second),
      source: { kind: "buffer", data: second }
    }
  ];
  const { output, chunks } = collectingWritable();
  const writer = new ZipWriter(output);
  for (const entry of entries) await writer.add(entry);
  await writer.finalize();

  assert.equal(calculateZipArchiveSize(entries), BigInt(Buffer.concat(chunks).length));
});

test("ZIP export size calculation includes ZIP64 records at the sentinel boundary", () => {
  const name = "large.bin";
  const size = 0xffffffffn;
  const expected = size + BigInt(30 + name.length + 20) + BigInt(46 + name.length + 20) + 56n + 20n + 22n;
  assert.equal(calculateZipArchiveSize([{ name, size }]), expected);
});


test("ZIP export rejects promptly when the destination closes during backpressure", async () => {
  let writeCount = 0;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      writeCount += 1;
      if (writeCount === 1) {
        queueMicrotask(() => output.destroy());
      }
      // Do not complete the first write synchronously. The close event must
      // settle the writer instead of leaving it waiting forever for drain.
      setTimeout(callback, 25);
    }
  });
  const data = Buffer.alloc(1024, 0x41);
  const writer = new ZipWriter(output);

  await assert.rejects(
    writer.add({
      name: "attachments/aborted.bin",
      size: BigInt(data.length),
      crc32: crc32(data),
      source: { kind: "buffer", data }
    }),
    /ZIP output stream closed before the archive finished/
  );
});
