import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyZipEntryToFile, crc32, readZipDirectory, readZipEntryBuffer, ZipWriter } from "../src/lib/zip.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("BrainVault ZIP container", () => {
  it("round-trips manifest and attachment bytes without modification", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "brainvault-zip-"));
    temporaryDirectories.push(directory);
    const zipPath = path.join(directory, "backup.zip");
    const attachmentPath = path.join(directory, "source.bin");
    const restoredPath = path.join(directory, "restored.bin");
    const manifest = Buffer.from('{"format":"brainvault-backup","version":1}\n', "utf8");
    const attachment = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255, 10, 13]);
    await writeFile(attachmentPath, attachment);

    const output = createWriteStream(zipPath);
    const writer = new ZipWriter(output);
    await writer.add({
      name: "brainvault-backup.json",
      size: BigInt(manifest.length),
      crc32: crc32(manifest),
      source: { kind: "buffer", data: manifest }
    });
    await writer.add({
      name: "attachments/blk_test",
      size: BigInt(attachment.length),
      crc32: crc32(attachment),
      source: { kind: "file", path: attachmentPath }
    });
    await writer.finalize();
    output.end();
    await once(output, "close");

    const entries = await readZipDirectory(zipPath);
    expect(entries.map((entry) => entry.name)).toEqual([
      "brainvault-backup.json",
      "attachments/blk_test"
    ]);
    await expect(readZipEntryBuffer(zipPath, entries[0], 1024)).resolves.toEqual(manifest);
    await copyZipEntryToFile(zipPath, entries[1], restoredPath);
    await expect(readFile(restoredPath)).resolves.toEqual(attachment);
  });
});
